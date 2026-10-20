/**
 * SAIP-managed SSH keypairs (#89) and the closure of #83.
 *
 * The security property under test is not "can we make a key" — it is that private key material
 * never persists where it should not. Generation and storage are easy; the file `ssh` requires is
 * the dangerous part, so every exit path is asserted: success, thrown error, Ctrl+C cancellation,
 * and process teardown.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  generateKeypair, managedKeyName, sshKeyName, publicPath, writePublicKeypair,
  materialiseKey, liveMaterialisedKeys, cleanupMaterialisedKeys, importPrivateKey, sshKeyDir,
} from '../src/lib/ssh-keys.js'
import { sshComposeArgs, SshIdentityMissingError } from '../src/lib/providers/hyperstack.js'
import { SecretStore, MemoryKeySource, PassphraseKey, KeyFileKey } from '@saip/shared'

const dir = () => mkdtempSync(join(tmpdir(), 'saip-ssh-'))
const store = (path: string) => new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 11))] })

afterEach(() => {
  // The process-exit registry must be empty once every test's work is done; a leftover entry
  // means a path where a private key was written is still uncleaned.
  cleanupMaterialisedKeys()
  expect(liveMaterialisedKeys()).toEqual([])
})

describe('key directory follows the store, not the home folder (#89)', () => {
  it('puts public keys beside a relocated SAIP_SECRETS_FILE', async () => {
    const d = dir()
    const saved = process.env.SAIP_SECRETS_FILE
    process.env.SAIP_SECRETS_FILE = join(d, 'sub', 'secrets.enc.json')
    try {
      const kp = generateKeypair('moved')
      const p = await writePublicKeypair(kp, 'moved', sshKeyDir())
      expect(p.startsWith(d)).toBe(true)
      expect(p).toContain(join('sub', 'keys'))
      expect(readFileSync(p, 'utf8')).toMatch(/^ssh-ed25519 /)
    } finally {
      if (saved === undefined) delete process.env.SAIP_SECRETS_FILE; else process.env.SAIP_SECRETS_FILE = saved
    }
  })
})

describe('keypair generation (no ssh-keygen dependency)', () => {
  it('produces a PKCS#8 PEM private key and an OpenSSH wire-format public key', () => {
    const kp = generateKeypair('lab-inference')
    expect(kp.privatePem).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    expect(kp.privatePem).toMatch(/-----END PRIVATE KEY-----/)
    expect(kp.publicOpenSsh).toMatch(/^ssh-ed25519 AAAA/)
    expect(kp.comment).toBe('saip-lab-inference')
  })

  it('round-trips an imported private key to the same public half (used by `saip ssh migrate`)', () => {
    const kp = generateKeypair('m1')
    expect(importPrivateKey(kp.privatePem, 'm1').publicOpenSsh).toBe(kp.publicOpenSsh)
  })

  it('encodes the public key the way OpenSSH parses it: 4-byte length, algorithm, 32 raw bytes', () => {
    const kp = generateKeypair('x')
    const blob = Buffer.from(kp.publicOpenSsh.split(' ')[1], 'base64')
    const alen = blob.readUInt32BE(0)
    expect(alen).toBe(11)
    expect(blob.subarray(4, 4 + alen).toString('utf8')).toBe('ssh-ed25519')
    expect(blob.readUInt32BE(4 + alen)).toBe(32)
    expect(blob.subarray(8 + alen).length).toBe(32)
  })

  it('names are derived from the host and never collide across hosts', () => {
    expect(managedKeyName('cloud-inference')).toBe('SAIP_SSH_KEY_CLOUD_INFERENCE')
    // Deliberate: DNS hostnames are case-insensitive, so 'lab' and 'LAB' are the same host and
    // must get the same key. Asserting otherwise would encode a bug as a requirement.
    expect(managedKeyName('lab')).toBe(managedKeyName('LAB'))
    expect(managedKeyName('a-b')).toBe('SAIP_SSH_KEY_A_B')
    expect(sshKeyName({ ssh: { key_secret: 'MY_OWN' } } as any)).toBe('MY_OWN')
    expect(sshKeyName({ name: 'lab', ssh: {} } as any)).toBe('SAIP_SSH_KEY_LAB')
  })
})

describe('the materialised key never outlives the command', () => {
  it('is readable with the right modes inside the callback and gone after', async () => {
    const kp = generateKeypair('h1')
    let seen: { path: string; mode: number; dirMode: number; matches: boolean } | undefined
    const result = await materialiseKey(kp.privatePem, 'h1', async (path) => {
      seen = {
        path,
        mode: statSync(path).mode & 0o777,
        dirMode: statSync(dirname(path)).mode & 0o777,
        matches: readFileSync(path, 'utf8') === kp.privatePem,
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(seen!.matches).toBe(true)
    expect(seen!.mode).toBe(0o600)
    expect(seen!.dirMode).toBe(0o700)
    expect(existsSync(seen!.path)).toBe(false)
    expect(existsSync(dirname(seen!.path))).toBe(false)
  })

  it('is removed when the command throws — the leak that matters most', async () => {
    const kp = generateKeypair('h2')
    let captured = ''
    await expect(materialiseKey(kp.privatePem, 'h2', async (path) => {
      captured = path
      throw new Error('ssh exited 255')
    })).rejects.toThrow(/ssh exited 255/)
    expect(existsSync(captured)).toBe(false)
    expect(existsSync(dirname(captured))).toBe(false)
  })

  it('is removed when the user presses Ctrl+C mid-command', async () => {
    const kp = generateKeypair('h3')
    let captured = ''
    await expect(materialiseKey(kp.privatePem, 'h3', async (path) => {
      captured = path
      throw new Error('cancelled by user')
    })).rejects.toThrow(/cancelled/)
    expect(existsSync(captured)).toBe(false)
  })

  it('registers live files so process teardown can remove them', async () => {
    const kp = generateKeypair('h5')
    let inner = ''
    const pending = materialiseKey(kp.privatePem, 'h5', async (p) => { inner = p; await new Promise((r) => setTimeout(r, 30)); return 1 })
    await new Promise((r) => setTimeout(r, 10))
    expect(liveMaterialisedKeys()).toContain(inner)
    await pending
    expect(liveMaterialisedKeys()).toEqual([])
  })

  it('never writes key material to the store path or the public directory', async () => {
    const d = dir()
    const kp = generateKeypair('h6')
    const sp = join(d, 'keys', 'secrets.enc.json')
    const s = store(sp)
    await s.set(managedKeyName('h6'), kp.privatePem)
    const keysDir = join(d, 'keys')
    await writePublicKeypair(kp, 'h6', keysDir)
    const files = readdirSync(keysDir).filter((f) => !f.endsWith('.enc.json'))
    for (const f of files) {
      expect(f).toMatch(/\.pub$/)
      expect(readFileSync(join(keysDir, f), 'utf8')).not.toMatch('BEGIN PRIVATE KEY')
    }
    expect(readFileSync(publicPath('h6', keysDir), 'utf8')).toBe(kp.publicOpenSsh + '\n')
  })
})

describe('#83 closure: ssh receives a real identity path, not a secret name', () => {
  it('builds -i with the resolved path and never mentions /run/secrets', () => {
    const host = { name: 'h', kind: 'hyperstack', role: 'inference', ssh: { host: '203.0.113.10', user: 'ubuntu', key_secret: 'SAIP_SSH_KEY_H' } } as any
    const [[cmd, args]] = sshComposeArgs(host, 'up', '/tmp/x/id_ed25519')
    expect(cmd).toBe('ssh')
    expect(args).toContain('-i')
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/x/id_ed25519')
    expect(JSON.stringify(args)).not.toContain('/run/secrets')
  })

  it('refuses to run keyless ssh rather than inventing a /run/secrets path', () => {
    const host = { name: 'h', kind: 'hyperstack', role: 'inference', ssh: { host: 'h', user: 'ubuntu' } } as any
    expect(() => sshComposeArgs(host, 'down')).toThrow(SshIdentityMissingError)
    expect(() => sshComposeArgs(host, 'down')).toThrow(/saip ssh generate --host h/)
  })
})
