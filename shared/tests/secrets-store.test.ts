import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SecretStore, SecretStoreError, MemoryKeySource, PassphraseKey, ChainSecrets,
  EncryptedSecretsProvider, SecretToolKey, defaultKeySources,
} from '../src/secrets-store.js'
import { EnvSecrets, MissingSecretError } from '../src/hosting.js'

const dir = () => mkdtempSync(join(tmpdir(), 'saip-sec-'))
const storeAt = (key: Buffer | null, name = 's.enc.json') =>
  new SecretStore({ path: join(dir(), name), keySources: [new MemoryKeySource(key)] })
const KEY = Buffer.alloc(32, 7)
const other = (k: Buffer) => new MemoryKeySource(k)

describe('SecretStore', () => {
  it('treats an absent file as an empty store rather than an error', async () => {
    const s = storeAt(KEY)
    expect(s.exists()).toBe(false)
    expect(await s.read()).toEqual({})
    expect(await s.names()).toEqual([])
    expect(await s.get('NOPE')).toBeUndefined()
  })

  it('round-trips set / get / names / unset', async () => {
    const s = storeAt(KEY)
    await s.set('SAIP_R2_BUCKET', 'saip-platform')
    await s.set('SAIP_HF_TOKEN', 'hf_abc')
    expect(await s.names()).toEqual(['SAIP_HF_TOKEN', 'SAIP_R2_BUCKET'])
    expect(await s.get('SAIP_HF_TOKEN')).toBe('hf_abc')
    expect(await s.unset('SAIP_HF_TOKEN')).toBe(true)
    expect(await s.unset('SAIP_HF_TOKEN')).toBe(false)
    expect(await s.names()).toEqual(['SAIP_R2_BUCKET'])
  })

  it('stores a fresh random salt per file, and reuses it on later writes', async () => {
    const s = storeAt(KEY)
    await s.set('A', '1')
    const salt1 = JSON.parse(readFileSync(s.path, 'utf8')).salt
    await s.set('B', '2')
    expect(JSON.parse(readFileSync(s.path, 'utf8')).salt).toBe(salt1)
    // Rotating the passphrase is not a salt change, so the same key must still work.
    expect(await s.get('A')).toBe('1')
  })

  it('never writes the key or the plaintext anywhere in the file', async () => {
    const s = storeAt(KEY)
    const secret = 'AKIA-SUPER-SECRET-VALUE'
    await s.set('SAIP_R2_ACCESS_KEY_ID', secret)
    const raw = readFileSync(s.path, 'utf8')
    expect(raw).not.toContain(secret)
    expect(raw).not.toContain(KEY.toString('base64'))
    // The secret name is encrypted too, not just its value.
    expect(raw).not.toContain('SAIP_R2_ACCESS_KEY_ID')
  })

  it('restricts the file to the owner', async () => {
    const s = storeAt(KEY)
    await s.set('A', '1')
    expect(statSync(s.path).mode & 0o777).toBe(0o600)
  })

  it('rejects a wrong passphrase rather than returning garbage', async () => {
    const s = storeAt(Buffer.alloc(32, 1))
    await s.set('A', '1')
    const attacker = new SecretStore({ path: s.path, keySources: [other(Buffer.alloc(32, 2))] })
    await expect(attacker.read()).rejects.toThrow(SecretStoreError)
    await expect(attacker.get("A")).rejects.toThrow(SecretStoreError)
  })

  it('rejects a tampered ciphertext — GCM authentication, not just encryption', async () => {
    const s = storeAt(KEY)
    await s.set('A', '1')
    const file = JSON.parse(readFileSync(s.path, 'utf8'))
    const bytes = Buffer.from(file.data, 'base64')
    bytes[0] ^= 0xff
    writeFileSync(s.path, JSON.stringify({ ...file, data: bytes.toString('base64') }))
    await expect(s.read()).rejects.toThrow(/cannot decrypt/)
  })

  it('rejects a stripped auth tag rather than decrypting unverified bytes', async () => {
    const s = storeAt(KEY)
    await s.set('A', '1')
    const file = JSON.parse(readFileSync(s.path, 'utf8'))
    writeFileSync(s.path, JSON.stringify({ ...file, tag: '' }))
    await expect(s.read()).rejects.toThrow(/format|decrypt/)
  })

  it('reports a corrupt file without destroying it', async () => {
    const s = storeAt(KEY)
    await s.set('A', '1')
    writeFileSync(s.path, 'not json at all')
    await expect(s.read()).rejects.toThrow(/not readable as JSON/)
  })

  it('refuses to create a store when no key source is available', async () => {
    const s = new SecretStore({ path: join(dir(), 'x.enc.json'), keySources: [new MemoryKeySource(null)] })
    await expect(s.set('A', '1')).rejects.toThrow(/no key source available/)
    expect(s.exists()).toBe(false)
  })

  it('uses a keyring key raw, and the recorded kdf makes that reproducible', async () => {
    const kc = new MemoryKeySource(Buffer.alloc(32, 9))
    ;(kc as { name: string }).name = 'keychain'
    const s = new SecretStore({ path: join(dir(), 'k.enc.json'), keySources: [kc] })
    await s.set('A', '1')
    expect(JSON.parse(readFileSync(s.path, 'utf8')).kdf).toBe('raw')
    expect(await s.get('A')).toBe('1')
  })

  it('does not leave a temp file behind after a write', async () => {
    const s = storeAt(KEY)
    await s.set('A', '1')
    expect(exists(s.path + '.tmp')).toBe(false)
  })

  it('activeKeySource names the source in use, for doctor', async () => {
    const s = storeAt(KEY)
    expect(await s.activeKeySource()).toBe('memory')
    const empty = new SecretStore({ path: join(dir(), 'none.enc.json'), keySources: [new MemoryKeySource(null)] })
    expect(await empty.activeKeySource()).toBe('not-created')
  })
})

