/**
 * Encrypted local secret store.
 *
 * EnvSecrets was the only SecretsProvider, so credentials had to be exported into a shell (lost
 * at logout, visible to ps, shell history, and CI logs) or interpolated into saip.yaml (a file the
 * project and its agents read). This puts them in neither.
 *
 * The boundary is modest and stated precisely: workspace file access alone is not enough to read
 * these values. Neither ciphertext nor key lives in the repo. It is NOT a claim that a process
 * running as you cannot reach your keyring -- inside a desktop session it generally can, which is
 * what a keyring is for. Headless SSH often cannot reach the session bus, so the passphrase source
 * is a first-class mode, not a degraded fallback.
 *
 * Two rules follow from the threat model rather than the feature:
 *  - Never a key file beside the ciphertext. That protects nothing: whoever reads one reads both.
 *    A key source is real, or resolution fails loudly.
 *  - AES-256-GCM, not encryption alone. A tampered store must be an error, never a subtly wrong
 *    secret that surfaces later as an unexplained provider 403.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { MissingSecretError, EnvSecrets, type SecretsProvider } from './hosting.js'

const CIPHER = 'aes-256-gcm'
const KEY_BYTES = 32
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

interface StoreFile {
  v: 1
  kdf: 'scrypt' | 'raw'
  salt?: string
  iv: string
  tag: string
  data: string
}

/** Where the 32-byte key comes from. Implementations never write a keyfile. */
export interface KeySource {
  readonly name: string
  /**
   * How the returned secret becomes a key. Declared rather than inferred from `name`, because
   * matching on a string like 'passphrase' silently mis-keys anything with a different label —
   * which is exactly what a test double hit.
   */
  readonly mode: 'raw' | 'passphrase'
  /** The key, or null when this source is unavailable on this machine. */
  load(): Promise<Buffer | null>
  /** Persist a freshly generated key, for sources that can store one. */
  save?(key: Buffer): Promise<void>
}

/** Runs the libsecret CLI: secret-tool lookup|store attrs, value on stdin for store. */
export type SecretToolRunner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>

/**
 * OS keychain via secret-tool. Probed, never assumed: this project's own development host runs
 * gnome-keyring but has no secret-tool binary, so code assuming it would crash on the machine it
 * was written on. load() returns null when unavailable and the chain moves on.
 */
export class SecretToolKey implements KeySource {
  readonly name = 'keychain'
  readonly mode = 'raw' as const
  private static readonly ATTRS = ['service', 'saip', 'label', 'SAIP secret store key']
  constructor(private readonly run: SecretToolRunner) {}

  async load(): Promise<Buffer | null> {
    const r = await this.run(['lookup', ...SecretToolKey.ATTRS]).catch(() => ({ code: 1, stdout: '' }))
    if (r.code !== 0) return null
    const key = Buffer.from((r.stdout || '').trim(), 'base64')
    return key.length === KEY_BYTES ? key : null
  }

  async save(key: Buffer): Promise<void> {
    await this.run(['store', ...SecretToolKey.ATTRS], key.toString('base64'))
  }
}

/**
 * Passphrase-derived key. SAIP_SECRETS_PASSPHRASE serves CI and headless runs; the prompt is for a
 * human at a terminal. Returns null when neither exists rather than guessing.
 */
export class PassphraseKey implements KeySource {
  readonly name = 'passphrase'
  readonly mode = 'passphrase' as const
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly prompt?: (question: string) => Promise<string>,
  ) {}

  async load(): Promise<Buffer | null> {
    const v = this.env.SAIP_SECRETS_PASSPHRASE
    if (v) return Buffer.from(v, 'utf8')
    if (!this.prompt) return null
    const entered = await this.prompt('SAIP secret store passphrase: ')
    return entered ? Buffer.from(entered, 'utf8') : null
  }
}

/** Test/embedding double, keeping the suite free of keychains and TTYs. */
export class MemoryKeySource implements KeySource {
  readonly name = 'memory'
  constructor(public key: Buffer | null = null, public readonly mode: 'raw' | 'passphrase' = 'raw') {}
  async load(): Promise<Buffer | null> { return this.key }
  async save(key: Buffer): Promise<void> { this.key = key }
}

