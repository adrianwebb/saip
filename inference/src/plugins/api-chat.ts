/**
 * api-chat — OpenAI-compatible POST /v1/chat/completions over the injected
 * VllmBackend. Resolves the caller's adapter to a concrete served version and
 * forwards it as vLLM's model selector; emits chat/request for the session
 * collector. Non-stream returns the documented JSON envelope; stream:true yields
 * SSE chat.completion.chunk lines ending with [DONE].
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { AdapterDefinition, UserEntry } from '@saip/shared'
import type { Message } from '../lib/config.js'
import type { VllmBackend } from '../lib/backends.js'
import { resolveAdapterForCaller } from '../lib/user-resolver.js'
import { serveVersionFor } from '../lib/serve-resolver.js'

export interface ApiChatConfig {
  users: UserEntry[]
  adapters: AdapterDefinition[]
  vllm?: VllmBackend
  /** Latest promoted version per adapter name (from R2 index in prod). */
  latestVersion: (name: string) => number | undefined
  /** Optional auth middleware applied to the chat route (fail-closed enforcement). */
  authMiddleware?: MiddlewareHandler<any>
}

interface ChatBody {
  model?: string
  messages: Message[]
  temperature?: number
  max_tokens?: number
  top_p?: number
  stop?: string | string[]
  stream?: boolean
}

const pad = (n: number) => String(n).padStart(6, '0')

declare module 'cordis' {
  interface Context {
    apiChat?: ApiChatService
  }
}

export class ApiChatService extends Service {
  static readonly provide = 'apiChat'
  readonly app = new Hono()

  constructor(ctx: any, private cfg: ApiChatConfig) {
    super(ctx, 'apiChat')
    const mw = this.app as any
    if (cfg.authMiddleware) mw.use('/v1/chat/completions', cfg.authMiddleware)
    this.app.post('/v1/chat/completions', (c) => this.handle(c))
  }

  private callerId(header?: string): string | undefined {
    if (!header) return undefined
    const m = header.match(/^Bearer\s+(.+)$/i)
    return m ? m[1].trim() : undefined
  }

  private async handle(c: any) {
    let body: ChatBody
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { message: 'invalid JSON body', code: 'invalid_request' } }, 400)
    }
    return this.respond(c, body)
  }

  private async respond(c: any, body: ChatBody) {
    if (!this.cfg.vllm) return c.json({ error: { message: 'no vLLM backend configured', code: 'backend_unavailable' } }, 503)
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ error: { message: 'messages is required', code: 'invalid_request' } }, 400)
    }

    // Prefer the authenticated principal (set by auth middleware); fall back to
    // the raw bearer only when no auth provider is attached.
    const principal = c.get?.('principal') as { callerId?: string } | undefined
    const caller = principal?.callerId ?? this.callerId(c.req.header('authorization'))
    let serveId: string
    try {
      if (body.model) {
        serveId = serveVersionFor(body.model, this.cfg.adapters, this.cfg.latestVersion)
      } else {
        const { adapterRef } = resolveAdapterForCaller(this.cfg.users, caller)
        if (!adapterRef) return c.json({ error: { message: 'no adapter resolved for caller', code: 'unresolvable' } }, 400)
        serveId = serveVersionFor(adapterRef, this.cfg.adapters, this.cfg.latestVersion)
      }
    } catch (err: any) {
      return c.json({ error: { message: err.message, code: 'resolution_failed' } }, 404)
    }

    // Session collection hook point.
    this.ctx.emit('chat/request', { caller: caller ?? null, adapter: serveId, messages: body.messages })

    const req = {
      model: serveId,
      messages: body.messages,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
      stop: body.stop,
    }

    if (body.stream && this.cfg.vllm.stream) {
      c.header('Content-Type', 'text/event-stream')
      c.header('Cache-Control', 'no-cache')
      const encoder = new TextEncoder()
      const iterator = this.cfg.vllm.stream(req)[Symbol.asyncIterator]()
      return c.body(new ReadableStream({
        async pull(controller) {
          const next = await iterator.next()
          if (next.done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); return }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`))
        },
      }))
    }

    const resp = await this.cfg.vllm.chat(req)
    if (body.stream) {
      // Backend without streaming: synthesize one chunk + [DONE].
      c.header('Content-Type', 'text/event-stream'); c.header('Cache-Control', 'no-cache')
      const chunk = { id: resp.id, object: 'chat.completion.chunk', created: resp.created, model: resp.model, choices: [{ index: 0, delta: { role: 'assistant', content: resp.choices[0]?.message.content ?? '' }, finish_reason: 'stop' }] }
      return c.body(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
    }
    // Wrap the backend result in the OpenAI chat.completion envelope.
    return c.json({
      id: resp.id,
      object: 'chat.completion',
      created: resp.created,
      model: resp.model,
      choices: resp.choices.map((ch) => ({ index: ch.index, message: ch.message, finish_reason: ch.finish_reason })),
      usage: resp.usage,
    }, 200)
  }
}
