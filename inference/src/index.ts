/**
 * SAIP Inference Gateway — Cordis application entry point
 *
 * Composes the inference plugins: shared adapter registry + compiler, gateway
 * state (config + injectable storage/vllm backends), and — as implemented —
 * user resolution, session collection, data processing, and the Hono APIs.
 */

import { Context } from 'cordis'
import { AdapterRegistryService } from '@saip/shared/services'
import { AdapterCompilerService } from './plugins/adapter-compiler.js'
import { GatewayStateService } from './plugins/gateway-state.js'
import { loadConfig, type SaipRuntimeConfig } from './lib/config.js'
import { MemoryStorage, type StorageProvider, type VllmBackend } from './lib/backends.js'

export interface CreateAppOptions {
  config?: SaipRuntimeConfig
  /** Path to saip.yaml; used only when `config` is not provided. */
  configPath?: string
  storage?: StorageProvider
  vllm?: VllmBackend
}

export async function createApp(opts: CreateAppOptions = {}) {
  const config = opts.config ?? loadConfig(opts.configPath)
  const storage = opts.storage ?? new MemoryStorage()

  const ctx = new Context()
  // Shared services first so dependents can inject them via ctx.
  await ctx.plugin(AdapterRegistryService)
  await ctx.plugin(AdapterCompilerService)
  await ctx.plugin(GatewayStateService, { config, storage, vllm: opts.vllm })

  // Validate the loaded registry once at boot — CLI/inference/training must
  // agree on validity, so an invalid registry fails loudly here.
  const validation = (ctx as any).adapterRegistry.validate({ adapters: config.adapters, users: config.users })
  if (!validation.valid) {
    const codes = validation.errors.map((e: any) => `${e.code}@${e.path}`).join(', ')
    throw new Error(`invalid adapter registry: ${codes}`)
  }

  // Remaining plugins (userResolver, apiCore, apiChat, apiSystemOne,
  // sessionCollector, dataApi) register here as they are implemented.
  return ctx
}

// Only boot when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void createApp().then(() => console.log('[saip-inference] Gateway starting...'))
}
