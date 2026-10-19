import { describe, it, expect } from 'vitest'
import type { UserEntry } from '@saip/shared'
import { resolveAdapterForCaller } from '../src/lib/user-resolver.js'
import { createApp } from '../src/index.js'
import { fileURLToPath } from 'node:url'

const users: UserEntry[] = [
  { id: 'default', adapters: { inference: 'default-agent@latest', training: 'general' } },
  { id: 'alice', adapters: { inference: 'coding@latest', training: 'coding' } },
]

describe('resolveAdapterForCaller (pure)', () => {
  it('returns the known caller inference adapter', () => {
    expect(resolveAdapterForCaller(users, 'alice')).toEqual({ userId: 'alice', adapterRef: 'coding@latest' })
  })

  it('falls back to the default user for an unknown caller', () => {
    expect(resolveAdapterForCaller(users, 'nobody')).toEqual({ userId: 'default', adapterRef: 'default-agent@latest' })
  })

  it('falls back to the default user when no caller is provided', () => {
    expect(resolveAdapterForCaller(users, undefined)).toEqual({ userId: 'default', adapterRef: 'default-agent@latest' })
  })

  it('returns null adapterRef when there is no default and caller unknown', () => {
    const r = resolveAdapterForCaller([users[1]], 'ghost')
    expect(r.userId).toBeNull()
    expect(r.adapterRef).toBeUndefined()
  })
})

describe('UserResolverService (integration)', () => {
  const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

  it('resolves known and unknown callers through the booted app', async () => {
    const ctx = (await createApp({ configPath: repoConfig })) as any
    // shipped saip.yaml has only a `default` user
    expect(ctx.userResolver.resolve(undefined).userId).toBe('default')
    expect(ctx.userResolver.resolve('whoever').adapterRef).toBe('default-agent@latest')
  })
})
