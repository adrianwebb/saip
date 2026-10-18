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
import { UserResolverService } from './plugins/user-resolver.js'
import { ApiCoreService } from './plugins/api-core.js'
import { ApiChatService } from './plugins/api-chat.js'
import { ApiSystemOneService } from './plugins/api-systemone.js'
import { SessionCollectorService } from './plugins/session-collector.js'
import { DataDocumentsService } from './plugins/data-documents.js'
import { loadConfig, type SaipRuntimeConfig } from './lib/config.js'
import { MemoryStorage, type StorageProvider, type VllmBackend } from './lib/backends.js'

export interface CreateAppOptions {
  config?: SaipRuntimeConfig
  /** Path to saip.yaml; used only when `config` is not provided. */
  configPath?: string
  storage?: StorageProvider
  vllm?: VllmBackend
  /** Override promoted-version lookup (defaults to reading adapters/_index.json). */
  latestVersion?: (name: string) => number | undefined
}

/** Build a latestVersion fn: prefer injected, else read the R2 adapter index. */
async function makeLatestVersion(
  storage: StorageProvider,
  override?: (name: string) => number | undefined,
): Promise<(name: string) => number | undefined> {
  if (override) return override
  let aliases: Record<string, string> = {}
  try {
    const raw = await storage.get('adapters/_index.json')
    if (raw) aliases = (JSON.parse(raw).aliases ?? {})
  } catch {
    /* no index yet */
  }
  return (name: string) => {
    const concrete = aliases[`${name}@latest`]
    if (!concrete) return undefined
    const m = concrete.match(/@(\d+)$/)
    return m ? Number.parseInt(m[1], 10) : undefined
  }
}

export async function createApp(opts: CreateAppOptions = {}) {
  const config = opts.config ?? loadConfig(opts.configPath)
  const storage = opts.storage ?? new MemoryStorage()

  const ctx = new Context()
  const latestVersion = await makeLatestVersion(storage, opts.latestVersion)
  // Shared services first so dependents can inject them via ctx.
  await ctx.plugin(AdapterRegistryService)
  await ctx.plugin(AdapterCompilerService)
  await ctx.plugin(GatewayStateService, { config, storage, vllm: opts.vllm })
  await ctx.plugin(UserResolverService, { users: config.users })
  await ctx.plugin(ApiCoreService, { modelBase: config.model.base, adapters: config.adapters })
  await ctx.plugin(ApiChatService, { users: config.users, adapters: config.adapters, vllm: opts.vllm, latestVersion })
  await ctx.plugin(ApiSystemOneService, { enabled: config.inference.systemone.enabled, users: config.users, adapters: config.adapters, vllm: opts.vllm, latestVersion })
  await ctx.plugin(SessionCollectorService, { storage })
  await ctx.plugin(DataDocumentsService, { storage })

  // Validate the loaded registry once at boot — CLI/inference/training must
  // agree on validity, so an invalid registry fails loudly here.
  const validation = (ctx as any).adapterRegistry.validate({ adapters: config.adapters, users: config.users })
  if (!validation.valid) {
    const codes = validation.errors.map((e: any) => `${e.code}@${e.path}`).join(', ')
    throw new Error(`invalid adapter registry: ${codes}`)
  }

  // Remaining plugins (apiSessions, apiFeedback, server composition) register
  // here as they are implemented.
  return ctx
}

// Only boot when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void createApp().then(() => console.log('[saip-inference] Gateway starting...'))
}
