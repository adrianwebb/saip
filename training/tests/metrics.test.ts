import { describe, it, expect } from 'vitest'
import { createApp } from '../src/index.js'
import type { MonitoringProvider } from '@saip/shared'

class Counter implements MonitoringProvider {
  counters: Record<string, number> = {}
  counter(name: string) { this.counters[name] = (this.counters[name] ?? 0) + 1 }
  gauge() {} histogram() {}
}
class Throwing implements MonitoringProvider {
  counter() { throw new Error('boom') } gauge() { throw new Error('boom') } histogram() { throw new Error('boom') }
}
const adapters = [{ name: 'coding', scope: 'global', trainable: true, training: { strategy: 'corrective_sft', data_scopes: ['sessions'] } }] as any

describe('training metrics emission', () => {
  it('counts a queued learning job via the event bridge', async () => {
    const sink = new Counter()
    const ctx = (await createApp({ security: { dev_mode: true }, adapters, registeredStrategies: ['corrective_sft'], monitoring: sink })) as any
    await ctx.learningApi.app.request('/v1/learning/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }) })
    expect(sink.counters['saip_learning_jobs_queued_total']).toBe(1)
  })

  it('Review-Focus #6: throwing sink never breaks job acceptance', async () => {
    const ctx = (await createApp({ security: { dev_mode: true }, adapters, registeredStrategies: ['corrective_sft'], monitoring: new Throwing() })) as any
    const res = await ctx.learningApi.app.request('/v1/learning/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }) })
    expect(res.status).toBe(202)
  })
})
