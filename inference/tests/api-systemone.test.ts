import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import type { VllmBackend, VllmChatRequest, VllmChatResponse } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

class FakeVllm implements VllmBackend {
  async chat(req: VllmChatRequest): Promise<VllmChatResponse> {
    return { id: 'sys-fake', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: '{"person":"John","organization":"Acme Corp"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
}

async function boot(enabled: boolean) {
  const cfg = (await import('../src/lib/config.js')).loadConfig(repoConfig)
  cfg.inference.systemone.enabled = enabled
  const ctx = (await createApp({ config: cfg, vllm: new FakeVllm(), latestVersion: (n) => ({ general: 42, coding: 18, 'default-agent': 3 }[n]) })) as any
  return ctx
}

describe('POST /v1/systemone/completions', () => {
  it('returns structured output when enabled', async () => {
    const ctx = await boot(true)
    const res = await ctx.apiSystemOne.app.request('/v1/systemone/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'extract' }], schema: { type: 'object' } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.object).toBe('systemone.completion')
    expect(body.valid).toBe(true)
    expect(body.output).toEqual({ person: 'John', organization: 'Acme Corp' })
  })

  it('is not registered when disabled (404)', async () => {
    const ctx = await boot(false)
    // apiSystemOne app has no route mounted → falls through to 404
    const res = await ctx.apiSystemOne.app.request('/v1/systemone/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], schema: {} }),
    })
    expect(res.status).toBe(404)
  })
})
