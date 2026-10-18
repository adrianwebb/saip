import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import { MemoryStorage } from '../src/lib/backends.js'
import type { VllmBackend, VllmChatRequest, VllmChatResponse } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

class FakeVllm implements VllmBackend {
  async chat(req: VllmChatRequest): Promise<VllmChatResponse> {
    return { id: 'chatcmpl-e2e', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  }
}

describe('full inference server (composed)', () => {
  it('serves health, models, chat (collecting a session), document upload, and feedback in one boot', async () => {
    const storage = new MemoryStorage()
    const ctx = (await createApp({ configPath: repoConfig, storage, vllm: new FakeVllm(), latestVersion: (n) => ({ general: 42, coding: 18, 'default-agent': 3 }[n]) })) as any
    const app = ctx.server.app

    // /health
    expect((await app.request('/health')).status).toBe(200)
    // /v1/models
    const models = await (await app.request('/v1/models')).json()
    expect(models.data.length).toBeGreaterThanOrEqual(3)

    // chat completion → triggers session collection via event bus
    const chat = await app.request('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer alice' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(chat.status).toBe(200)
    expect((await chat.json()).object).toBe('chat.completion')
    await ctx.sessionCollector.flush()
    expect((await storage.list('sessions/')).length).toBeGreaterThan(0)

    // document upload
    const doc = await app.request('/v1/data/documents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'a.md', source_type: 'document', content: '# A\nbody text' }),
    })
    expect(doc.status).toBe(201)
    const docBody = await doc.json()
    // appears in the documents list on the SAME composed server
    const docsList = await (await app.request('/v1/data/documents')).json()
    expect(docsList.entries.map((e: any) => e.id)).toContain(docBody.id)

    // feedback with reward bound enforced
    const okFb = await app.request('/v1/data/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', reward: 2 }),
    })
    expect(okFb.status).toBe(201)
    const badFb = await app.request('/v1/data/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', reward: 9 }),
    })
    expect(badFb.status).toBe(422)
  })
})
