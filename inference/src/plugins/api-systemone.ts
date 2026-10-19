/**
 * api-systemone — structured-output endpoint over the VllmBackend, mounted only
 * when inference.systemone.enabled. Returns a systemone.completion with parsed
 * JSON `output` and a `valid` flag (schema conformance is best-effort here: we
 * parse the model's JSON; full grammar-constrained decoding is a vLLM concern).
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { AdapterDefinition, UserEntry } from '@saip/shared'
import type { Message } from '../lib/config.js'
import type { VllmBackend } from '../lib/backends.js'
import { resolveAdapterForCaller } from '../lib/user-resolver.js'
import { serveVersionFor } from '../lib/serve-resolver.js'

export interface ApiSystemOneConfig {
  enabled: boolean
  users: UserEntry[]
  adapters: AdapterDefinition[]
  vllm?: VllmBackend
  latestVersion: (name: string) => number | undefined
  authMiddleware?: MiddlewareHandler<any>
}

declare module 'cordis' {
  interface Context {
    apiSystemOne?: ApiSystemOneService
  }
}

export class ApiSystemOneService extends Service {
  static readonly provide = 'apiSystemOne'
  readonly app = new Hono()

  constructor(ctx: any, private cfg: ApiSystemOneConfig) {
    super(ctx, 'apiSystemOne')
    if (!cfg.enabled) return // route intentionally absent → 404
    if (cfg.authMiddleware) (this.app as any).use('/v1/systemone/completions', cfg.authMiddleware)
    this.app.post('/v1/systemone/completions', async (c) => {
      if (!this.cfg.vllm) return c.json({ error: { message: 'no backend', code: 'backend_unavailable' } }, 503)
      let body: any
      try { body = await c.req.json() } catch { return c.json({ error: { message: 'invalid JSON', code: 'invalid_request' } }, 400) }
      if (!Array.isArray(body.messages) || !body.schema && !body.grammar) {
        return c.json({ error: { message: 'messages and schema|grammar required', code: 'invalid_request' } }, 400)
      }
      const principal = (c as any).get?.('principal') as { callerId?: string } | undefined
      const caller = principal?.callerId ?? ((c.req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim() || undefined)
      let serveId: string
      try {
        const ref = body.model ?? resolveAdapterForCaller(this.cfg.users, caller).adapterRef
        if (!ref) return c.json({ error: { message: 'no adapter resolved', code: 'unresolvable' } }, 400)
        serveId = serveVersionFor(ref, this.cfg.adapters, this.cfg.latestVersion)
      } catch (e: any) {
        return c.json({ error: { message: e.message, code: 'resolution_failed' } }, 404)
      }
      const resp = await this.cfg.vllm.chat({ model: serveId, messages: body.messages as Message[], temperature: 0 })
      const raw = resp.choices[0]?.message.content ?? ''
      let output: unknown = null
      let valid = false
      try { output = JSON.parse(raw); valid = true } catch { /* invalid json */ }
      return c.json({ id: resp.id, object: 'systemone.completion', created: resp.created, model: serveId, output, valid }, 200)
    })
  }
}
