import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { MetricsService, NoopMonitoring, type MonitoringProvider } from '../src/monitoring.js'

class RecordingSink implements MonitoringProvider {
  counters: Array<{ name: string; value: number }> = []
  counter(name: string, _tags?: Record<string, string>, n = 1) { this.counters.push({ name, value: n }) }
  gauge() {} histogram() {}
}

class ThrowingSink implements MonitoringProvider {
  counter(): void { throw new Error('sink down') }
  gauge(): void { throw new Error('sink down') }
  histogram(): void { throw new Error('sink down') }
}

describe('NoopMonitoring', () => {
  it('accepts emissions without throwing', () => {
    const n = new NoopMonitoring()
    expect(() => { n.counter('x'); n.gauge('y', {}, 3); n.histogram('z', {}, 0.5) }).not.toThrow()
  })
})

describe('MetricsService (Cordis)', () => {
  it('exposes counter/gauge/histogram on ctx.metrics', async () => {
    const sink = new RecordingSink()
    const ctx = new Context() as any
    await ctx.plugin(MetricsService, { provider: sink })
    ctx.metrics.counter('chat_requests', { route: 'chat' }, 2)
    expect(sink.counters).toEqual([{ name: 'chat_requests', value: 2 }])
  })

  it('Review-Focus #6: a throwing sink never propagates to the caller', async () => {
    const ctx = new Context() as any
    await ctx.plugin(MetricsService, { provider: new ThrowingSink() })
    expect(() => ctx.metrics.counter('anything')).not.toThrow()
    expect(() => ctx.metrics.gauge('g')).not.toThrow()
    expect(() => ctx.metrics.histogram('h', {}, 1)).not.toThrow()
  })

  it('works with no provider injected (defaults to noop)', async () => {
    const ctx = new Context() as any
    await ctx.plugin(MetricsService)
    expect(() => ctx.metrics.counter('x')).not.toThrow()
  })
})
