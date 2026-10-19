import { describe, it, expect } from 'vitest'
import type { AdapterDefinition } from '@saip/shared'
import { serveVersionFor } from '../src/lib/serve-resolver.js'

const adapters: AdapterDefinition[] = [
  { name: 'coding', scope: 'global', trainable: true, training: { strategy: 's', data_scopes: ['documents'] } },
  { name: 'agent', scope: 'user', trainable: false, composite: { gain: 1, merge: 'weighted_linear', components: [{ adapter: 'coding', weight: 1 }, { adapter: 'x', weight: 1 }] } },
  { name: 'x', scope: 'domain', trainable: true, training: { strategy: 's', data_scopes: [] } },
]
const latest: Record<string, number> = { coding: 18, agent: 3, x: 7 }
const latestFor = (n: string) => latest[n]

describe('serveVersionFor', () => {
  it('resolves a leaf @latest to its promoted version', () => {
    expect(serveVersionFor('coding@latest', adapters, latestFor)).toBe('coding@000018')
  })

  it('honors an explicit pin', () => {
    expect(serveVersionFor('coding@000009', adapters, latestFor)).toBe('coding@000009')
  })

  it('resolves a composite to its OWN compiled version, never a component', () => {
    const r = serveVersionFor('agent@latest', adapters, latestFor)
    expect(r).toBe('agent@000003')
    expect(r).not.toContain('coding')
  })

  it('throws when a composite has no compiled version yet', () => {
    expect(() => serveVersionFor('agent@latest', adapters, (n) => (n === 'agent' ? undefined : 1))).toThrow(/no compiled version/)
  })
})