/** Default chain: keychain if a runner was given, then passphrase. Never a keyfile. */
export function defaultKeySources(
  env: NodeJS.ProcessEnv = process.env,
  prompt?: (q: string) => Promise<string>,
  toolRunner?: SecretToolRunner,
): KeySource[] {
  const sources: KeySource[] = []
  if (toolRunner) sources.push(new SecretToolKey(toolRunner))
  sources.push(new PassphraseKey(env, prompt))
  return sources
}

export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SAIP_SECRETS_FILE || `${homedir()}/.saip/secrets.enc.json`
  return raw.replace(/^~/, homedir())
}

/** Raised for a wrong passphrase, a modified file, or no usable key source. */
export class SecretStoreError extends Error {
  readonly name = 'SecretStoreError'
}

export interface SecretStoreOptions {
  path?: string
  /** Candidates in preference order; the first that yields a key wins. */
  keySources?: KeySource[]
}

/**
 * The whole store is one encrypted JSON map. Single-record encryption keeps the format small and
 * also hides which secret *names* exist, and it is edited through one CLI by one user, so the
 * read-modify-write cost is not worth a per-record layout. Writes are atomic (tmp + rename, mode
 * 0600) so a torn write cannot destroy the file.
 */
export class SecretStore {
  readonly path: string
  private readonly keySources: KeySource[]

  constructor(opts: SecretStoreOptions = {}) {
    this.path = opts.path ?? defaultStorePath()
    this.keySources = opts.keySources?.length ? opts.keySources : defaultKeySources()
  }

  exists(): boolean { return existsSync(this.path) }

  /** Which key source is usable here. Surfaced by `saip config doctor`. */
  async activeKeySource(): Promise<string> {
    for (const s of this.keySources) if (await s.load()) return s.name
    return this.exists() ? 'none-available' : 'not-created'
  }

  async names(): Promise<string[]> { return Object.keys(await this.read()).sort() }

  async get(name: string): Promise<string | undefined> { return (await this.read())[name] }

  async set(name: string, value: string): Promise<void> {
    const map = await this.read()
    map[name] = value
    await this.write(map)
  }

  /**
   * Re-encrypt the store under a different key source (passphrase rotation, or moving a passphrase
   * store onto the OS keychain). Requires the CURRENT key to read, so it cannot be used to bypass a
   * lost passphrase -- it is a rotation, not recovery.
   */
  async rotateKey(next: KeySource): Promise<void> {
    const map = await this.read()
    const after = new SecretStore({ path: this.path, keySources: [next] })
    await after.write(map, true)
  }

  async unset(name: string): Promise<boolean> {
    const map = await this.read()
    if (!(name in map)) return false
    delete map[name]
    await this.write(map)
    return true
  }

  /** Decrypt the whole store. An absent file is an empty store, not an error. */
  async read(): Promise<Record<string, string>> {
    if (!this.exists()) return {}
    let file: StoreFile
    try { file = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile }
    catch { throw new SecretStoreError(`secret store is not readable as JSON: ${this.path}`) }
    if (file?.v !== 1 || !file.iv || !file.tag || !file.data || !file.salt) {
      throw new SecretStoreError(`unexpected secret store format: ${this.path}`)
    }
    const key = await this.deriveKey(file)
    if (!key) {
      throw new SecretStoreError(
        `no key source available for ${this.path}. Set SAIP_SECRETS_PASSPHRASE, or install ` +
        `secret-tool (libsecret) to use the OS keychain. A key file is deliberately never stored ` +
        `beside the ciphertext, because whoever reads one can read both.`,
      )
    }
    try {
      const d = createDecipheriv(CIPHER, key, Buffer.from(file.iv, 'base64'))
      d.setAuthTag(Buffer.from(file.tag, 'base64'))
      const plain = Buffer.concat([d.update(Buffer.from(file.data, 'base64')), d.final()])
      return JSON.parse(plain.toString('utf8')) as Record<string, string>
    } catch {
      // One message for both causes: distinguishing a wrong passphrase from a modified file would
      // make this an oracle for testing guesses.
      throw new SecretStoreError(
        `cannot decrypt ${this.path}: wrong passphrase, or the file changed since it was written`,
      )
    }
  }

