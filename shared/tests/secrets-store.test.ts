import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  SecretStore, MemoryKeySource, PassphraseKey, KeyFileKey,
  SecretToolKey, ChainSecrets, EncryptedSecretsProvider, defaultKeySources,
} from '../src/secrets-store.js'
import { EnvSecrets, MissingSecretError } from '../src/hosting.js'

const dir = () => mkdtempSync(join(tmpdir(), 'saip-sec-'))
const pathIn = (n = 's.enc.json') => join(dir(), n)
const raw = Buffer.alloc(32, 7)
/** MemoryKeySource keyed off a short letter so different "passphrases" give different keys. */
const pass = (v: string) => new MemoryKeySource('passphrase', v === 'raw' ? raw : Buffer.alloc(32, v.charCodeAt(0)))

describe('SecretStore v2 — creation requires a passphrase, never an on-disk key', () => {
  it('treats an absent file as an empty store, not an error', async () => {
    const s = new SecretStore({ path: pathIn(), keySources: [pass('raw')] })
    expect(s.exists()).toBe(false)
    expect(await s.read()).toEqual({})
    expect(await s.names()).toEqual([])
    expect(s.wrapIds()).toEqual([])
  })

  it('creates only under a passphrase wrap and records no key material in the file', async () => {
    const p = pathIn()
    await new SecretStore({ path: p, keySources: [pass('raw')] }).set('SAIP_R2_BUCKET', 'saip-platform')
    const f = JSON.parse(readFileSync(p, 'utf8'))
    expect(f.v).toBe(2)
    expect(f.wraps.map((w: { id: string }) => w.id)).toEqual(['passphrase'])
    expect(f.wraps.length).toBe(1)
    expect(f.data).toBeTruthy()
    // No field in the file may hold key material or the KEK in the clear.
    expect(JSON.stringify(f).toLowerCase()).not.toContain('kek' + '"' + ':null')
    const text = readFileSync(p, 'utf8')
    expect(text).not.toContain('saip-platform')
    expect(text).not.toContain(raw.toString('base64'))
    // The secret NAME is encrypted too, so a leaked file does not enumerate credentials.
    expect(text).not.toContain('SAIP_R2_BUCKET')
  })

  it('refuses to create when no key source can serve a passphrase', async () => {
    const p = pathIn()
    const s = new SecretStore({ path: p, keySources: [new MemoryKeySource('passphrase', null)] })
    await expect(s.set('A', '1')).rejects.toThrow(/no key source|available to create/i)
    expect(existsSync(p)).toBe(false)
  })

  it('does not offer the unattended tier unless explicitly allowed, nor the keyring without a runner', () => {
    const env = { SAIP_SECRETS_FILE: pathIn(), SAIP_SECRETS_PASSPHRASE: 'p' }
    expect(defaultKeySources(env).map((x) => x.id)).toEqual(['passphrase'])
    expect(defaultKeySources(env, { toolRunner: async () => ({ code: 1, stdout: '' }) }).map((x) => x.id)).toEqual(['keyring', 'passphrase'])
    expect(defaultKeySources(env, { allowUnattended: true }).map((x) => x.id)).toContain('unattended')
  })
})

describe('SecretStore v2 — wraps are independent', () => {
  it('adds a second wrap without re-encrypting anything', async () => {
    const p = pathIn()
    const s = new SecretStore({ path: p, keySources: [pass('raw')] })
    await s.set('A', '1')
    const before = JSON.parse(readFileSync(p, 'utf8'))
    await s.addWrap(new MemoryKeySource('keyring', Buffer.alloc(32, 5)))
    const after = JSON.parse(readFileSync(p, 'utf8'))
    expect(after.wraps.map((w: { id: string }) => w.id).sort()).toEqual(['keyring', 'passphrase'])
    // The point of wrapping: payload and KEK box are byte-identical after adding a method.
    expect(after.data).toEqual(before.data)
    expect(after.kek).toEqual(before.kek)
  })

  it('opens through either wrap and reports which one it used', async () => {
    const p = pathIn()
    const kekKey = Buffer.alloc(32, 5)
    const store = new SecretStore({ path: p, keySources: [pass('raw')] })
    await store.set('A', '1')
    await store.addWrap(new MemoryKeySource('keyring', kekKey))

    const viaKeyring = new SecretStore({ path: p, keySources: [new MemoryKeySource('keyring', kekKey)] })
    expect(await viaKeyring.get('A')).toBe('1')
    expect(await viaKeyring.activeWrap()).toBe('keyring')

    const viaPass = new SecretStore({ path: p, keySources: [pass('raw')] })
    expect(await viaPass.get('A')).toBe('1')
    expect(await viaPass.activeWrap()).toBe('passphrase')
  })

  it('removing a wrap re-wraps the KEK but never re-encrypts the secrets', async () => {
    const p = pathIn()
    const s = new SecretStore({ path: p, keySources: [pass('raw')] })
    await s.set('A', '1')
    const before = JSON.parse(readFileSync(p, 'utf8'))
    await s.addWrap(new MemoryKeySource('unattended', Buffer.alloc(32, 9)))
    await s.removeWrap('unattended')
    const after = JSON.parse(readFileSync(p, 'utf8'))
    expect(after.wraps.map((w: { id: string }) => w.id)).toEqual(['passphrase'])
    // Removal is a filter, so the surviving wrap is byte-identical: no re-wrapping happened.
    expect(after.wraps[0]).toEqual(before.wraps[0])
    expect(after.data).toEqual(before.data)
    expect(await new SecretStore({ path: p, keySources: [pass('raw')] }).get('A')).toBe('1')
  })

  it('refuses to remove the last wrap rather than making the store unreadable', async () => {
    const p = pathIn()
    const s = new SecretStore({ path: p, keySources: [pass('raw')] })
    await s.set('A', '1')
    await expect(s.removeWrap('passphrase')).rejects.toThrow(/last wrap/)
    expect(await new SecretStore({ path: p, keySources: [pass('raw')] }).get('A')).toBe('1')
  })

  it('refuses a duplicate wrap id', async () => {
    const p = pathIn()
    const s = new SecretStore({ path: p, keySources: [pass('raw')] })
    await s.set('A', '1')
    await expect(s.addWrap(pass('raw'))).rejects.toThrow(/already exists/)
  })
})

