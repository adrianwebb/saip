import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import type { VllmBackend, VllmChatRequest, VllmChatResponse } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

class FakeVllm implements VllmBackend {
  public last?: VllmChatRequest
  async chat(req: VllmChatRequest): Promise<VllmChatResponse> {
    this.last = req
    return {
      id: 'chatcmpl-fake',
      created: 1705312200,
      model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 128, total_tokens: 170 },
    }
  }
}

async function boot(vllm: VllmBackend) {
  // These tests exercise chat behavior, not auth → run under explicit dev mode.
  const base = (await import('../src/lib/config.js')).loadConfig(repoConfig)
  const ctx = (await createApp({
    config: { ...base, security: { dev_mode: true, api_tokens: [] } },
    vllm,
    latestVersion: (n) => ({ general: 42, coding: 18, 'default-agent': 3 }[n]),
  })) as any
  return ctx.apiChat.app
}

describe('POST /v1/chat/completions', () => {
  it('returns an OpenAI envelope with the resolved concrete adapter as model', async () => {
    const vllm = new FakeVllm()
    const app = await boot(vllm)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer whoever' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0].message.content).toBe('hello there')
    expect(body.usage.total_tokens).toBe(170)
    // default user → default-agent composite; served id is the compiled artifact version
    expect(body.model).toMatch(/^default-agent@/)
    expect(vllm.last?.model).toMatch(/^default-agent@/)
  })

  it('resolves to the default user when no Authorization header is present (never 401)', async () => {
    const app = await boot(new FakeVllm())
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.model).toMatch(/@/)
  })

  it('honors an explicit model override in the request body', async () => {
    const vllm = new FakeVllm()
    const app = await boot(vllm)
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coding@latest', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(vllm.last?.model).toBe('coding@000018')
  })

  it('streams SSE chunks ending with [DONE]', async () => {
    const app = await boot(new FakeVllm())
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('data:')
    expect(text).toContain('[DONE]')
  })
})
