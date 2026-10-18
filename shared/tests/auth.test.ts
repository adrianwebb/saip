import { describe, it, expect } from 'vitest'
import { BearerTokenAuth, PasswordSessionAuth, AllowAllDevAuth, type SecretsReader } from '../src/auth.js'

const secrets = (map: Record<string, string>): SecretsReader => ({
  async require(name) { if (!(name in map)) throw new Error(`missing secret ${name}`); return map[name] },
})

describe('BearerTokenAuth', () => {
  const auth = new BearerTokenAuth(
    [{ caller: 'alice', token_secret: 'SAIP_TOKEN_ALICE' }, { caller: 'bob', token_secret: 'SAIP_TOKEN_BOB' }],
    secrets({ SAIP_TOKEN_ALICE: 'tok-alice-123', SAIP_TOKEN_BOB: 'tok-bob-456' }),
  )

  it('accepts a valid bearer and returns its principal', async () => {
    const p = await auth.verifyApi({ headers: { authorization: 'Bearer tok-alice-123' } })
    expect(p).toEqual({ callerId: 'alice' })
  })
  it('rejects missing header with null', async () => {
    expect(await auth.verifyApi({ headers: {} })).toBeNull()
  })
  it('rejects unknown token with null', async () => {
    expect(await auth.verifyApi({ headers: { authorization: 'Bearer nope' } })).toBeNull()
  })
  it('rejects malformed (non-Bearer) header with null', async () => {
    expect(await auth.verifyApi({ headers: { authorization: 'Basic xyz' } })).toBeNull()
  })
})

describe('PasswordSessionAuth (UI guard)', () => {
  const auth = new PasswordSessionAuth(secrets({ SAIP_UI_ADMIN: 'pw' }), 'SAIP_UI_ADMIN')
  it('verifies correct password, rejects wrong', async () => {
    expect(await auth.verifyUi!({ password: 'pw' })).toBe(true)
    expect(await auth.verifyUi!({ password: 'bad' })).toBe(false)
  })
})

describe('AllowAllDevAuth', () => {
  it('returns a fixed dev principal regardless of headers', async () => {
    const p = await new AllowAllDevAuth().verifyApi({ headers: {} })
    expect(p?.callerId).toBe('dev')
  })
})
