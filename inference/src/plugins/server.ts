/**
 * server — composes every API plugin's Hono sub-app into one application for
 * serving. Each feature owns its own routes; this only wires them together and
 * exposes startServer() for the direct-run path.
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Context { server?: ServerService }
}

export class ServerService extends Service {
  static readonly provide = 'server'
  static readonly inject = ['apiCore', 'apiChat', 'apiSystemOne', 'dataDocuments', 'dataSessions', 'dataFeedback'] as const
  readonly app = new Hono()

  constructor(ctx: any) {
    super(ctx, 'server')
    const c = ctx as Context & Record<string, any>
    // Mount each provided sub-app at root; order is irrelevant (distinct paths).
    for (const key of ['apiCore', 'apiChat', 'apiSystemOne', 'dataDocuments', 'dataSessions', 'dataFeedback']) {
      const sub = c[key]?.app
      if (sub) this.app.route('/', sub)
    }
  }

  /** Start an HTTP server on `port` (used when the gateway runs directly). */
  start(port: number): ReturnType<typeof serve> {
    return serve({ fetch: this.app.fetch, port })
  }
}
