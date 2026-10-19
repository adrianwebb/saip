import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

async function boot() {
  const ctx = (await createApp({ configPath: repoConfig })) as any
  return ctx.apiCore.app
}

describe('ApiCoreService routes', () => {
  it('GET /health → 200 status ok + model', async () => {
    const app = await boot()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.model).toBe('Qwen/Qwen3.5-4B')
  })

  it('GET /v1/models lists registry adapters', async () => {
    const app = await boot()
    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.object).toBe('list')
    const ids = body.data.map((m: any) => m.id)
    for (const name of ['general', 'coding', 'default-agent']) expect(ids).toContain(name)
  })
})
