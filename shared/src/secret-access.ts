/**
 * SecretAccessService (#93) — the single place secrets are reached, in the CLI and in the gateways.
 *
 * Before this, each caller did `provider.get('SAIP_R2_BUCKET')` wherever it felt like it. That has
 * three consequences the gateway removes:
 *
 *  1. **One unlock per command.** A command declares its needs, `unlock()` is called once, and every
 *     read *and every write* after it is free. Before #86/#93 the store re-derived the key per
 *     operation, so a wizard with four values demanded the passphrase four times — and #169 found the
 *     same rule broken on the write side, because there was no write method here to route them
 *     through, so the wizard called the store directly and the cache this class owns was never asked.
 *  2. **A stated reason.** `explain()` renders the declared names and purposes — and the catalog's
 *     own purpose text when a caller gives none — so a prompt can say why it is happening. "Enter
 *     passphrase" with no context teaches a user nothing about what they are protecting.
 *  3. **An auditable record.** Access is logged as name + command + purpose, never value, so the log
 *     is safe to print. This is what makes "why did it ask me for a password" answerable after the
 *     fact rather than a matter of recall.
 *
 * Sensitivity is never computed here: it comes from the catalog, or is labelled inferred for names
 * outside it. A declared fact and a guess must not look the same on screen.
 */
import { Service } from 'cordis'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { EnvSecrets, MissingSecretError, type SecretsProvider } from './hosting.js'
import { ChainSecrets, defaultStorePath, EncryptedSecretsProvider, SecretStore, SecretStoreError, type WrapId } from './secrets-store.js'
import { catalogFor, findSecret, sensitivityOf, type SecretEntry } from './secret-catalog.js'

export interface SecretNeed { name: string; purpose?: string }

export interface AccessRecord {
  readonly command: string
  readonly name: string
  readonly purpose: string
  readonly sensitive: boolean
  readonly declared: boolean
  readonly at: number
}

export interface UnlockResult {
  ok: boolean
  wrap?: WrapId
  error?: string
}

export class SecretAccess implements SecretsProvider {
  private readonly declarations = new Map<string, SecretNeed[]>()
  private readonly log: AccessRecord[] = []
  private isUnlocked = false
  private unlockError?: string
  private chain: SecretsProvider

  constructor(
    private readonly store: SecretStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly auditFile?: string,
  ) {
    // Environment first, then the store: a one-off `SAIP_X=y saip …` must still override, as
    // documented in #67's resolution order.
    this.chain = new ChainSecrets([new EnvSecrets(env), new EncryptedSecretsProvider(store)])
  }

  /** Register what a command needs. Idempotent per command; later calls replace the set. */
  declare(command: string, needs: SecretNeed[]): void {
    this.declarations.set(command, needs)
  }

  /** Commands that declared a given name — from the declaration, or the catalog if none. */
  usersOf(name: string): string[] {
    const fromDecl = [...this.declarations.entries()]
      .filter(([, needs]) => needs.some((n) => n.name === name))
      .map(([c]) => c)
    if (fromDecl.length) return fromDecl
    return [...(findSecret(name)?.usedBy ?? [])]
  }

  /** Human-facing statement of intent, shown before any prompt. */
  explain(command: string): string {
    const needs = this.declarations.get(command) ?? []
    if (!needs.length) return `[saip] ${command} declares no secrets.`
    const lines = [`[saip] ${command} reads ${needs.length} stored value(s):`]
    for (const n of needs) {
      const entry = findSecret(n.name)
      const sens = sensitivityOf(n.name)
      const purpose = n.purpose ?? entry?.purpose ?? 'no purpose declared'
      const tail = sens.declared ? '' : '  (sensitivity inferred — this name is not in the catalog)'
      lines.push(`  - ${n.name}${entry?.kind === 'config' ? ' [config]' : ''}: ${purpose}${tail}`)
    }
    lines.push('[saip] nothing is sent anywhere; the passphrase unlocks local reads only.')
    return lines.join('\n')
  }

