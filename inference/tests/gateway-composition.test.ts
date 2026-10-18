import { describe, it, expect } from 'vitest'
import { createApp } from '../src/index.js'
import type { AdapterDefinition } from '@saip/shared'

describe('inference gateway composition', () => {
  const adapters: AdapterDefinition[] = [
    { name: 'coding', scope: 'global', trainable: true, training: { strategy: 'knowledge_embedding', data_scopes: ['documents'] } },
    { name: 'research', scope: 'domain', trainable: true, training: { strategy: 'weighted_kto', data_scopes: ['feedback'] } },
    { name: 'agent', scope: 'user', trainable: false, composite: { gain: 1.25, merge: 'weighted_linear', components: [
      { adapter: 'coding', weight: 0.7 }, { adapter: 'research', weight: 1.0 },
    ] } },
  ]

  it('boots a Cordis context with registry + compiler services injected', async () => {
    const ctx = (await createApp()) as any
    expect(typeof ctx.adapterRegistry?.validate).toBe('function')
    expect(typeof ctx.adapterCompiler?.plan).toBe('function')
  })

  it('compiler plans a composite using injected version source', async () => {
    const ctx = (await createApp()) as any
    ctx.adapterCompiler.setRegistry(adapters)
    ctx.adapterCompiler.setVersionSource({ latestVersion: (n: string) => (n === 'coding' ? 18 : n === 'research' ? 7 : undefined) })
    const r = ctx.adapterCompiler.plan('agent')
    expect(r.ok).toBe(true)
    expect(r.plan.components).toEqual([
      { id: 'coding', version: 18, weight: 0.7 },
      { id: 'research', version: 7, weight: 1.0 },
    ])
    expect(r.plan.gain).toBe(1.25)
  })

  it('registry service validates the same adapters the compiler consumes', async () => {
    const ctx = (await createApp()) as any
    const result = ctx.adapterRegistry.validate({ adapters, users: [{ id: 'u', adapters: { inference: 'agent@latest', training: 'coding' } }] })
    expect(result.valid).toBe(true)
  })
})
