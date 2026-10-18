import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/index.js'
import { MemoryStorage } from '../src/lib/backends.js'
import type { SaipRuntimeConfig } from '../src/lib/config.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

describe('createApp wiring', () => {
  it('boots with injected config + storage and exposes gateway state', async () => {
    const storage = new MemoryStorage()
    const ctx = (await createApp({ storage, configPath: repoConfig })) as any
    expect(ctx.adapterRegistry).toBeDefined()
    expect(typeof ctx.gatewayState?.storage?.put).toBe('function')
    expect(ctx.gatewayState.config.adapters.length).toBe(3)
    // same storage instance is shared across plugins
    await ctx.gatewayState.storage.put('x', 'y')
    expect(await storage.get('x')).toBe('y')
  })

  it('defaults to loadConfig() + a fresh MemoryStorage when nothing injected', async () => {
    const prev = process.env.SAIP_CONFIG
    process.env.SAIP_CONFIG = repoConfig
    try {
      const ctx = (await createApp()) as any
      expect(ctx.gatewayState.config.model.base).toBe('Qwen/Qwen3.5-4B')
      expect(typeof ctx.gatewayState.storage.list).toBe('function')
    } finally {
      if (prev === undefined) delete process.env.SAIP_CONFIG
      else process.env.SAIP_CONFIG = prev
    }
  })

  it('throws on an invalid adapter registry at boot', async () => {
    const bad: SaipRuntimeConfig = {
      model: { base: '' },
      users: [],
      adapters: [
        { name: 'a', scope: 'user', trainable: false, composite: { gain: 1, merge: 'weighted_linear', components: [{ adapter: 'a', weight: 1 }, { adapter: 'b', weight: 1 }] } } as any,
        { name: 'b', scope: 'global', trainable: true, training: { strategy: 's', data_scopes: ['documents'] } } as any,
      ],
      inference: { port: 8000, maxLoras: 4, systemone: { enabled: false } },
    }
    await expect(createApp({ config: bad })).rejects.toThrow(/adapter registry/i)
  })
})
