/**
 * learning-api — training gateway Cordis plugin.
 *
 * Serves the Learning API (`/v1/learning/*`) on a Hono app. Job creation resolves
 * adapter → strategy → data-scope linkage through the pure resolver in
 * lib/job-linkage.ts, honoring the documented inheritance and error contract.
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import type { AdapterDefinition } from '@saip/shared'
import { resolveJobLinkage, type JobRequest } from '../lib/job-linkage.js'

export interface LearningApiConfig {
  adapters?: AdapterDefinition[]
  registeredStrategies?: string[]
  /** Resolve a caller id to their default training adapter (users[].adapters.training). */
  defaultAdapterFor?: (callerId?: string) => string | undefined
}

declare module 'cordis' {
  interface Context {
    learningApi?: LearningApiService
  }
}

let jobCounter = 0
const nextJobId = () => `train-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(++jobCounter).padStart(3, '0')}`

export class LearningApiService extends Service {
  static readonly provide = 'learningApi'
  readonly app = new Hono()

  private adapters: AdapterDefinition[]
  private strategies: string[]
  private defaultAdapterFor: (callerId?: string) => string | undefined

  constructor(ctx: any, config: LearningApiConfig = {}) {
    super(ctx, 'learningApi')
    this.adapters = config.adapters ?? []
    this.strategies = config.registeredStrategies ?? []
    this.defaultAdapterFor = config.defaultAdapterFor ?? (() => undefined)
    this.routes()
  }

  setRegistry(adapters: AdapterDefinition[]) { this.adapters = adapters }
  setStrategies(strategies: string[]) { this.strategies = strategies }

  private routes() {
    const { app } = this

    app.get('/v1/learning/strategies', (c) => {
      return c.json({ strategies: this.strategies })
    })

    app.post('/v1/learning/jobs', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as JobRequest
      // Caller identity resolution is injected; MVP uses an optional header.
      const caller = c.req.header('x-saip-caller') || undefined
      const result = resolveJobLinkage(body, {
        adapters: this.adapters,
        defaultAdapter: this.defaultAdapterFor(caller),
        registeredStrategies: this.strategies,
      })
      if (!result.ok) {
        return c.json({ error: { code: result.error.code, message: result.error.message } }, result.error.status as 404 | 422)
      }
      const job = result.job
      return c.json({
        job_id: nextJobId(),
        adapter: job.adapter,
        strategy: job.strategy,
        inherited: { data_scopes: job.data_scopes },
        params: job.params,
        status: 'queued',
        created_at: new Date().toISOString(),
      }, 202)
    })
  }
}
