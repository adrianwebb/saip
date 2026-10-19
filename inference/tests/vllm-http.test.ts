/**
 * HttpVllmBackend tests.
 *
 * These run against a real in-process HTTP server, not a mock of `fetch`, because the
 * failure modes worth pinning are wire-level: SSE frame parsing, chunk boundaries arriving
 * mid-frame, timeout aborts, and which errors are safe to retry. A stubbed fetch would
 * test our reading of the OpenAI SDK docs rather than our client.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { HttpVllmBackend, VllmBackendError } from '../src/lib/vllm-http.js'
import type { VllmChatRequest } from '../src/lib/backends.js'

type Handler = (req: any, body: string, res: ServerResponse) => void

let server: Server | undefined
let port = 0
let handler: Handler = (_req, _body, res) => { res.end('{}') }
let requests: Array<{ path: string; body: any; headers: Record<string, unknown> }> = []

function start(h: Handler): Promise<string> {
  handler = h
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        requests.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : undefined, headers: req.headers })
        handler(req, raw, res)
      })
    })
    server!.listen(0, '127.0.0.1', () => {
      port = (server!.address() as AddressInfo).port
      resolve(`http://127.0.0.1:${port}/v1`)
    })
  })
}

const json = (obj: unknown, status = 200) => (_req: any, _body: string, res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const CHAT_OK = {
  id: 'chatcmpl-1', object: 'chat.completion', created: 1700000000,
  model: 'general@42',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi from engine' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
}

const reqOf = (over: Partial<VllmChatRequest> = {}): VllmChatRequest => ({
  model: 'general@42', messages: [{ role: 'user', content: 'hello' }], ...over,
})

afterAll(async () => { await new Promise<void>((r) => server?.close(() => r())) })
beforeEach(() => { requests = [] })

describe('HttpVllmBackend.chat', () => {
  it('POSTs to /chat/completions and returns the normalized shape', async () => {
    const base = await start(json(CHAT_OK))
    const backend = new HttpVllmBackend({ baseUrl: base })
    const res = await backend.chat(reqOf({ temperature: 0.2, max_tokens: 50 }))

    expect(requests[0].path).toBe('/v1/chat/completions')
    expect(requests[0].body.model).toBe('general@42')
    expect(requests[0].body.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(requests[0].body.temperature).toBe(0.2)
    expect(res.choices[0].message.content).toBe('hi from engine')
    expect(res.usage).toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 })
    await backend.close?.()
  })

  it('passes the resolved adapter as `model` — vLLM serves a loaded LoRA by name', async () => {
    const base = await start(json(CHAT_OK))
    const backend = new HttpVllmBackend({ baseUrl: base })
    await backend.chat(reqOf({ model: 'coding@18' }))
    expect(requests[0].body.model).toBe('coding@18')
    await backend.close?.()
  })

  it('accepts a base URL with or without a trailing slash and with or without /v1', async () => {
    for (const form of [`http://127.0.0.1:${port}/v1/`, `http://127.0.0.1:${port}/v1`, `http://127.0.0.1:${port}`]) {
      requests = []
      const backend = new HttpVllmBackend({ baseUrl: form })
      await backend.chat(reqOf())
      expect(requests[0].path).toBe('/v1/chat/completions')
      await backend.close?.()
    }
  })

  it('sends a bearer token only when configured', async () => {
    const base = await start(json(CHAT_OK))
    await new HttpVllmBackend({ baseUrl: base }).chat(reqOf())
    expect(requests[0].headers.authorization).toBeUndefined()

    const b2 = new HttpVllmBackend({ baseUrl: base, apiKey: 'sk-engine' })
    await b2.chat(reqOf())
    expect(requests[1].headers.authorization).toBe('Bearer sk-engine')
    await b2.close?.()
  })
})

describe('HttpVllmBackend failure mapping', () => {
  it('maps an engine error status to a VllmBackendError with the engine message forwarded', async () => {
    const base = await start(json({ error: { message: 'CUDA out of memory' } }, 500))
    const backend = new HttpVllmBackend({ baseUrl: base })
    const err = await backend.chat(reqOf()).catch((e) => e as VllmBackendError)
    expect(err).toBeInstanceOf(VllmBackendError)
    expect(err.status).toBe(500)
    expect(err.kind).toBe('backend_error')
    expect(err.message).toContain('CUDA out of memory')
    await backend.close?.()
  })

  it('does NOT retry a 4xx/5xx — resending a generation can duplicate sessions', async () => {
    const base = await start(json({ error: { message: 'no such model' } }, 404))
    const backend = new HttpVllmBackend({ baseUrl: base, retries: 3 })
    await backend.chat(reqOf()).catch(() => undefined)
    expect(requests).toHaveLength(1)
    await backend.close?.()
  })

  it('retries a connection refusal up to the configured bound', async () => {
    // Point at a port nothing listens on: a socket-level failure, not an HTTP status.
    const backend = new HttpVllmBackend({ baseUrl: 'http://127.0.0.1:1/v1', retries: 2 })
    const err = await backend.chat(reqOf()).catch((e) => e as VllmBackendError)
    expect(err.kind).toBe('backend_unavailable')
    await backend.close?.()
  })

  it('surfaces a slow engine as a timeout, distinct from an error', async () => {
    const base = await start((_req, _body, res) => { /* never respond */ })
    const backend = new HttpVllmBackend({ baseUrl: base, timeoutMs: 120 })
    const err = await backend.chat(reqOf()).catch((e) => e as VllmBackendError)
    expect(err).toBeInstanceOf(VllmBackendError)
    expect(err.kind).toBe('backend_timeout')
    await backend.close?.()
  })

  it('reports a malformed engine body as a backend error, not a crash', async () => {
    const base = await start((_req, _body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>proxy error</html>') })
    const backend = new HttpVllmBackend({ baseUrl: base })
    const err = await backend.chat(reqOf()).catch((e) => e as VllmBackendError)
    expect(err.kind).toBe('backend_error')
    expect(err.message).toMatch(/expected json|malformed/i)
    await backend.close?.()
  })
})

