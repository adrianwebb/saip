import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import type { SaipRuntimeConfig } from '../src/lib/config.js'
import type { VllmBackend, VllmChatRequest, VllmChatResponse } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

class FakeVllm implements VllmBackend {
  async chat(req: VllmChatRequest): Promise<VllmChatResponse> {
    return { id: 'x', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
}

async function bootWith(security: SaipRuntimeConfig['security']) {
  const base = (await import('../src/lib/config.js')).loadConfig(repoConfig)
  const cfg: SaipRuntimeConfig = { ...base, security }
  const ctx = (await createApp({ config: cfg, vllm: new FakeVllm(), latestVersion: () => 42 })) as any
  return ctx.server.app
}

describe('inference auth enforcement (fail-closed)', () => {
  it('rejects unauthenticated chat with 401 when tokens configured & not dev', async () => {
    const app = await bootWith({ dev_mode: false, api_tokens: [{ caller: 'alice', token_secret: 'SAIP_TOKEN_ALICE' }] })
    const res = await app.request('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(401)
  })

  it('accepts a valid bearer and maps to the right caller', async () => {
    process.env.SAIP_TOKEN_ALICE = 'tok-alice-xyz'
    const app = await bootWith({ dev_mode: false, api_tokens: [{ caller: 'alice', token_secret: 'SAIP_TOKEN_ALICE' }] })
    const res = await app.request('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-alice-xyz' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    delete process.env.SAIP_TOKEN_ALICE
  })

  it('dev_mode:true authenticates anonymous requests as dev', async () => {
    const app = await bootWith({ dev_mode: true, api_tokens: [] })
    const res = await app.request('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
  })

  it('health stays public (no auth required for liveness)', async () => {
    const app = await bootWith({ dev_mode: false, api_tokens: [{ caller: 'a', token_secret: 'X' }] })
    expect((await app.request('/health')).status).toBe(200)
  })
})
