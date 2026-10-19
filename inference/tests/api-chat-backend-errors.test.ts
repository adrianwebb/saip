/**
 * Route-level behavior when the engine fails.
 *
 * The engine is an external process on a laptop GPU: it OOMs, it is still loading, it times
 * out on long prefills. Those must be distinguishable from a gateway bug by status code alone.
 */
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import { VllmBackendError } from '../src/lib/vllm-http.js'
import type { VllmBackend, VllmChatRequest, VllmChatResponse } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))
const base = (await import('../src/lib/config.js')).loadConfig(repoConfig)

class ErrBackend implements VllmBackend {
  constructor(private readonly err: VllmBackendError) {}
  async chat(): Promise<VllmChatResponse> { throw this.err }
}

async function boot(vllm: VllmBackend) {
  const ctx = (await createApp({
    config: { ...base, security: { dev_mode: true, api_tokens: [] } },
    vllm,
    latestVersion: (n) => ({ general: 42, coding: 18, 'default-agent': 3 }[n]),
  })) as any
  return ctx.apiChat.app
}

const post = (app: any) => app.request('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'general', messages: [{ role: 'user', content: 'hi' }] }),
})

describe('engine failure surfaces as a typed HTTP error', () => {
  it('502 backend_error when the engine answers with an error status', async () => {
    const app = await boot(new ErrBackend(new VllmBackendError('CUDA out of memory', { kind: 'backend_error', status: 500 })))
    const res = await post(app)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.code).toBe('backend_error')
    expect(body.error.message).toContain('CUDA out of memory')
  })

  it('504 backend_timeout when the engine does not answer in time', async () => {
    const app = await boot(new ErrBackend(new VllmBackendError('engine did not respond within 180000ms', { kind: 'backend_timeout' })))
    const res = await post(app)
    expect(res.status).toBe(504)
    expect((await res.json()).error.code).toBe('backend_timeout')
  })

  it('503 backend_unavailable when the engine is unreachable at all', async () => {
    const app = await boot(new ErrBackend(new VllmBackendError('connection refused', { kind: 'backend_unavailable' })))
    const res = await post(app)
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('backend_unavailable')
  })

  it('500 for an unexpected failure that is not a mapped backend error', async () => {
    class Boom implements VllmBackend { async chat(): Promise<VllmChatResponse> { throw new TypeError('bug in our code') } }
    const res = await post(await boot(new Boom()))
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('internal_error')
  })

  it('a streaming request that fails before the first frame gets the same status, not a broken 200', async () => {
    const app = await boot(new ErrBackend(new VllmBackendError('engine exploded', { kind: 'backend_error', status: 500 })))
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, model: 'general', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(502)
  })
})

describe('gateway with no engine attached', () => {
  it('boots and answers 503 rather than guessing an endpoint', async () => {
    const ctx = (await createApp({
      config: { ...base, security: { dev_mode: true, api_tokens: [] } },
      latestVersion: (n) => ({ general: 42, coding: 18, 'default-agent': 3 }[n]),
    })) as any
    const res = await ctx.apiChat.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('backend_unavailable')
    // Health still reports, so an orchestrator can tell "up but no engine" from "down".
    const health = await ctx.apiCore.app.request('/health')
    expect(health.status).toBe(200)
  })
})
