/**
 * Encrypted local secret store — wrapped-KEK design.
 *
 * `EnvSecrets` was once the only SecretsProvider, so credentials had to be exported into a
 * shell (lost at logout, visible in `ps`, shell history and CI logs) or interpolated into
 * saip.yaml (a file the project and its agents read). This puts them in neither.
 *
 * Cryptography is entirely `node:crypto` — there is no external crypto dependency to bundle.
 * What genuinely cannot be bundled is an OS credential store, because Node has no D-Bus or
 * SecurityFoundation client in core; reaching a keychain always goes through something outside
 * the process. That is why the passphrase tier is primary and always reachable, and the keyring
 * is probed hardening rather than a requirement.
 *
 * Shape: a random 32-byte KEK encrypts the secret map. The KEK is never stored — it is saved
 * once per unlock method, wrapped under that method's own key. Consequences that matter:
 *  - adding or removing an unlock method re-wraps the KEK and touches no secret, so rotating a
 *    passphrase is O(1) and never re-encrypts values;
 *  - GCM authentication on the wrapped KEK is itself the passphrase check, so there is no
 *    password hash or verifier sitting around to leak or be attacked offline separately;
 *  - unlocking tries each wrap in order, so a machine can carry a keyring wrap and still open
 *    with the passphrase after the keyring disappears.
 *
 * Threat model, stated narrowly and honestly: workspace file access alone is not enough to read
 * these values. A process running as you, with read access to your home directory, is NOT
 * excluded — and the opt-in `unattended` wrap is explicitly weaker, defending only the
 * repo-scoped reader and other users. `doctor` reports which wrap unlocked so nobody has to
 * guess which guarantee is currently in force.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { MissingSecretError, EnvSecrets, type SecretsProvider } from './hosting.js'

const CIPHER = 'aes-256-gcm'
const KEY_BYTES = 32
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

export type WrapId = 'passphrase' | 'keyring' | 'unattended'

interface Gcm { iv: string; tag: string; data: string }
interface WrapRecord extends Gcm { id: WrapId; salt?: string }

interface StoreFileV2 {
  v: 2
  /** Each wrap holds the KEK sealed under that method's own key — there is no separate KEK box. */
  wraps: WrapRecord[]
  data: Gcm
}

/** Anything able to supply a 32-byte key that wraps the KEK. */
export interface KeySource {
  readonly id: WrapId
  /**
   * Key for this wrap. `salt` is the per-wrap salt from the file for passphrase-style sources;
   * sources holding a raw key ignore it. Null means "this method cannot unlock right now",
   * which lets the store fall through to the next wrap instead of failing.
   */
  wrapKey(salt: Buffer | null): Promise<Buffer | null>
  /** Mint a fresh key for a new wrap, returning the salt to persist alongside it. */
  provision?(): Promise<{ key: Buffer; salt: Buffer | null }>
}

export type SecretToolRunner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>

/**
 * OS keychain through the libsecret CLI. Probed, never assumed: this project's own
 * development host runs gnome-keyring but has no `secret-tool` binary, so code that assumed
 * it would fail on the machine it was written on. Absent runner means never added.
 */
export class SecretToolKey implements KeySource {
  readonly id = 'keyring' as const
  private static readonly ATTRS = ['service', 'saip', 'label', 'SAIP KEK wrap key']
  constructor(private readonly run: SecretToolRunner) {}

  async wrapKey(): Promise<Buffer | null> {
    const r = await this.run(['lookup', ...SecretToolKey.ATTRS]).catch(() => ({ code: 1, stdout: '' }))
    if (r.code !== 0) return null
    const key = Buffer.from((r.stdout || '').trim(), 'base64')
    return key.length === KEY_BYTES ? key : null
  }

  async provision(): Promise<{ key: Buffer; salt: Buffer | null }> {
    const key = randomBytes(KEY_BYTES)
    await this.run(['store', ...SecretToolKey.ATTRS], key.toString('base64')).catch(() => ({ code: 1, stdout: '' }))
    return { key, salt: null }
  }
}

/**
 * The always-available tier. `SAIP_SECRETS_PASSPHRASE` exists for CI and headless runs, and is
 * deliberately the weaker form of this tier: an environment variable holding the thing meant to
 * resist environment inspection. Interactive use should leave it unset and let the prompt run.
 */
