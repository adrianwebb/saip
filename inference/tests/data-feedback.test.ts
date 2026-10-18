import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import { MemoryStorage } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

async function boot() {
  const storage = new MemoryStorage()
  const ctx = (await createApp({ configPath: repoConfig, storage })) as any
  return { app: ctx.dataFeedback.app, storage }
}

describe('Data API feedback', () => {
  it('POST stores valid feedback within reward_range; GET lists + filters', async () => {
    const { app } = await boot()
    const res = await app.request('/v1/data/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-1', reward: 2, confidence: 0.9, feedback_text: 'good' }),
    })
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created.reward).toBe(2)

    const list = await (await app.request('/v1/data/feedback?session_id=sess-1')).json()
    expect(list.entries.length).toBe(1)
    expect(list.entries[0].reward).toBe(2)
  })

  it('rejects a reward outside reward_range [-3,3] with 422 and stores nothing', async () => {
    const { app, storage } = await boot()
    const res = await app.request('/v1/data/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-x', reward: 5 }),
    })
    expect(res.status).toBe(422)
    expect(await storage.list('feedback/')).toHaveLength(0)
  })
})
