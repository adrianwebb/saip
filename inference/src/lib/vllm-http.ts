/**
 * HttpVllmBackend — the real vLLM client behind the `VllmBackend` seam.
 *
 * Talks to any OpenAI-compatible engine. Per-user adapters are addressed through the
 * standard `model` field, because vLLM exposes each loaded LoRA adapter as a model name —
 * which keeps the engine a plain OpenAI server and the gateway free of vLLM-specific
 * request plumbing.
 *
 * Failure taxonomy is the point of this file. An engine on a laptop GPU fails in ways the
 * caller must distinguish: still loading, OOM, wedged, or genuinely answering "no". They map
 * to 503 / 502 / 504 so an operator knows whether to restart the container or file a bug.
 * Errors are typed as `VllmBackendError` and the routes translate `kind` to a status.
 *
 * Nothing here retries an HTTP error status. Resending a generation request can duplicate a
 * recorded session and burn a minute of a small GPU's time; a socket-level failure before
 * any response is safe to retry and is.
 */

import type {
  VllmBackend,
  VllmChatRequest,
  VllmChatResponse,
  VllmStreamChunk,
} from './backends.js'

export type VllmErrorKind = 'backend_error' | 'backend_timeout' | 'backend_unavailable'

/** An engine failure, already classified. `status` is the ENGINE's status, not ours. */
export class VllmBackendError extends Error {
  readonly kind: VllmErrorKind
  /** Status returned by the engine, when it returned one at all. */
  readonly status?: number

  constructor(message: string, init: { kind: VllmErrorKind; status?: number }) {
    super(message)
    this.name = 'VllmBackendError'
    this.kind = init.kind
    this.status = init.status
  }
}

export interface HttpVllmBackendOptions {
  /** OpenAI base URL including the version path, e.g. `http://vllm:8000/v1`. */
  baseUrl: string
  apiKey?: string
  /**
   * Ceiling for a non-streaming request, and the INACTIVITY ceiling for a stream (time
   * between chunks). A stream that keeps producing tokens is not stalled, so it is not cut
   * off at this bound however long generation runs.
   */
  timeoutMs?: number
  /** Retries for socket-level failures only. HTTP error statuses are never retried. */
  retries?: number
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_RETRIES = 1

/** Normalize to a base ending in `/v1` with no trailing slash. */
function normalizeBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('SAIP_VLLM_BASE_URL is empty')
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

/** Extract the engine's own error message from an OpenAI-shaped error body. */
function engineMessage(text: string, fallback: string): string {
  try {
    const parsed = JSON.parse(text)
    const m = parsed?.error?.message ?? parsed?.message
    if (typeof m === 'string' && m.trim()) return m.trim()
  } catch {
    /* not JSON — fall through */
  }
  const snippet = text.trim().slice(0, 200)
  return snippet ? `${fallback}: ${snippet}` : fallback
}

export class HttpVllmBackend implements VllmBackend {
  private readonly base: string
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly fetchImpl: typeof fetch
  private readonly apiKey?: string
  private readonly closedControllers = new Set<AbortController>()
  private closed = false

  constructor(opts: HttpVllmBackendOptions) {
    this.base = normalizeBase(opts.baseUrl)
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES)
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.apiKey = opts.apiKey
  }

  /** Abort any in-flight request. Idempotent. */
  async close(): Promise<void> {
    this.closed = true
    for (const c of this.closedControllers) c.abort()
    this.closedControllers.clear()
  }

  async chat(req: VllmChatRequest): Promise<VllmChatResponse> {
    const res = await this.open({ ...req, stream: false }, 'chat completion')
    let text: string
    try {
      text = await res.text()
    } catch (err) {
      throw new VllmBackendError(`failed reading engine response: ${(err as Error).message}`, { kind: 'backend_unavailable' })
    }
    if (!res.ok) {
      throw new VllmBackendError(engineMessage(text, `engine returned HTTP ${res.status}`), { kind: 'backend_error', status: res.status })
    }
    let parsed: VllmChatResponse
    try {
      parsed = JSON.parse(text) as VllmChatResponse
    } catch {
      throw new VllmBackendError(
        `expected JSON from ${this.base}/chat/completions but got a malformed body (content-type: ${res.headers.get('content-type') ?? 'unknown'})`,
        { kind: 'backend_error', status: res.status },
      )
    }
    if (!parsed?.choices?.length) {
      throw new VllmBackendError('engine returned no choices', { kind: 'backend_error', status: res.status })
    }
    return {
      id: parsed.id ?? `chatcmpl-${Date.now()}`,
      created: parsed.created ?? Math.floor(Date.now() / 1000),
      model: parsed.model ?? req.model,
      choices: parsed.choices.map((ch, i) => ({
        index: ch?.index ?? i,
        message: { role: ch?.message?.role ?? 'assistant', content: ch?.message?.content ?? '' },
        finish_reason: ch?.finish_reason ?? 'stop',
      })),
      usage: parsed.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }
  }