export class PassphraseKey implements KeySource {
  readonly id = 'passphrase' as const
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly prompt?: (question: string) => Promise<string>,
  ) {}

  private async secret(): Promise<string | null> {
    const v = this.env.SAIP_SECRETS_PASSPHRASE
    if (v) return v
    return this.prompt ? this.prompt('SAIP secret store passphrase: ') : null
  }

  async wrapKey(salt: Buffer | null): Promise<Buffer | null> {
    const s = await this.secret()
    if (!s) return null
    return scryptSync(s, salt ?? Buffer.alloc(16), KEY_BYTES, SCRYPT_OPTS)
  }

  async provision(): Promise<{ key: Buffer; salt: Buffer | null }> {
    const s = await this.secret()
    if (!s) throw new SecretStoreError('a passphrase is required to create a secret store; set it interactively rather than storing a key on disk')
    const salt = randomBytes(16)
    return { key: scryptSync(s, salt, KEY_BYTES, SCRYPT_OPTS), salt }
  }
}

/**
 * Opt-in convenience tier: the wrap key lives in a 0600 file outside the workspace. This is
 * included honestly, not glossed over — cryptographically it is close to storing the KEK on
 * disk, and it defends the repo-scoped reader and other users, NOT a process running as you.
 * Never created implicitly; `doctor` warns while it exists.
 */
export class KeyFileKey implements KeySource {
  readonly id = 'unattended' as const
  constructor(private readonly path: string = defaultKeyfilePath()) {}

  // Signature matches KeySource; an on-disk key ignores the salt entirely.
  async wrapKey(_salt: Buffer | null): Promise<Buffer | null> {
    if (!existsSync(this.path)) return null
    if ((statSync(this.path).mode & 0o077) !== 0) return null   // group/other-readable key: refuse to use it
    const key = Buffer.from(readFileSync(this.path, 'utf8').trim(), 'base64')
    return key.length === KEY_BYTES ? key : null
  }

  async provision(): Promise<{ key: Buffer; salt: Buffer | null }> {
    const existing = await this.wrapKey(null)
    if (existing) return { key: existing, salt: null }
    const key = randomBytes(KEY_BYTES)
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, key.toString('base64'), { mode: 0o600 })
    chmodSync(this.path, 0o600)
    return { key, salt: null }
  }

  /** Explicit removal, for `saip config key remove unattended`. */
  destroy(): void { try { unlinkSync(this.path) } catch { /* already gone */ } }
}

/** Test/embedding double, so CI needs no keychain, no TTY and no home directory. */
export class MemoryKeySource implements KeySource {
  constructor(public readonly id: WrapId = 'passphrase', public key: Buffer | null = null, public prompt?: (q: string) => Promise<string>) {}
  async wrapKey(): Promise<Buffer | null> {
    if (this.key) return this.key
    if (this.id === 'passphrase' && this.prompt) {
      const s = await this.prompt('x')
      return s ? scryptSync(s, Buffer.alloc(16), KEY_BYTES, SCRYPT_OPTS) : null
    }
    return null
  }
  async provision(): Promise<{ key: Buffer; salt: Buffer | null }> {
    // Mirrors a real source: with no key available it cannot provision, so store creation
    // fails rather than silently minting a key nobody can reproduce.
    if (!this.key) throw new Error('no key available to create a secret store')
    return { key: this.key, salt: null }
  }
}

export function defaultKeyfilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultStorePath(env)), 'keys', 'unattended.key')
}

/** Sources in preference order; keyring only when a runner was actually supplied. */
export function defaultKeySources(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    prompt?: (q: string) => Promise<string>
    toolRunner?: SecretToolRunner
    allowUnattended?: boolean
    /**
     * Store this source list is for. The unattended key file must sit beside THAT store:
     * deriving it from the environment alone silently breaks any store relocated with
     * `SAIP_SECRETS_FILE` or an injected path, because the wrap exists but its key is looked
     * for in the default home directory and never found.
     */
    storePath?: string
  } = {},
): KeySource[] {
  const sources: KeySource[] = []
  if (opts.toolRunner) sources.push(new SecretToolKey(opts.toolRunner))
  sources.push(new PassphraseKey(env, opts.prompt))
  if (opts.allowUnattended) sources.push(new KeyFileKey(opts.storePath ? join(dirname(opts.storePath), 'keys', 'unattended.key') : defaultKeyfilePath(env)))
  return sources
}

export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SAIP_SECRETS_FILE || join(homedir(), '.saip', 'secrets.enc.json')
  return raw.replace(/^~/, homedir())
}

export class SecretStoreError extends Error {
  readonly name = 'SecretStoreError'
}

export interface SecretStoreOptions {
  path?: string
  keySources?: KeySource[]
  /** Opt-in only: permits the on-disk `unattended` wrap. Off everywhere by default. */
  allowUnattended?: boolean
  /**
   * Environment for the default key sources and default paths. Without it the store silently
   * reads `process.env`, so a caller that supplied its own env to `defaultSecretsProvider`
   * could build a provider that could not unlock the store it was pointed at.
   */
  env?: NodeJS.ProcessEnv
}

