/**
 * gateway-state — holds the resolved runtime config + injected backends so
 * plugins receive them via `ctx.gatewayState` instead of importing concrete
 * clients or re-reading files. Registered first in createApp after the shared
 * registry service.
 */

import { Service } from 'cordis'
import type { SaipRuntimeConfig } from '../lib/config.js'
import type { StorageProvider, VllmBackend } from '../lib/backends.js'

export interface GatewayStateConfig {
  config: SaipRuntimeConfig
  storage: StorageProvider
  vllm?: VllmBackend
}

declare module 'cordis' {
  interface Context {
    gatewayState?: GatewayStateService
  }
}

export class GatewayStateService extends Service {
  static readonly provide = 'gatewayState'

  readonly config: SaipRuntimeConfig
  readonly storage: StorageProvider
  readonly vllm?: VllmBackend

  constructor(ctx: any, state: GatewayStateConfig) {
    super(ctx, 'gatewayState')
    this.config = state.config
    this.storage = state.storage
    this.vllm = state.vllm
  }
}
