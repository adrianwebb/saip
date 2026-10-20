/**
 * Composition-root acceptance tier for secrets (#76).
 *
 * `defaultSecretsProvider()` is what every gateway and CLI command actually uses. Until now
 * every secrets test injected a provider or a key source — so the wiring had zero coverage, and
 * that is precisely where #73's defect (both key sources unreachable) lived.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSecretsProvider, MissingSecretError } from '../src/index.js'

const storePath = () => join(mkdtempSync(join(tmpdir(), 'saip-wire-')), 'secrets.enc.json')

describe('defaultSecretsProvider (the real composition path)', () => {
  it('resolves from the shell without any store present', async () => {
    const env = { SAIP_R2_BUCKET: 'from-shell', SAIP_SECRETS_FILE: storePath() }
    const p = defaultSecretsProvider(env, { path: env.SAIP_SECRETS_FILE })
    expect(await p.get('SAIP_R2_BUCKET')).toBe('from-shell')
    expect(await p.require('SAIP_R2_BUCKET')).toBe('from-shell')
  })

  it('fails closed with a named secret when nothing supplies it', async () => {
    const path = storePath()
    const p = defaultSecretsProvider({ SAIP_SECRETS_PASSPHRASE: 'wiring-test', SAIP_SECRETS_FILE: path }, { path })
    await expect(p.require('SAIP_NOT_ANYWHERE')).rejects.toBeInstanceOf(MissingSecretError)
  })

  it('round-trips a value through the production provider, no injected provider or key source', async () => {
    const path = storePath()
    const env = { SAIP_SECRETS_PASSPHRASE: 'wiring-test-2', SAIP_SECRETS_FILE: path }
    const writer = defaultSecretsProvider(env, { path })
    // Write through the store the provider is built on, exactly as `saip config set` does.
    const { SecretStore, defaultKeySources } = await import('../src/secrets-store.js')
    const store = new SecretStore({ path, keySources: defaultKeySources(env, { storePath: path }) })
    await store.set('SAIP_R2_SECRET_ACCESS_KEY', 'live-like-value')

    // A second provider instance simulates the next process invocation.
    const reader = defaultSecretsProvider(env, { path })
    expect(await reader.require('SAIP_R2_SECRET_ACCESS_KEY')).toBe('live-like-value')
  })

  it('shell wins over the store through the composed chain', async () => {
    const path = storePath()
    const env = { SAIP_SECRETS_PASSPHRASE: 'wiring-test-3', SAIP_SECRETS_FILE: path }
    const { SecretStore, defaultKeySources } = await import('../src/secrets-store.js')
    await new SecretStore({ path, keySources: defaultKeySources(env, { storePath: path }) }).set('SAIP_R2_BUCKET', 'stored')
    const p = defaultSecretsProvider({ ...env, SAIP_R2_BUCKET: 'shell-wins' }, { path })
    expect(await p.require('SAIP_R2_BUCKET')).toBe('shell-wins')
  })
})
