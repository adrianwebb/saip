import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import { MemoryStorage } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

async function boot() {
  const storage = new MemoryStorage()
  const ctx = (await createApp({ configPath: repoConfig, storage })) as any
  return { app: ctx.dataSessions.app, storage }
}

describe('Data API sessions', () => {
  it('POST stores a session conversation + manifest; GET lists and fetches by id', async () => {
    const { app, storage } = await boot()
    const res = await app.request('/v1/data/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caller: 'alice', adapter_id: 'coding@000018', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] }),
    })
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created.id).toMatch(/^sess-/)
    expect(created.message_count).toBe(2)

    const list = await (await app.request('/v1/data/sessions')).json()
    expect(list.entries.map((e: any) => e.id)).toContain(created.id)

    const one = await app.request(`/v1/data/sessions/${created.id}`)
    expect(one.status).toBe(200)
    expect((await one.json()).caller).toBe('alice')
    expect(await storage.get(`sessions/${created.id}/conversation.jsonl`)).toBeTruthy()
  })
})