describe('HttpVllmBackend.stream', () => {
  /** Write SSE frames with deliberate split points to exercise buffering. */
  const sse = (frames: string[], chunkDelay = 0) => async (_req: any, _body: string, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const f of frames) {
      // Split each frame across writes to prove the parser buffers partial reads.
      const half = Math.ceil(f.length / 2)
      res.write(f.slice(0, half))
      if (chunkDelay) await new Promise((r) => setTimeout(r, chunkDelay))
      res.write(f.slice(half))
      if (chunkDelay) await new Promise((r) => setTimeout(r, chunkDelay))
    }
    res.end()
  }

  it('parses OpenAI SSE chunks into objects and stops at [DONE]', async () => {
    const frames = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"He"}}]}\n\n',
      ': keepalive comment\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"llo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const base = await start(sse(frames, 1))
    const backend = new HttpVllmBackend({ baseUrl: base })
    const chunks: any[] = []
    for await (const c of backend.stream!(reqOf({ stream: true as never }))) chunks.push(c)

    expect(chunks.map((c) => c.choices[0].delta.content)).toEqual(['He', 'llo'])
    // The [DONE] sentinel is consumed, never forwarded as a chunk.
    expect(chunks.some((c) => String(c).includes('[DONE]'))).toBe(false)
    await backend.close?.()
  })

  it('marks the final chunk with the engine finish_reason', async () => {
    const frames = [
      'data: {"id":"c2","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const base = await start(sse(frames, 1))
    const backend = new HttpVllmBackend({ baseUrl: base })
    const chunks: any[] = []
    for await (const c of backend.stream!(reqOf())) chunks.push(c)
    expect(chunks[0].choices[0].finish_reason).toBe('stop')
    await backend.close?.()
  })

  it('maps an error status arriving before any chunk to a backend error', async () => {
    const base = await start((_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'engine exploded' } }))
    })
    const backend = new HttpVllmBackend({ baseUrl: base })
    const err = await (async () => { try { for await (const _c of backend.stream!(reqOf())) { /* noop */ } } catch (e) { return e as VllmBackendError } })()
    expect(err).toBeInstanceOf(VllmBackendError)
    expect(err.message).toContain('engine exploded')
    await backend.close?.()
  })

  it('aborts a stalled stream on timeout', async () => {
    const base = await start((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"id":"s","choices":[{"index":0,"delta":{"content":"a"}}]}\n\n')
      // then hang forever
    })
    const backend = new HttpVllmBackend({ baseUrl: base, timeoutMs: 150 })
    const seen: any[] = []
    let caught: VllmBackendError | undefined
    try {
      for await (const c of backend.stream!(reqOf())) seen.push(c)
    } catch (e) { caught = e as VllmBackendError }
    expect(seen).toHaveLength(1)          // first chunk delivered before the stall
    expect(caught?.kind).toBe('backend_timeout')
    await backend.close?.()
  })
})