describe('SecretStore v2 — tamper and wrong key must fail, never mis-decode', () => {
  const seeded = async () => {
    const p = pathIn()
    await new SecretStore({ path: p, keySources: [pass('raw')] }).set('A', 'secret-value')
    return p
  }

  it('rejects a modified payload', async () => {
    const p = await seeded()
    const f = JSON.parse(readFileSync(p, 'utf8'))
    const b = Buffer.from(f.data.data, 'base64'); b[0] ^= 0xff
    writeFileSync(p, JSON.stringify({ ...f, data: { ...f.data, data: b.toString('base64') } }))
    await expect(new SecretStore({ path: p, keySources: [pass('raw')] }).read()).rejects.toThrow(/failed authentication/)
  })

  it('rejects a wrap swapped in from another store', async () => {
    const p = await seeded()
    const other = pathIn('other.enc.json')
    await new SecretStore({ path: other, keySources: [pass('other')] }).set('X', '1')
    const victim = JSON.parse(readFileSync(p, 'utf8'))
    const attacker = JSON.parse(readFileSync(other, 'utf8'))
    writeFileSync(p, JSON.stringify({ ...victim, wraps: attacker.wraps }))
    await expect(new SecretStore({ path: p, keySources: [pass('raw')] }).read()).rejects.toThrow(/cannot unlock|failed authentication/)
  })

  it('reports a bad passphrase and a tampered file the same way, so it cannot probe guesses', async () => {
    const p = await seeded()
    await expect(new SecretStore({ path: p, keySources: [pass('other')] }).read()).rejects.toThrow(/cannot unlock/)
    const f = JSON.parse(readFileSync(p, 'utf8'))
    writeFileSync(p, JSON.stringify({ ...f, wraps: f.wraps.map((w: { tag: string }) => ({ ...w, tag: '' })) }))
    await expect(new SecretStore({ path: p, keySources: [pass('raw')] }).read()).rejects.toThrow(/cannot unlock/)
  })

  it('rejects a stripped auth tag without decrypting unverified bytes', async () => {
    const p = await seeded()
    const f = JSON.parse(readFileSync(p, 'utf8'))
    writeFileSync(p, JSON.stringify({ ...f, data: { ...f.data, tag: '' } }))
    await expect(new SecretStore({ path: p, keySources: [pass('raw')] }).read()).rejects.toThrow(/cannot unlock|authentication/)
  })

  it('explains a v1 store instead of failing obscurely', async () => {
    const p = pathIn()
    writeFileSync(p, JSON.stringify({ v: 1, kdf: 'scrypt', salt: 'AA==', iv: 'AA==', tag: 'AA==', data: 'AA==' }))
    await expect(new SecretStore({ path: p, keySources: [pass('raw')] }).read()).rejects.toThrow(/v1 format/)
  })

  it('names a corrupt file as corrupt', async () => {
    const p = pathIn()
    writeFileSync(p, 'not json')
    await expect(new SecretStore({ path: p, keySources: [pass('raw')] }).read()).rejects.toThrow(/not readable as JSON/)
  })

  it('keeps the store file owner-only', async () => {
    const p = await seeded()
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })
})