  /**
   * Stream the engine's SSE frames as parsed chunk objects. The `[DONE]` sentinel ends the
   * iteration and is never yielded; `api-chat` emits it when the iterator completes.
   */
  async *stream(req: VllmChatRequest): AsyncIterable<VllmStreamChunk> {
    const res = await this.open({ ...req, stream: true }, 'streaming chat completion')
    if (!res.ok) {
      let text = ''
      try { text = await res.text() } catch { /* status is enough */ }
      throw new VllmBackendError(engineMessage(text, `engine returned HTTP ${res.status}`), { kind: 'backend_error', status: res.status })
    }
    if (!res.body) {
      throw new VllmBackendError('engine returned an empty stream body', { kind: 'backend_error', status: res.status })
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // Streams are governed by an inactivity deadline, re-armed on every chunk: a long
    // generation is healthy, a wedged engine is not, and only the second should die.
    let timer: ReturnType<typeof setTimeout> | undefined
    let stalled = false
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { stalled = true; void reader.cancel().catch(() => undefined) }, this.timeoutMs)
    }
    arm()

    try {
      for (;;) {
        let done = false
        let value: Uint8Array | undefined
        try {
          const next = await reader.read()
          done = next.done
          value = next.value
        } catch (err) {
          if (stalled) throw new VllmBackendError(`engine stream idle past ${this.timeoutMs}ms`, { kind: 'backend_timeout' })
          throw new VllmBackendError(`engine stream failed: ${(err as Error).message}`, { kind: 'backend_unavailable' })
        }
        // Cancel resolves a pending read as {done:true} rather than rejecting, so a stalled
        // stream must be detected on the done branch too — otherwise the caller sees a clean
        // early end and a truncated generation looks like a finished one.
        if (done) {
          if (stalled) {
            throw new VllmBackendError(`engine stream idle past ${this.timeoutMs}ms`, { kind: 'backend_timeout' })
          }
          break
        }
        arm()
        if (!value) continue

        buffer += decoder.decode(value, { stream: true })
        // SSE frames are blank-line separated; tolerate CRLF.
        let sep: number
        while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '')
          const dataLine = frame.split(/\r?\n/).find((l) => l.startsWith('data:'))
          if (!dataLine) continue // comment/keepalive frame
          const payload = dataLine.slice(5).trim()
          if (payload === '[DONE]') return
          if (!payload) continue
          let chunk: VllmStreamChunk
          try {
            chunk = JSON.parse(payload) as VllmStreamChunk
          } catch {
            throw new VllmBackendError(`engine emitted a non-JSON SSE frame: ${payload.slice(0, 120)}`, { kind: 'backend_error' })
          }
          yield chunk
        }
      }
      // A stream that ends without [DONE] still flushed a trailing frame with no separator.
      const tail = buffer.trim()
      if (tail.startsWith('data:') && tail.slice(5).trim() !== '[DONE]') {
        try { yield JSON.parse(tail.slice(5).trim()) as VllmStreamChunk } catch { /* ignore partial tail */ }
      }
    } finally {
      if (timer) clearTimeout(timer)
      void reader.cancel().catch(() => undefined)
    }
  }

  /** Issue the POST, retrying only socket-level failures, mapping timeout/unavailability. */
  private async open(payload: VllmChatRequest & { stream: boolean }, label: string): Promise<Response> {
    if (this.closed) throw new VllmBackendError('backend has been closed', { kind: 'backend_unavailable' })
    const controller = new AbortController()
    this.closedControllers.add(controller)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: payload.stream ? 'text/event-stream' : 'application/json',
    }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    let lastErr: unknown
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await this.fetchImpl(`${this.base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timer)
        this.closedControllers.delete(controller)
        return res
      } catch (err) {
        clearTimeout(timer)
        lastErr = err
        // A stream already handed to the caller must not be re-issued.
        if (controller.signal.aborted) {
          this.closedControllers.delete(controller)
          throw new VllmBackendError(
            this.closed ? `backend closed during ${label}` : `engine did not answer within ${this.timeoutMs}ms`,
            { kind: this.closed ? 'backend_unavailable' : 'backend_timeout' },
          )
        }
        if (attempt < this.retries) continue
      }
    }
    this.closedControllers.delete(controller)
    throw new VllmBackendError(
      `cannot reach the inference engine at ${this.base}: ${(lastErr as Error)?.message ?? 'connection failed'}`,
      { kind: 'backend_unavailable' },
    )
  }
}