  /**
   * scrypt over the passphrase, salted by a per-store random salt persisted in the file. The key is
   * never written. N=2^15 is a few tens of milliseconds: enough to make guessing expensive, low
   * enough that a CLI invocation stays responsive.
   */
  /**
   * Rebuilds the key the same way the file says it was made. Reading `kdf` rather than
   * re-guessing matters: a keyring key is used raw, and running it through scrypt would decrypt to
   * nothing and report a wrong passphrase.
   */
  private async deriveKey(file: StoreFile): Promise<Buffer | null> {
    if (file.kdf === 'raw') {
      for (const source of this.keySources) {
        if (source.mode !== 'raw') continue
        const raw = await source.load()
        if (raw && raw.length === KEY_BYTES) return raw
      }
      return null
    }
    for (const source of this.keySources) {
      if (source.mode !== 'passphrase') continue
      const secret = await source.load()
      if (secret) return scryptSync(secret, Buffer.from(file.salt ?? '', 'base64'), KEY_BYTES, SCRYPT_OPTS)
    }
    return null
  }

  private async write(map: Record<string, string>, forceNewSalt = false): Promise<void> {
    let salt: Buffer
    if (this.exists() && !forceNewSalt) {
      // Reuse the existing salt so the same passphrase keeps deriving the same key.
      salt = Buffer.from((JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile).salt ?? '', 'base64')
      if (salt.length === 0) salt = randomBytes(16)
    } else {
      // Fresh salt on create and on rotation: without it the old passphrase would keep deriving
      // the same key even after the file was rewritten.
      salt = randomBytes(16)
    }
    let key: Buffer | null = null
    let kdf: StoreFile['kdf'] = 'scrypt'
    for (const source of this.keySources) {
      if (source.mode !== 'raw') continue
      const raw = await source.load()
      if (raw && raw.length === KEY_BYTES) { key = raw; kdf = 'raw'; break }
    }
    if (!key) {
      for (const source of this.keySources) {
        if (source.mode !== 'passphrase') continue
        const secret = await source.load()
        if (secret) { key = scryptSync(secret, salt, KEY_BYTES, SCRYPT_OPTS); break }
      }
    }
    if (!key) {
      throw new SecretStoreError(
        `cannot create ${this.path}: no key source available. Set SAIP_SECRETS_PASSPHRASE or ` +
        `install secret-tool (libsecret).`,
      )
    }
    const iv = randomBytes(12)
    const c = createCipheriv(CIPHER, key, iv)
    const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(map), 'utf8')), c.final()])
    const file: StoreFile = {
      v: 1,
      kdf,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      data: enc.toString('base64'),
    }
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.path)
  }
}

/**
 * SecretsProvider over the store. Missing values are `undefined` from `get` and a
 * `MissingSecretError` from `require`, matching EnvSecrets exactly so the chain can mix providers
 * without special cases.
 */
export class EncryptedSecretsProvider implements SecretsProvider {
  constructor(private readonly store: SecretStore = new SecretStore()) {}
  async get(name: string): Promise<string | undefined> { return this.store.get(name) }
  async require(name: string): Promise<string> {
    const v = await this.store.get(name)
    if (v === undefined || v === '') throw new MissingSecretError(name)
    return v
  }
}

/**
 * Resolution chain, highest priority first. Documented order is shell, then .env (which the config
 * loader folds into the environment), then the store. `ChainSecrets` treats an empty string as
 * absent, matching the interpolation rule: an empty credential elsewhere becomes an opaque 403
 * far from its cause.
 */
export class ChainSecrets implements SecretsProvider {
  constructor(private readonly providers: SecretsProvider[]) {}
  async get(name: string): Promise<string | undefined> {
    for (const p of this.providers) {
      const v = await p.get(name)
      if (v !== undefined && v !== '') return v
    }
    return undefined
  }
  async require(name: string): Promise<string> {
    const v = await this.get(name)
    if (v === undefined) throw new MissingSecretError(name)
    return v
  }
}

/** The default provider for every package: process environment, then the encrypted store. */
export function defaultSecretsProvider(
  env: NodeJS.ProcessEnv = process.env,
  storeOpts: SecretStoreOptions = {},
): SecretsProvider {
  return new ChainSecrets([new EnvSecrets(env), new EncryptedSecretsProvider(new SecretStore(storeOpts))])
}