const seal = (key: Buffer, plain: Buffer): Gcm => {
  const iv = randomBytes(12)
  const c = createCipheriv(CIPHER, key, iv)
  const data = Buffer.concat([c.update(plain), c.final()])
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

const open = (key: Buffer, box: Gcm): Buffer | null => {
  try {
    const d = createDecipheriv(CIPHER, key, Buffer.from(box.iv, 'base64'))
    d.setAuthTag(Buffer.from(box.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()])
  } catch {
    return null
  }
}

/**
 * Store v2. The whole secret map is one encrypted blob: hiding which names exist is worth more
 * than per-record granularity, and this file is edited by one user through one CLI. Writes are
 * atomic (tmp + rename, mode 0600) so a torn write cannot destroy it.
 */
export class SecretStore {
  readonly path: string
  private readonly sources: KeySource[]
  /** Which wrap unlocked the KEK most recently — reported by `doctor`. */
  usedWrap?: WrapId

  /** Where an `unattended` wrap key belongs for this store. Follows SAIP_SECRETS_FILE. */
  get unattendedKeyPath(): string { return join(dirname(this.path), 'keys', 'unattended.key') }

  constructor(opts: SecretStoreOptions = {}) {
    const env = opts.env ?? process.env
    this.path = opts.path ?? defaultStorePath(env)
    // No prompt in the library default on purpose: services must never block on a terminal.
    // Interactive prompting belongs to the CLI's buildStore, which supplies its own sources.
    // Threading `env` here is the fix: a caller passing its own environment previously got a
    // store that quietly consulted process.env instead and could not be unlocked.
    this.sources = opts.keySources ?? defaultKeySources(env, { allowUnattended: opts.allowUnattended, storePath: this.path })
  }

  exists(): boolean { return existsSync(this.path) }
  get filePath(): string { return this.path }

  private file(): StoreFileV2 {
    if (!this.exists()) throw new SecretStoreError(`no secret store at ${this.path}`)
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(this.path, 'utf8')) }
    catch { throw new SecretStoreError(`secret store is not readable as JSON: ${this.path}`) }
    const version = (parsed as { v?: unknown })?.v
    const f = parsed as StoreFileV2
    if (version !== 2 || !Array.isArray(f.wraps) || !f.data) {
      throw new SecretStoreError(
        version === 1
          ? `secret store at ${this.path} uses the retired v1 format, which cannot be unlocked safely in place. Run \`saip config key add passphrase\` to create a new store (previous values are unrecoverable by design).`
          : `unexpected secret store format: ${this.path}`,
      )
    }
    return f
  }

  /** Ids of the wraps on file — names, never keys. */
  wrapIds(): WrapId[] { try { return this.file().wraps.map((w) => w.id) } catch { return [] } }

  /** Recover the KEK by trying each wrap against a source that can serve it. */
  private async resolveKek(f: StoreFileV2): Promise<Buffer | null> {
    for (const wrap of f.wraps) {
      const source = this.sources.find((s) => s.id === wrap.id)
      if (!source) continue
      const salt = wrap.salt ? Buffer.from(wrap.salt, 'base64') : null
      // Each wrap holds the KEK sealed under its own method's key, so any single satisfied wrap
      // unlocks the store and adding a method never requires re-wrapping the others.
      try {
        const wrapKey = await source.wrapKey(salt)
        if (!wrapKey || wrapKey.length !== KEY_BYTES) continue
        const kek = open(wrapKey, wrap)
        if (kek && kek.length === KEY_BYTES) { this.usedWrap = wrap.id; return kek }
      } catch { continue }
    }
    return null
  }

  async read(): Promise<Record<string, string>> {
    if (!this.exists()) return {}
    const f = this.file()
    const kek = await this.resolveKek(f)
    if (!kek) {
      const available = f.wraps.map((w) => `'${w.id}'`).join(', ')
      throw new SecretStoreError(
        `cannot unlock ${this.path}: none of its ${f.wraps.length} wrap(s) [${available}] could be satisfied by the available key sources. ` +
        `Set SAIP_SECRETS_PASSPHRASE or answer the prompt; a keyring wrap is only usable while that keyring is reachable.`,
      )
    }
    const plain = open(kek, f.data)
    if (!plain) throw new SecretStoreError(`secret payload in ${this.path} failed authentication — the file changed since it was written`)
    try { return JSON.parse(plain.toString('utf8')) as Record<string, string> }
    catch { throw new SecretStoreError(`secret payload in ${this.path} is not valid JSON after decryption`) }
  }

  async names(): Promise<string[]> { return Object.keys(await this.read()).sort() }
  async get(name: string): Promise<string | undefined> { return (await this.read())[name] }

  async set(name: string, value: string): Promise<void> {
    const map = await this.read().catch(() => ({} as Record<string, string>))
    map[name] = value
    await this.persist(map)
  }

  async unset(name: string): Promise<boolean> {
    const map = await this.read()
    if (!(name in map)) return false
    delete map[name]
    await this.persist(map)
    return true
  }

  /**
   * Persist the map. An existing store keeps its KEK and wraps untouched — only the payload is
   * rewritten — so an ordinary `set` never re-encrypts under a different key. A new store gets a
   * fresh KEK wrapped by exactly one provisioned source, and the passphrase is required: an
   * unattended wrap can only be added later, deliberately, via `saip config key add`.
   */
  private async persist(map: Record<string, string>): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true })
    if (this.exists()) {
      const f = this.file()
      const kek = await this.resolveKek(f)
      if (!kek) throw new SecretStoreError(`cannot unlock ${this.path} in order to rewrite it`)
      this.write({ ...f, data: seal(kek, Buffer.from(JSON.stringify(map), 'utf8')) })
      return
    }
    const primary = this.sources.find((x) => x.id === 'passphrase') ?? this.sources[0]
    if (!primary?.provision) throw new SecretStoreError('no key source available to create a secret store')
    const { key: wrapKey, salt } = await primary.provision()
    const kek = randomBytes(KEY_BYTES)
    this.write({
      v: 2,
      wraps: [{ id: primary.id, salt: salt?.toString('base64'), ...seal(wrapKey, kek) }],
      data: seal(kek, Buffer.from(JSON.stringify(map), 'utf8')),
    })
  }

  private write(f: StoreFileV2): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.path)
  }

  /** Add an unlock method without re-encrypting anything. */
  async addWrap(source: KeySource): Promise<void> {
    const f = this.file()
    if (f.wraps.some((w) => w.id === source.id)) throw new SecretStoreError(`wrap '${source.id}' already exists`)
    const kek = await this.resolveKek(f)
    if (!kek) throw new SecretStoreError('cannot unlock the store to add a wrap')
    const provisioned = await (source.provision?.() ?? Promise.reject(new SecretStoreError(`key source '${source.id}' cannot provision a key`)))
    f.wraps.push({ id: source.id, salt: provisioned.salt?.toString('base64'), ...seal(provisioned.key, kek) })
    // Nothing else changes: the payload stays sealed under the same KEK, and every existing
    // wrap already holds that KEK. Adding a method is therefore an append.
    this.write(f)
  }

  /**
   * Drop an unlock method. Because every wrap independently holds the KEK, removal needs no
   * re-wrapping and no re-encryption — but the guard matters: removing the last wrap makes the
   * store permanently unreadable, so it is refused outright.
   */
  async removeWrap(id: WrapId): Promise<void> {
    const f = this.file()
    const remaining = f.wraps.filter((w) => w.id !== id)
    if (remaining.length === 0) throw new SecretStoreError(`refusing to remove the last wrap ('${id}')`)
    const kek = await this.resolveKek(f)
    if (!kek) throw new SecretStoreError('cannot unlock the store to remove a wrap')
    // Require that at least one survivor can actually be re-opened, otherwise "removing" the
    // wrap the user still holds silently bricks the store.
    const usable = await Promise.all(remaining.map(async (w) => {
      const source = this.sources.find((x) => x.id === w.id)
      if (!source) return false
      try {
        const key = await source.wrapKey(w.salt ? Buffer.from(w.salt, 'base64') : null)
        return !!key && key.length === KEY_BYTES && open(key, w)?.length === KEY_BYTES
      } catch { return false }
    }))
    if (!usable.some(Boolean)) throw new SecretStoreError(`refusing to remove '${id}': no surviving wrap can be unlocked by an available key source`)
    f.wraps = remaining
    this.write(f)
    if (id === 'unattended') new KeyFileKey(this.unattendedKeyPath).destroy()
  }

  /** Which wrap unlocked last, after any read. */
  async activeWrap(): Promise<WrapId | undefined> {
    if (!this.exists()) return undefined
    const f = this.file()
    const kek = await this.resolveKek(f)
    return kek ? this.usedWrap : undefined
  }
}


export class EncryptedSecretsProvider implements SecretsProvider {
  constructor(private readonly store: SecretStore = new SecretStore()) {}
  async get(name: string): Promise<string | undefined> { return this.store.get(name) }
  async require(name: string): Promise<string> {
    const v = await this.store.get(name)
    if (v === undefined || v === '') throw new MissingSecretError(name)
    return v
  }
}

/** Resolution chain, highest priority first. Empty string counts as absent. */
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

export function defaultSecretsProvider(
  env: NodeJS.ProcessEnv = process.env,
  storeOpts: SecretStoreOptions = {},
): SecretsProvider {
  // One env for both links of the chain. Passing it only to EnvSecrets produced a provider
  // whose store half consulted process.env instead — untestable and wrong for any embedder.
  return new ChainSecrets([new EnvSecrets(env), new EncryptedSecretsProvider(new SecretStore({ ...storeOpts, env }))])
}