  /**
   * Unlock once. Reads before a successful unlock are refused rather than silently returning
   * undefined — a half-unlocked store that "has no values" is the quiet-failure shape this whole
   * issue set exists to remove.
   */
  async unlock(): Promise<UnlockResult> {
    if (this.isUnlocked) return { ok: true, wrap: this.store.usedWrap }
    try {
      const wrap = await this.store.ensureUnlocked()
      this.isUnlocked = true
      this.unlockError = undefined
      return { ok: true, wrap }
    } catch (e) {
      this.isUnlocked = false
      this.unlockError = (e as Error).message
      return { ok: false, error: this.unlockError }
    }
  }

  /** Force the next read path to re-unlock (after `key add`, a rotate, or a doctor re-check). */
  relock(): void { this.isUnlocked = false; this.store.lock() }

  get unlocked(): boolean { return this.isUnlocked }

  async read(name: string): Promise<string | undefined> {
    if (!this.store.exists()) return this.envValue(name)
    if (!this.isUnlocked) throw new MissingSecretError(`${name} (the secret store has not been unlocked for this command; call unlock() after explain())`)
    const value = await this.chain.get(name)
    if (value !== undefined) this.record(name, value)
    return value
  }

  /**
   * Read the STORE only — never the resolution chain — and record the access.
   *
   * This exists for one question: **"did my write land?"** `read()` deliberately resolves
   * environment-first (a one-off `SAIP_X=y saip …` must override, #67), and that is right for
   * "what would the platform use?" — but using it to verify a write compares the value just stored
   * against whatever the shell happens to export, so a successful `config set` of a name that also
   * exists in the environment reported `did not persist as written` and exited 1 (#146). Verification
   * needs the object that was written, not the resolution winner.
   *
   * Recorded the same way `read()` records, because the audit trail is about the store being touched;
   * skipping it would make the fix cost observability.
   */
  async readStored(name: string): Promise<string | undefined> {
    if (!this.store.exists()) return undefined
    if (!this.isUnlocked) throw new MissingSecretError(`${name} (the secret store has not been unlocked for this command; call unlock() after explain())`)
    const value = await this.store.get(name)
    if (value !== undefined) this.record(name, value)
    return value
  }

  async require(name: string): Promise<string> {
    const v = await this.read(name)
    if (v === undefined || v === '') throw new MissingSecretError(name)
    return v
  }

  /**
   * Write through the gateway (#169), so the command that unlocked the store is the command that
   * writes it and the KEK cache is shared. Without a write path here, a wizard storing four values
   * had exactly one option — `store.set()` — and reaching the store around the gateway is what made
   * "one unlock per command" true for reads and false for writes.
   *
   * An absent store is NOT an error, unlike `unlock()`: creating the store is the one legitimate
   * moment the passphrase belongs, and the store's own key sources ask for it. A store that exists
   * but cannot be opened refuses before writing anything — the guide's rule that a store which
   * cannot be opened reads nothing and writes nothing.
   */
  async write(name: string, value: string): Promise<void> {
    if (this.store.exists() && !this.isUnlocked) {
      const r = await this.unlock()
      if (!r.ok) {
        throw new SecretStoreError(`cannot unlock ${this.store.filePath} to write ${name}: ${r.error ?? 'no key source could satisfy its wraps'}`)
      }
    }
    await this.store.set(name, value)
    // True in both cases: an existing store was unlocked above, and creating one just derived the
    // KEK the new file is sealed under. `relock()` is what invalidates it after a wrap changes.
    this.isUnlocked = true
    // Recorded like a read, because the audit answer to "why did that command touch my store" has to
    // cover the command that put a credential there in the first place. Values never reach the log.
    this.record(name, value)
  }

  /**
   * Names already held in the store, through this instance's unlock. Empty when there is no store
   * yet — which is the wizard's opening state, and the reason it cannot pre-unlock.
   */
  async storedNames(): Promise<string[]> {
    return this.store.exists() ? this.store.names() : []
  }

  /** `SecretsProvider` surface, so existing callers can take the gateway with no second path. */
  async get(name: string): Promise<string | undefined> {
    const env = this.envValue(name)
    if (env !== undefined) return env
    if (!this.store.exists()) return undefined
    return this.read(name)
  }

