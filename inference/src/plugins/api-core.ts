/**
 * api-core — Hono service exposing the always-on operational endpoints:
 * GET /health and GET /v1/models. Mounted by createApp; other API plugins add
 * their own routes onto a shared or composed app in later tasks.
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import type { AdapterDefinition } from '@saip/shared'

export interface ApiCoreConfig {
  modelBase: string
  adapters: AdapterDefinition[]
}

declare module 'cordis' {
  interface Context {
    apiCore?: ApiCoreService
  }
}

export class ApiCoreService extends Service {
  static readonly provide = 'apiCore'
  readonly app = new Hono()

  constructor(ctx: any, config: ApiCoreConfig = { modelBase: '', adapters: [] }) {
    super(ctx, 'apiCore')
    const { modelBase, adapters } = config

    this.app.get('/health', (c) => c.json({ status: 'ok', model: modelBase }))

    this.app.get('/v1/models', (c) =>
      c.json({
        object: 'list',
        data: adapters.map((a) => ({
          id: a.name,
          object: 'model',
          scope: a.scope,
          composite: !!a.composite,
        })),
      }),
    )
  }
}
