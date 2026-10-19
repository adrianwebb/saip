import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import { MemoryStorage } from '../src/lib/backends.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

describe('SessionCollectorService', () => {
  it('persists a session on chat/request and emits session/complete', async () => {
    const storage = new MemoryStorage()
    const ctx = (await createApp({ configPath: repoConfig, storage, latestVersion: (n) => ({ general: 42, coding: 18, 'default-agent': 3 }[n]) })) as any

    let completed = false
    ctx.on('session/complete', () => { completed = true })

    ctx.emit('chat/request', { caller: 'alice', adapter: 'coding@000018', messages: [{ role: 'user', content: 'hi' }] })
    await ctx.sessionCollector.flush()

    const keys = await storage.list('sessions/')
    expect(keys.length).toBeGreaterThan(0)
    const manifestKey = keys.find((k) => k.endsWith('/manifest.json'))
    expect(manifestKey).toBeTruthy()
    const manifest = JSON.parse(await storage.get(manifestKey!)!)
    expect(manifest.caller).toBe('alice')
    expect(manifest.adapter_id).toBe('coding@000018')
    expect(completed).toBe(true)
  })
})