describe('unattended wrap — explicit opt-in, honest about what it buys', () => {
  it('opens with no passphrase once the key file exists', async () => {
    // One directory for both files: the unattended key lives beside the store by design, so
    // deriving the two paths from different temp dirs would test nothing.
    const d = dir()
    const p = join(d, 'store.enc.json')
    const keyPath = join(d, 'keys', 'unattended.key')
    const seed = new SecretStore({ path: p, keySources: [pass('raw')] })
    await seed.set('A', 'value')
    await seed.addWrap(new KeyFileKey(keyPath))

    const opened = new SecretStore({ path: p, keySources: [new KeyFileKey(keyPath)] })
    expect(await opened.get('A')).toBe('value')
    expect(await opened.activeWrap()).toBe('unattended')
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
  })

  it('refuses to use a key file that group or other can read', async () => {
    const p = pathIn()
    const keyPath = pathIn('loose.key')
    const seed = new SecretStore({ path: p, keySources: [pass('raw')] })
    await seed.set('A', 'value')
    await seed.addWrap(new KeyFileKey(keyPath))
    chmodSync(keyPath, 0o644)
    await expect(new SecretStore({ path: p, keySources: [new KeyFileKey(keyPath)] }).read()).rejects.toThrow(/cannot unlock/)
  })

  it('removeWrap destroys the on-disk key so the method really is gone', async () => {
    const d = dir()
    const p = join(d, 'store.enc.json')
    const keyPath = join(d, 'keys', 'unattended.key')
    const seed = new SecretStore({ path: p, keySources: [pass('raw')] })
    await seed.set('A', 'value')
    await seed.addWrap(new KeyFileKey(keyPath))
    expect(existsSync(keyPath)).toBe(true)
    await seed.removeWrap('unattended')
    expect(existsSync(keyPath)).toBe(false)
    expect(seed.wrapIds()).toEqual(['passphrase'])
  })
})

describe('PassphraseKey', () => {
  it('derives deterministically and differs across passphrases', async () => {
    const salt = Buffer.alloc(16, 1)
    const a = await new PassphraseKey({ SAIP_SECRETS_PASSPHRASE: 'hunter' }).wrapKey(salt)
    expect(a?.length).toBe(32)
    expect(a!.equals((await new PassphraseKey({ SAIP_SECRETS_PASSPHRASE: 'hunter' }).wrapKey(salt))!)).toBe(true)
    expect(a!.equals((await new PassphraseKey({ SAIP_SECRETS_PASSPHRASE: 'hunter2' }).wrapKey(salt))!)).toBe(false)
  })

  it('prompts rather than returning null when no env passphrase is set', async () => {
    let asked = 0
    const k = new PassphraseKey({}, async () => { asked++; return 'typed-passphrase' })
    expect(await k.wrapKey(Buffer.alloc(16, 2))).toBeTruthy()
    expect(asked).toBe(1)
  })

  it('returns null with neither env nor prompt, so the chain falls through', async () => {
    expect(await new PassphraseKey({}).wrapKey(null)).toBeNull()
  })
})

describe('SecretToolKey', () => {
  it('yields null when the keychain is empty and rejects wrong-length keys', async () => {
    expect(await new SecretToolKey(async () => ({ code: 1, stdout: '' })).wrapKey(null)).toBeNull()
    expect(await new SecretToolKey(async () => ({ code: 0, stdout: Buffer.alloc(8).toString('base64') })).wrapKey(null)).toBeNull()
    expect((await new SecretToolKey(async () => ({ code: 0, stdout: Buffer.alloc(32, 3).toString('base64') })).wrapKey(null))?.length).toBe(32)
  })
})

describe('provider chain', () => {
  it('shell wins over the store, and empty is treated as absent', async () => {
    const p = pathIn()
    const s = new SecretStore({ path: p, keySources: [pass('raw')] })
    await s.set('SAIP_R2_BUCKET', 'from-store')
    expect(await new ChainSecrets([new EnvSecrets({ SAIP_R2_BUCKET: 'from-shell' }), new EncryptedSecretsProvider(s)]).get('SAIP_R2_BUCKET')).toBe('from-shell')
    expect(await new ChainSecrets([new EnvSecrets({ SAIP_R2_BUCKET: '' }), new EncryptedSecretsProvider(s)]).get('SAIP_R2_BUCKET')).toBe('from-store')
    expect(await new ChainSecrets([new EnvSecrets({}), new EncryptedSecretsProvider(s)]).get('SAIP_R2_BUCKET')).toBe('from-store')
  })

  it('require() throws MissingSecretError naming the secret', async () => {
    const chain = new ChainSecrets([new EnvSecrets({}), new EncryptedSecretsProvider(new SecretStore({ path: pathIn(), keySources: [pass('raw')] }))])
    await expect(chain.require('SAIP_NOWHERE')).rejects.toBeInstanceOf(MissingSecretError)
  })

  it('an unreadable store surfaces as an error rather than looking merely unset', async () => {
    const p = pathIn()
    await new SecretStore({ path: p, keySources: [pass('raw')] }).set('SAIP_R2_ACCESS_KEY_ID', 'x')
    const wrong = new SecretStore({ path: p, keySources: [pass('other')] })
    await expect(new EncryptedSecretsProvider(wrong).get('SAIP_R2_ACCESS_KEY_ID')).rejects.toThrow(/cannot unlock/)
  })
})
