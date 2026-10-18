import { describe, it, expect } from 'vitest'
import { createApp } from '../src/index.js'

const adapters = [
  { name: 'coding', scope: 'global', trainable: true, training: { strategy: 'corrective_sft', data_scopes: ['sessions'] } },
] as any

describe('training Learning API auth enforcement (fail-closed)', () => {
  it('rejects unauthenticated job creation with 401 when tokens configured & not dev', async () => {
    const ctx = (await createApp({ security: { dev_mode: false, api_tokens: [{ caller: 'alice', token_secret: 'SAIP_TOKEN_ALICE' }] }, adapters, registeredStrategies: ['corrective_sft'] })) as any
    const res = await ctx.learningApi.app.request('/v1/learning/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    expect(res.status).toBe(401)
  })

  it('accepts a valid bearer and inherits linkage', async () => {
    process.env.SAIP_TOKEN_ALICE = 'tok-alice-train'
    const ctx = (await createApp({ security: { dev_mode: false, api_tokens: [{ caller: 'alice', token_secret: 'SAIP_TOKEN_ALICE' }] }, adapters, registeredStrategies: ['corrective_sft'], defaultAdapterFor: () => 'coding' })) as any
    const res = await ctx.learningApi.app.request('/v1/learning/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-alice-train' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.strategy).toBe('corrective_sft')
    delete process.env.SAIP_TOKEN_ALICE
  })

  it('dev_mode allows anonymous', async () => {
    const ctx = (await createApp({ security: { dev_mode: true }, adapters, registeredStrategies: ['corrective_sft'] })) as any
    const res = await ctx.learningApi.app.request('/v1/learning/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    expect(res.status).toBe(202)
  })
})
