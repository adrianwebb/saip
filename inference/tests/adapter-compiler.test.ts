import { describe, it, expect } from 'vitest'
import type { AdapterDefinition, CompositionRecord } from '@saip/shared'
import { planCompile, planToRecord, isStale, type VersionSource } from '../src/lib/adapter-compiler.js'

const leaf = (name: string, base?: string): AdapterDefinition => ({
  name, scope: 'global', trainable: true, base,
  training: { strategy: 'knowledge_embedding', data_scopes: ['documents'] },
})

const composite = (name: string, components: any[], gain = 1.0): AdapterDefinition => ({
  name, scope: 'user', trainable: false,
  composite: { gain, merge: 'weighted_linear', components },
})

const versions = (map: Record<string, number>): VersionSource => ({
  latestVersion: (n) => map[n],
})

describe('planCompile', () => {
  const adapters = [leaf('coding'), leaf('research'), composite('agent', [
    { adapter: 'coding', weight: 0.7 },
    { adapter: 'research', weight: 1.0 },
  ], 1.25)]

  it('resolves @latest components to current promoted versions', () => {
    const r = planCompile('agent', adapters, versions({ coding: 18, research: 7 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.gain).toBe(1.25)
    expect(r.plan.merge).toBe('weighted_linear')
    expect(r.plan.components).toEqual([
      { id: 'coding', version: 18, weight: 0.7 },
      { id: 'research', version: 7, weight: 1.0 },
    ])
  })

  it('honors explicit version pins over @latest', () => {
    const pinned = [leaf('coding'), leaf('research'), composite('agent', [
      { adapter: 'coding@000012', weight: 0.7 },
      { adapter: 'research', weight: 1.0 },
    ])]
    const r = planCompile('agent', pinned, versions({ coding: 99, research: 7 }))
    expect(r.ok && r.plan.components[0]).toEqual({ id: 'coding', version: 12, weight: 0.7 })
  })

  it('errors when a @latest component has no promoted version', () => {
    const r = planCompile('agent', adapters, versions({ coding: 18 /* research missing */ }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect((r as any).error.code).toBe('unresolved_version')
  })

  it('errors on non-composite target', () => {
    const r = planCompile('coding', adapters, versions({}))
    expect(!r.ok && (r as any).error.code).toBe('not_composite')
  })

  it('errors on unknown adapter', () => {
    const r = planCompile('ghost', adapters, versions({}))
    expect(!r.ok && (r as any).error.code).toBe('unknown_adapter')
  })

  it('errors when components target different base models', () => {
    const mixed = [leaf('a', 'qwen-4b'), leaf('b', 'llama-8b'), composite('c', [
      { adapter: 'a', weight: 1 }, { adapter: 'b', weight: 1 },
    ])]
    const r = planCompile('c', mixed, versions({ a: 1, b: 1 }))
    expect(!r.ok && (r as any).error.code).toBe('base_mismatch')
  })
})

describe('planToRecord + isStale', () => {
  const adapters = [leaf('coding'), leaf('research'), composite('agent', [
    { adapter: 'coding', weight: 0.7 }, { adapter: 'research', weight: 1.0 },
  ], 1.25)]

  it('round-trips a plan into a provenance record', () => {
    const r = planCompile('agent', adapters, versions({ coding: 18, research: 7 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rec = planToRecord(r.plan)
    expect(rec).toEqual({
      gain: 1.25, merge: 'weighted_linear',
      components: [{ id: 'coding', version: 18, weight: 0.7 }, { id: 'research', version: 7, weight: 1.0 }],
    })
  })

  it('detects staleness when a component promotes', () => {
    const prev: CompositionRecord = { gain: 1.25, merge: 'weighted_linear', components: [
      { id: 'coding', version: 18, weight: 0.7 }, { id: 'research', version: 7, weight: 1.0 },
    ] }
    // research advances 7 → 8
    const r = planCompile('agent', adapters, versions({ coding: 18, research: 8 }))
    expect(r.ok && isStale(prev, r.plan)).toBe(true)
  })

  it('not stale when nothing changed', () => {
    const r = planCompile('agent', adapters, versions({ coding: 18, research: 7 }))
    if (!r.ok) throw new Error('unexpected')
    expect(isStale(planToRecord(r.plan), r.plan)).toBe(false)
  })

  it('stale when gain changes', () => {
    const prev: CompositionRecord = { gain: 1.0, merge: 'weighted_linear', components: [
      { id: 'coding', version: 18, weight: 0.7 }, { id: 'research', version: 7, weight: 1.0 },
    ] }
    const r = planCompile('agent', adapters, versions({ coding: 18, research: 7 }))
    expect(r.ok && isStale(prev, r.plan)).toBe(true) // gain 1.0 vs 1.25
  })
})