  private envValue(name: string): string | undefined {
    const v = this.env[name]
    return v === undefined || v === '' ? undefined : v
  }

  private record(name: string, _value: string): void {
    const commands = this.usersOf(name)
    const command = commands[0] ?? 'unknown'
    const need = this.declarations.get(command)?.find((n) => n.name === name)
    const entry = findSecret(name)
    const sens = sensitivityOf(name)
    // The value is passed in only so the signature says so; it is never stored.
    const record = {
      command,
      name,
      purpose: need?.purpose ?? entry?.purpose ?? 'undeclared',
      sensitive: sens.sensitive,
      declared: sens.declared,
      at: Date.now(),
    }
    this.log.push(record)
    // Cross-command history: "why did it ask me for a password" is asked after the fact, in a
    // different process, so an in-memory log alone could not answer it. Values never appear here,
    // which is what makes the file safe to display. A write failure must never block a secret read,
    // so it is best-effort and silent by design — the in-memory log still holds the truth for
    // this process.
    if (this.auditFile) {
      try {
        const rows = readAudit(this.auditFile)
        rows.push(record)
        writeFileSync(this.auditFile, JSON.stringify(rows.slice(-200), null, 2), { mode: 0o600 })
      } catch { /* audit is diagnostic, never load-bearing */ }
    }
  }

/** Safe to print: no values, and every entry carries the reason it was read. */
  accessLog(): readonly AccessRecord[] { return this.log }

  /** Catalog view for this deployment, so the wizard and the gateway cannot disagree. */
  catalog(config: any, hosts: readonly { kind?: string }[], extra?: SecretEntry[]): SecretEntry[] {
    return catalogFor({ config, hosts, extra })
  }
}

// Plain name, matching the repo's existing convention (`SECRETS_SERVICE = 'secrets'`). Cordis
// exposes the service at ctx[name], so a namespaced string here silently yields undefined access —
// found by writing the test that tried to use it, not by reading the code.
/** Read the persisted access history. Never contains values; a missing or corrupt file is empty. */
export function readAudit(path: string): AccessRecord[] {
  try {
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.name === 'string' && typeof r.command === 'string') : []
  } catch {
    return []
  }
}

export const SECRET_ACCESS_SERVICE = 'secretAccess'

/** Cordis service form: `ctx.plugin(...)` in each composition root. */
export class SecretAccessService extends Service {
  static readonly provide = SECRET_ACCESS_SERVICE
  readonly access: SecretAccess
  constructor(ctx: any, config: { store?: SecretStore; env?: NodeJS.ProcessEnv; auditFile?: string } = {}) {
    super(ctx, SECRET_ACCESS_SERVICE)
    this.access = new SecretAccess(
      config.store ?? new SecretStore({ env: config.env }),
      config.env,
      // Default history file beside the store, outside the workspace like everything else here.
      config.auditFile ?? `${defaultStorePath(config.env)}.access.json`,
    )
  }
  declare(command: string, needs: SecretNeed[]): void { this.access.declare(command, needs) }
  explain(command: string): string { return this.access.explain(command) }
  unlock(): Promise<UnlockResult> { return this.access.unlock() }
  read(name: string): Promise<string | undefined> { return this.access.read(name) }
  readStored(name: string): Promise<string | undefined> { return this.access.readStored(name) }
  require(name: string): Promise<string> { return this.access.require(name) }
  write(name: string, value: string): Promise<void> { return this.access.write(name, value) }
  storedNames(): Promise<string[]> { return this.access.storedNames() }
  accessLog(): readonly AccessRecord[] { return this.access.accessLog() }
}

export function defaultSecretAccess(opts: { env?: NodeJS.ProcessEnv; storePath?: string; auditFile?: string; prompt?: (q: string) => Promise<string> } = {}): SecretAccess {
  // The composition root for embedders: one store, one gateway, honoring the env it is given.
  const env = opts.env ?? process.env
  const store = new SecretStore({ path: opts.storePath, env })
  return new SecretAccess(store, env, opts.auditFile)
}
