/**
 * auth — inference gateway Cordis plugin. Chooses an AuthProvider from config
 * (dev_mode → AllowAllDevAuth; else BearerTokenAuth over the configured token
 * map) and exposes a Hono middleware that rejects unauthenticated requests with
 * 401. Fail-closed: no provider means every API route is denied.
 */

import { Service } from 'cordis'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  BearerTokenAuth, AllowAllDevAuth,
  type AuthProvider, type Principal, type SecretsReader,
} from '@saip/shared'
import type { SecurityConfig } from '../lib/config.js'

declare module 'cordis' {
  interface Context { auth?: AuthService }
}

export interface AuthConfig {
  security: SecurityConfig
  secrets: SecretsReader
}

export const AUTH_PRINCIPAL = Symbol.for('saip.principal')

export class AuthService extends Service {
  static readonly provide = 'auth'
  readonly provider: AuthProvider

  constructor(ctx: any, cfg: AuthConfig) {
    super(ctx, 'auth')
    if (cfg.security.dev_mode) {
      this.provider = new AllowAllDevAuth()
    } else {
      this.provider = new BearerTokenAuth(cfg.security.api_tokens ?? [], cfg.secrets)
    }
  }

  /** Hono middleware: attaches Principal to context or returns 401. */
  require(): MiddlewareHandler<{ Variables: { principal: Principal } }> {
    const provider = this.provider
    return createMiddleware(async (c, next) => {
      const headers: Record<string, string | undefined> = {
        authorization: c.req.header('authorization') ?? c.req.header('Authorization'),
      }
      const principal = await provider.verifyApi({ headers })
      if (!principal) return c.json({ error: { message: 'authentication required', code: 'unauthorized' } }, 401)
      c.set('principal', principal)
      await next()
    })
  }
}
