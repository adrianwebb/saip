import { describe, it, expect } from 'vitest'
import type { AdapterDefinition } from '@saip/shared'
import { resolveJobLinkage } from '../src/lib/job-linkage.js'

const leaf = (name: string, over: Partial<AdapterDefinition> = {}): AdapterDefinition => ({
  name, scope: 'global', trainable: true,
  training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] },
  ...over,
} as AdapterDefinition)

const composite = (name: string): AdapterDefinition => ({
  name, scope: 'user', trainable: false,
  composite: { gain: 1, merge: 'weighted_linear', components: [{ adapter: 'a', weight: 1 }, { adapter: 'b', weight: 1 }] },
})

const baseCtx = {
  adapters: [leaf('northstar-project'), leaf('coding', { training: { strategy: 'knowledge_embedding', data_scopes: ['documents'] } }), composite('agent')],
  registeredStrategies: ['corrective_sft', 'knowledge_embedding', 'weighted_kto'],
}

describe('resolveJobLinkage — inheritance', () => {
  it('inherits strategy + data_scopes when only adapter given', () => {
    const r = resolveJobLinkage({ adapter: 'northstar-project' }, baseCtx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.job.strategy).toBe('corrective_sft')
    expect(r.job.data_scopes).toEqual(['sessions', 'feedback'])
    expect(r.job.inherited.strategy).toBe(true)
  })

  it('explicit strategy overrides inherited; params merge', () => {
    const r = resolveJobLinkage(
      { adapter: 'coding', strategy: 'weighted_kto', params: { epochs: 3 } },
      baseCtx,
    )
    expect(r.ok && r.job.strategy).toBe('weighted_kto')
    expect(r.ok && r.job.inherited.strategy).toBe(false)
    expect(r.ok && r.job.params.epochs).toBe(3)
  })

  it('uses default training adapter when none specified', () => {
    const r = resolveJobLinkage({}, { ...baseCtx, defaultAdapter: 'coding' })
    expect(r.ok && r.job.adapter).toBe('coding')
  })
})

describe('resolveJobLinkage — errors', () => {
  it('404 unknown adapter', () => {
    const r = resolveJobLinkage({ adapter: 'ghost' }, baseCtx)
    expect(!r.ok && (r as any).error.status).toBe(404)
    expect(!r.ok && (r as any).error.code).toBe('adapter_not_found')
  })

  it('422 composite not trainable', () => {
    const r = resolveJobLinkage({ adapter: 'agent' }, baseCtx)
    expect(!r.ok && (r as any).error.code).toBe('composite_not_trainable')
  })

  it('422 unknown strategy on override', () => {
    const r = resolveJobLinkage({ adapter: 'coding', strategy: 'made_up' }, baseCtx)
    expect(!r.ok && (r as any).error.code).toBe('unknown_strategy')
  })

  it('404 no adapter and no default', () => {
    const r = resolveJobLinkage({}, baseCtx)
    expect(!r.ok && (r as any).error.status).toBe(404)
  })
})
