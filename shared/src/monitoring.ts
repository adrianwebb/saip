/**
 * Pluggable monitoring seam. Gateways emit counters/gauges/histograms through a
 * MetricsService that wraps a MonitoringProvider and NEVER throws — observation
 * is decoupled from operation, so a broken or absent sink can't take down serving
 * or training. NoopMonitoring is the default; a Prometheus exporter plugs in
 * behind the same interface later.
 */

import { Service } from 'cordis'

export type MetricTags = Record<string, string>

export interface MonitoringProvider {
  counter(name: string, tags?: MetricTags, value?: number): void
  gauge(name: string, tags?: MetricTags, value?: number): void
  histogram(name: string, tags?: MetricTags, value?: number): void
}

/** Inert provider used by default and in tests. */
export class NoopMonitoring implements MonitoringProvider {
  counter(): void {}
  gauge(): void {}
  histogram(): void {}
}

declare module 'cordis' {
  interface Context { metrics?: MetricsService }
}

export const METRICS_SERVICE = 'metrics'

/** Safe wrapper: every sink call is guarded so emissions never throw outward. */
export class MetricsService extends Service {
  static readonly provide = METRICS_SERVICE
  private readonly provider: MonitoringProvider

  constructor(ctx: any, config: { provider?: MonitoringProvider } = {}) {
    super(ctx, METRICS_SERVICE)
    this.provider = config.provider ?? new NoopMonitoring()
  }

  private safe(fn: (p: MonitoringProvider) => void) {
    try { fn(this.provider) } catch { /* observe-only: swallow sink failures */ }
  }

  counter(name: string, tags?: MetricTags, value = 1): void { this.safe((p) => p.counter(name, tags, value)) }
  gauge(name: string, tags?: MetricTags, value?: number): void { this.safe((p) => p.gauge(name, tags, value)) }
  histogram(name: string, tags?: MetricTags, value?: number): void { this.safe((p) => p.histogram(name, tags, value)) }
}
