import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { LearningApiService } from '../src/plugins/learning-api.js'
import type { AdapterDefinition } from '@saip/shared'

const leaf = (name: string): AdapterDefinition => ({
  name, scope: 'global', trainable: true,
  training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] },
})
const composite = (name: string): AdapterDefinition => ({
  name, scope: 'user', trainable: false,
  composite: { gain: 1, merge: 'weighted_linear', components: [{ adapter: 'a', weight: 1 }, { adapter: 'b', weight: 1 }] },
})

async function boot() {
  const ctx = new Context() as any
  await ctx.plugin(LearningApiService as any, {
    adapters: [leaf('northstar-project'), composite('agent')],
    registeredStrategies: ['corrective_sft'],
    defaultAdapterFor: () => 'northstar-project',
  })
  return ctx.learningApi.app
}

describe('Learning API HTTP contract', () => {
  it('POST /v1/learning/jobs inherits linkage and returns 202', async () => {
    const app = await boot()
    const res = await app.request('/v1/learning/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adapter: 'northstar-project' }),
    })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.adapter).toBe('northstar-project')
    expect(body.strategy).toBe('corrective_sft')
    expect(body.inherited.data_scopes).toEqual(['sessions', 'feedback'])
    expect(body.status).toBe('queued')
  })

  it('422 for composite target', async () => {
    const app = await boot()
    const res = await app.request('/v1/learning/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adapter: 'agent' }),
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('composite_not_trainable')
  })

  it('404 for unknown adapter', async () => {
    const app = await boot()
    const res = await app.request('/v1/learning/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adapter: 'ghost' }),
    })
    expect(res.status).toBe(404)
  })

  it('GET /v1/learning/strategies lists registered strategies', async () => {
    const app = await boot()
    const res = await app.request('/v1/learning/strategies')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.strategies).toContain('corrective_sft')
  })
})
