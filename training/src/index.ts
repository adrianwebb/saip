/**
 * SAIP Training Gateway — Cordis application entry point
 *
 * Composes the training plugins: shared adapter registry service, auth, learning
 * API (strategy registration + job linkage), Axolotl runner, and R2 sync as those
 * are implemented.
 */

import { Context } from 'cordis'
import { AdapterRegistryService, SecretsService } from '@saip/shared/services'
import { EnvSecrets, BearerTokenAuth, AllowAllDevAuth, type AuthProvider } from '@saip/shared'
import { LearningApiService } from './plugins/learning-api.js'
import { createMiddleware } from 'hono/factory'

export interface SecurityConfig {
  dev_mode?: boolean
  api_tokens?: Array<{ caller: string; token_secret: string }>
}

export interface CreateAppOptions {
  security?: SecurityConfig
  adapters?: any[]
  registeredStrategies?: string[]
  defaultAdapterFor?: (callerId?: string) => string | undefined
}

function pickAuthProvider(security: SecurityConfig, secrets: any): AuthProvider {
  if (security.dev_mode) return new AllowAllDevAuth()
  return new BearerTokenAuth(security.api_tokens ?? [], secrets)
}

export async function createApp(opts: CreateAppOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(AdapterRegistryService)
  await ctx.plugin(SecretsService, { provider: new EnvSecrets() })

  const security = opts.security ?? { dev_mode: false, api_tokens: [] }
  const provider = pickAuthProvider(security, (ctx as any).secrets)
  const authMiddleware = createMiddleware(async (c: any, next: any) => {
    const principal = await provider.verifyApi({ headers: { authorization: c.req.header('authorization') ?? c.req.header('Authorization') } })
    if (!principal) return c.json({ error: { message: 'authentication required', code: 'unauthorized' } }, 401)
    c.set('principal', principal)
    await next()
  })

  await ctx.plugin(LearningApiService, {
    adapters: opts.adapters,
    registeredStrategies: opts.registeredStrategies,
    defaultAdapterFor: opts.defaultAdapterFor,
    authMiddleware,
  })
  // Remaining plugins (axolotlRunner, r2Sync) register here as they are implemented.
  return ctx
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void createApp().then(() => console.log('[saip-training] Gateway starting...'))
}
