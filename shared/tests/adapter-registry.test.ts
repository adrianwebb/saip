import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { validateRegistry, parseRef } from '../src/adapter-registry.js'
import type { AdapterDefinition } from '../src/types.js'

const codes = (input: any) => validateRegistry(input).errors.map((e) => e.code)

function leaf(name: string, over: Partial<AdapterDefinition> = {}): AdapterDefinition {
  return {
    name,
    scope: 'global',
    trainable: true,
    training: { strategy: 'knowledge_embedding', data_scopes: ['documents'] },
    ...over,
  } as AdapterDefinition
}

function composite(name: string, components: any[], over: Partial<AdapterDefinition> = {}): AdapterDefinition {
  return {
    name,
    scope: 'user',
    trainable: false,
    composite: { gain: 1.0, merge: 'weighted_linear', components },
    ...over,
  } as AdapterDefinition
}

describe('parseRef', () => {
  it('splits name@version', () => {
    expect(parseRef('coding@000012')).toEqual({ name: 'coding', version: '000012' })
  })
  it('handles bare name', () => {
    expect(parseRef('coding')).toEqual({ name: 'coding' })
  })
})

describe('validateRegistry — happy path', () => {
  it('accepts a valid registry with leaves + composite + user refs', () => {
    const result = validateRegistry({
      adapters: [
        leaf('coding'),
        leaf('research'),
        composite('agent', [
          { adapter: 'coding', weight: 0.7 },
          { adapter: 'research', weight: 1.0 },
        ]),
      ],
      users: [{ id: 'u', adapters: { inference: 'agent@latest', training: 'coding' } }],
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('passes against the shipped saip.yaml example', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    // shared/tests -> repo root is two levels up
    const configPath = new URL('../../saip.yaml', import.meta.url)
    const cfg = YAML.parse(readFileSync(configPath, 'utf8'))
    const result = validateRegistry(cfg)
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
    void here
  })
})

describe('validateRegistry — error cases', () => {
  it('rejects an entry with both training and composite', () => {
    const bad = { ...leaf('x'), composite: { gain: 1, merge: 'weighted_linear', components: [{ adapter: 'y', weight: 1 }] } }
    expect(codes({ adapters: [bad, leaf('y')], users: [] })).toContain('leaf_or_composite')
  })

  it('rejects an entry with neither training nor composite', () => {
    expect(codes({ adapters: [leaf('x', { training: undefined as any })], users: [] })).toContain('leaf_or_composite')
  })

  it('requires linkage completeness on leaves', () => {
    expect(codes({ adapters: [leaf('x', { training: { strategy: '', data_scopes: [] } as any })], users: [] })).toContain('missing_linkage')
  })

  it('project scope requires project field', () => {
    expect(codes({ adapters: [leaf('x', { scope: 'project' })], users: [] })).toContain('missing_project')
  })

  it('flags unknown component references', () => {
    const comps = [{ adapter: 'ghost', weight: 1 }, { adapter: 'b', weight: 1 }]
    expect(codes({ adapters: [composite('a', comps), leaf('b')], users: [] })).toContain('unknown_component')
  })

  it('flags self reference', () => {
    const comps = [{ adapter: 'a', weight: 1 }, { adapter: 'b', weight: 1 }]
    expect(codes({ adapters: [composite('a', comps), leaf('b')], users: [] })).toContain('self_reference')
  })

  it('flags negative weights', () => {
    const comps = [{ adapter: 'b', weight: -1 }, { adapter: 'c', weight: 1 }]
    expect(codes({ adapters: [composite('a', comps), leaf('b'), leaf('c')], users: [] })).toContain('invalid_weight')
  })

  it('flags composites with fewer than two components', () => {
    const comps = [{ adapter: 'b', weight: 1 }]
    expect(codes({ adapters: [composite('a', comps), leaf('b')], users: [] })).toContain('too_few_components')
  })

  it('detects transitive cycles between composites', () => {
    const a = composite('a', [{ adapter: 'b', weight: 1 }, { adapter: 'x', weight: 1 }])
    const b = composite('b', [{ adapter: 'a', weight: 1 }, { adapter: 'x', weight: 1 }])
    expect(codes({ adapters: [a, b, leaf('x')], users: [] })).toContain('cycle')
  })

  it('flags unknown adapter references in users', () => {
    expect(codes({ adapters: [leaf('real')], users: [{ id: 'u', adapters: { inference: 'ghost@latest', training: 'real' } }] })).toContain('unknown_adapter_ref')
  })

  it('returns structured errors with path/code/message', () => {
    const r = validateRegistry({ adapters: [leaf('x', { scope: 'project' })], users: [] })
    const err = r.errors.find((e) => e.code === 'missing_project')!
    expect(err.path).toContain('adapters[0]')
    expect(typeof err.message).toBe('string')
  })
})
