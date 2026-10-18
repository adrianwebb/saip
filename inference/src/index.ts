/**
 * SAIP Inference Gateway — Cordis application entry point
 *
 * Composes the inference plugins: shared adapter registry + compiler, gateway
 * state (config + injectable storage/vllm backends), and — as implemented —
 * user resolution, session collection, data processing, and the Hono APIs.
 */

import { Context } from 'cordis'
import { AdapterRegistryService, SecretsService } from '@saip/shared/services'
import { EnvSecrets, MetricsService } from '@saip/shared'
import { AdapterCompilerService } from './plugins/adapter-compiler.js'
import { GatewayStateService } from './plugins/gateway-state.js'
import { UserResolverService } from './plugins/user-resolver.js'
import { AuthService } from './plugins/auth.js'
import { ApiCoreService } from './plugins/api-core.js'
import { ApiChatService } from './plugins/api-chat.js'
import { ApiSystemOneService } from './plugins/api-systemone.js'
import { SessionCollectorService } from './plugins/session-collector.js'
import { DataDocumentsService } from './plugins/data-documents.js'
import { DataSessionsService } from './plugins/data-sessions.js'
import { DataFeedbackService } from './plugins/data-feedback.js'
import { ServerService } from './plugins/server.js'
import { loadConfig, type SaipRuntimeConfig } from './lib/config.js'
import { MemoryStorage, type StorageProvider, type VllmBackend } from './lib/backends.js'
import type { MonitoringProvider } from '@saip/shared'

export interface CreateAppOptions {
  config?: SaipRuntimeConfig
  /** Path to saip.yaml; used only when `config` is not provided. */
  configPath?: string
  storage?: StorageProvider
  vllm?: VllmBackend
  /** Override promoted-version lookup (defaults to reading adapters/_index.json). */
  latestVersion?: (name: string) => number | undefined
  /** Monitoring sink for the Metrics service (default noop). */
  monitoring?: MonitoringProvider
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
  const loaded = opts.config ?? loadConfig(opts.configPath)
  // Defensive: a hand-built config may omit newer optional sections.
  const config: SaipRuntimeConfig = { ...loaded, security: loaded.security ?? { dev_mode: false, api_tokens: [] } }
  const storage = opts.storage ?? new MemoryStorage()

  const ctx = new Context()
  const latestVersion = await makeLatestVersion(storage, opts.latestVersion)

  // Shared services first so dependents can inject them via ctx.
  await ctx.plugin(AdapterRegistryService)

  // Validate the registry FIRST — an invalid registry must fail loudly before any
  // dependent plugin boots (CLI/inference/training agree on validity).
  const validation = (ctx as any).adapterRegistry.validate({ adapters: config.adapters, users: config.users })
  if (!validation.valid) {
    const codes = validation.errors.map((e: any) => `${e.code}@${e.path}`).join(', ')
    throw new Error(`invalid adapter registry: ${codes}`)
  }

  await ctx.plugin(SecretsService, { provider: new EnvSecrets() })
  await ctx.plugin(MetricsService, { provider: opts.monitoring })
  await ctx.plugin(AdapterCompilerService)
  await ctx.plugin(GatewayStateService, { config, storage, vllm: opts.vllm })
  await ctx.plugin(UserResolverService, { users: config.users })
  await ctx.plugin(AuthService, { security: config.security, secrets: (ctx as any).secrets })
  const authMiddleware = (ctx as any).auth.require()
  await ctx.plugin(ApiCoreService, { modelBase: config.model.base, adapters: config.adapters })
  await ctx.plugin(ApiChatService, { users: config.users, adapters: config.adapters, vllm: opts.vllm, latestVersion, authMiddleware })
  await ctx.plugin(ApiSystemOneService, { enabled: config.inference.systemone.enabled, users: config.users, adapters: config.adapters, vllm: opts.vllm, latestVersion, authMiddleware })
  await ctx.plugin(SessionCollectorService, { storage })
  await ctx.plugin(DataDocumentsService, { storage })
  await ctx.plugin(DataSessionsService, { storage })
  await ctx.plugin(DataFeedbackService, { storage, rewardRange: config.training?.methods?.weighted_kto?.reward_range })

  // Monitoring bridge: map domain events → metrics. Observe-only; never affects
  // request handling (MetricsService already swallows sink errors).
  const metrics = (ctx as any).metrics
  ctx.on('chat/request', () => metrics.counter('saip_chat_requests_total'))
  ctx.on('session/complete', () => metrics.counter('saip_sessions_collected_total'))
  ctx.on('data/stored', (evt: { kind: string }) => metrics.counter('saip_data_stored_total', { kind: evt.kind }))

  // Compose all API sub-apps into one server (registered last so every route
  // plugin already exists on ctx).
  await ctx.plugin(ServerService)
  return ctx
}

// Only boot when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void createApp().then((ctx) => {
    const port = Number(process.env.SAIP_INFERENCE_PORT ?? (ctx as any).gatewayState.config.inference.port ?? 8000)
    ;(ctx as any).server.start(port)
    console.log(`[saip-inference] Gateway listening on :${port}`)
  })
}
