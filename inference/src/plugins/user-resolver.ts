/**
 * user-resolver — Cordis plugin. Resolves a caller identity to their inference
 * adapter reference using the loaded registry/config, via the pure resolver.
 */

import { Service } from 'cordis'
import type { UserEntry } from '@saip/shared'
import { resolveAdapterForCaller, type ResolvedCaller } from '../lib/user-resolver.js'

export interface UserResolverConfig {
  users: UserEntry[]
}

declare module 'cordis' {
  interface Context {
    userResolver?: UserResolverService
  }
}

export class UserResolverService extends Service {
  static readonly provide = 'userResolver'
  private readonly users: UserEntry[]

  constructor(ctx: any, config: UserResolverConfig = { users: [] }) {
    super(ctx, 'userResolver')
    this.users = config.users
  }

  resolve(callerId?: string): ResolvedCaller {
    return resolveAdapterForCaller(this.users, callerId)
  }
}