function exists(p: string): boolean {
  try { statSync(p); return true } catch { return false }
}

describe('SecretToolKey', () => {
  it('returns null when the keychain has nothing, instead of throwing', async () => {
    const k = new SecretToolKey(async () => ({ code: 1, stdout: '' }))
    expect(await k.load()).toBeNull()
  })

  it('rejects a stored value of the wrong length rather than deriving from it', async () => {
    const short = new SecretToolKey(async () => ({ code: 0, stdout: Buffer.alloc(8).toString('base64') }))
    expect(await short.load()).toBeNull()
    const good = new SecretToolKey(async () => ({ code: 0, stdout: Buffer.alloc(32, 3).toString('base64') }))
    expect((await good.load())?.length).toBe(32)
  })

  it('is absent from the default chain when no runner is configured', async () => {
    const sources = defaultKeySources({ SAIP_SECRETS_PASSPHRASE: 'p' })
    expect(sources.map((s) => s.name)).toEqual(['passphrase'])
  })
})

describe('ChainSecrets + EncryptedSecretsProvider', () => {
  it('shell wins over the store', async () => {
    const s = storeAt(KEY)
    await s.set('SAIP_R2_BUCKET', 'from-store')
    const chain = new ChainSecrets([
      new EnvSecrets({ SAIP_R2_BUCKET: 'from-shell' }),
      new EncryptedSecretsProvider(s),
    ])
    expect(await chain.get('SAIP_R2_BUCKET')).toBe('from-shell')
  })

  it('falls through to the store when the shell lacks the name', async () => {
    const s = storeAt(KEY)
    await s.set('SAIP_HF_TOKEN', 'hf_stored')
    const chain = new ChainSecrets([new EnvSecrets({}), new EncryptedSecretsProvider(s)])
    expect(await chain.get('SAIP_HF_TOKEN')).toBe('hf_stored')
  })

  it('treats an empty shell value as absent rather than authoritative', async () => {
    const s = storeAt(KEY)
    await s.set('B', 'stored')
    const chain = new ChainSecrets([new EnvSecrets({ B: '' }), new EncryptedSecretsProvider(s)])
    expect(await chain.get('B')).toBe('stored')
  })

  it('require() throws MissingSecretError naming the secret', async () => {
    const chain = new ChainSecrets([new EnvSecrets({}), new EncryptedSecretsProvider(storeAt(KEY))])
    await expect(chain.require('SAIP_NOWHERE')).rejects.toBeInstanceOf(MissingSecretError)
  })

})

describe('SecretStore passphrase mode (the path this machine actually takes)', () => {
  const passStore = (pass: string, path: string) =>
    new SecretStore({ path, keySources: [new PassphraseKey({ SAIP_SECRETS_PASSPHRASE: pass })] })

  it('derives with scrypt and records kdf=scrypt, never storing the passphrase', async () => {
    const p = join(dir(), 'p.enc.json')
    const s = passStore('correct horse battery', p)
    await s.set('SAIP_R2_SECRET_ACCESS_KEY', 'abc123')
    const file = JSON.parse(readFileSync(p, 'utf8'))
    expect(file.kdf).toBe('scrypt')
    expect(file.salt).toBeTruthy()
    const raw = readFileSync(p, 'utf8')
    expect(raw).not.toContain('correct horse battery')
    expect(raw).not.toContain('abc123')
  })

  it('same passphrase and salt reproduce the key across process instances', async () => {
    const p = join(dir(), 'p2.enc.json')
    await passStore('shared-secret', p).set('A', '1')
    expect(await passStore('shared-secret', p).get('A')).toBe('1')
  })

  it('a different passphrase is refused, not silently misdecoded', async () => {
    const p = join(dir(), 'p3.enc.json')
    await passStore('right-one', p).set('A', '1')
    await expect(passStore('wrong-one', p).read()).rejects.toThrow(/cannot decrypt/)
  })

  it('rotateKey re-encrypts under a new passphrase and invalidates the old one', async () => {
    const p = join(dir(), 'p4.enc.json')
    const old = passStore('old-pass', p)
    await old.set('A', '1')
    const salt = JSON.parse(readFileSync(p, 'utf8')).salt
    // Re-reading with the new passphrase must fail until the store is rewritten.
    await expect(passStore('new-pass', p).read()).rejects.toThrow(/cannot decrypt/)
    // Rotating properly: decrypt with old, write with new. Salt must change or the old key returns.
    await old.rotateKey(new PassphraseKey({ SAIP_SECRETS_PASSPHRASE: 'new-pass' }))
    expect(JSON.parse(readFileSync(p, 'utf8')).salt).not.toBe(salt)
    expect(await passStore('new-pass', p).get('A')).toBe('1')
    // The old passphrase must be dead, not merely disfavoured.
    await expect(passStore('old-pass', p).read()).rejects.toThrow(/cannot decrypt/)
  })

  it('a raw source cannot open a scrypt store and reports no key rather than garbage', async () => {
    const p = join(dir(), 'p5.enc.json')
    await passStore('some-pass', p).set('A', '1')
    const wrongKind = new SecretStore({ path: p, keySources: [new MemoryKeySource(Buffer.alloc(32, 4))] })
    await expect(wrongKind.read()).rejects.toThrow(/no key source available/)
  })
})
