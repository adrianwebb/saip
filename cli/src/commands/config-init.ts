/**
 * `saip config init` — the first-time credential wizard (#78).
 *
 * Why this exists as a command rather than a longer docs page: a new user does not know which
 * variable names are required, what each one buys, or where to get a correctly scoped key. Telling
 * them to `saip config set SAIP_R2_ACCESS_KEY_ID` assumes the knowledge the step is supposed to
 * provide — that line is the RESET path, not the onboarding path.
 *
 * The question list is DERIVED from the user's own `saip.yaml` / `hosts.yaml`, so a configuration
 * that declares no API tokens is never asked about token secrets, and Hyperstack appears only when
 * a hyperstack host exists. A hardcoded checklist is exactly how docs and reality drift apart.
 *
 * Routing rule that is easy to get wrong and is therefore asserted in tests: `${VAR}`
 * interpolation reads the shell and `.env`, NEVER the encrypted store. So bucket/endpoint go to
 * `.env`; values the runtime resolves by secret name go to the store. Writing an interpolated value
 * into the store would report success and change nothing.
 */
import { existsSync, readFileSync } from 'node:fs'

/** Raised when the user presses Ctrl+C. Distinct from "empty input" on purpose. */
export class WizardCancelled extends Error { readonly name = 'WizardCancelled' }

/**
 * Incremental line reader for a raw-mode terminal, kept pure so paste and Ctrl+C are testable
 * without a TTY.
 *
 * Three behaviours that a naive chunk.toString() loop gets wrong:
 *  - **Bracketed paste.** Terminals wrap a paste in `ESC [ 200 ~ … ESC [ 201 ~`. Filtering only
 *    control bytes keeps the digits and letters INSIDE the sequence, silently corrupting a pasted
 *    key (`200AKIA…201`). So CSI/OSC sequences are skipped as sequences, not as characters.
 *  - **Ctrl+C is not a signal here.** `setRawMode(true)` disables ISIG, so 0x03 arrives as a byte.
 *    Handling it explicitly is the only way the documented "Ctrl+C stops the wizard" is true.
 *  - **Ctrl+D is EOF, not a literal.** Accept what was typed, which is what a paste ending in
 *    Ctrl+D needs.
 */
export function newLineAccumulator(): {
  feed(chunk: string): { value: string; done: boolean; cancelled: boolean }
} {
  let value = ''
  // none -> esc (saw ESC, awaiting the introducer) -> csi (consuming parameters until the final byte)
  let esc: 'none' | 'esc' | 'csi' = 'none'
  return {
    feed(chunk: string) {
      for (const ch of chunk) {
        const code = ch.codePointAt(0) ?? 0
        // ECMA-48: ESC [ is a TWO-byte introducer, then parameter bytes 0x30-0x3F and
        // intermediates 0x20-0x2F, then a single final byte 0x40-0x7E ends the sequence. Treating
        // '[' as the final byte is what made an earlier version of this reducer leak "200~" from a
        // bracketed-paste marker straight into the pasted credential.
        if (esc === 'esc') { esc = ch === '[' || ch === ']' ? 'csi' : 'none'; continue }
        if (esc === 'csi') {
          if (code >= 0x20 && code <= 0x3f) continue
          esc = 'none'
          if (code >= 0x40 && code <= 0x7e) continue
          // Outside both ranges: the sequence ended on an odd byte, so fall through and keep this
          // character rather than swallowing input the user actually typed.
        }
        if (code === 0x1b) { esc = 'esc'; continue }
        if (ch === '\n' || ch === '\r') return { value, done: true, cancelled: false }
        if (code === 0x04) return { value, done: true, cancelled: false }
        if (code === 0x03) return { value: '', done: true, cancelled: true }
        if (code === 0x7f || code === 0x08) { value = value.slice(0, -1); continue }
        // Reject other control bytes (bell, vertical tab, NUL from a stray paste) rather than
        // storing an invisible character that will silently fail authentication later.
        if (code < 0x20) continue
        value += ch
      }
      return { value, done: false, cancelled: false }
    },
  }
}
import { envFilePath, setEnvFileValues, removeEnvValues, sensitivityOf, catalogFor, retiredSecret, type SecretEntry, type SecretStore } from '@saip/shared'

export interface InitItem {
  readonly name: string
  /** Declared by the catalog. Never recomputed for a catalogued name (#93). */
  readonly sensitive: boolean
  /** True when the name is not catalogued and sensitivity was inferred from it. */
  readonly inferred?: boolean
  /** `config` → written to `.env` (interpolated into saip.yaml). `secret` → written to the store. */
  readonly kind: 'config' | 'secret'
  /** Blank aborts the wizard for this item; otherwise Enter skips it with a note. */
  readonly required: boolean
  readonly purpose: string
  readonly how: string
  readonly scope?: string
  readonly providerUrl?: string
  readonly docsUrl?: string
}

export interface Io {
  say(line: string): void
  /** `secret: true` means the implementation must suppress echo. */
  ask(question: string, opts: { secret: boolean }): Promise<string>
}

const SITE = 'https://adrianwebb.github.io/saip'
const R2_DOCS = 'https://developers.cloudflare.com/r2/api/tokens/'
const CF_ACCOUNT = 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/'
const HF_DOCS = 'https://huggingface.co/docs/hub/en/security-tokens'
const HS_DOCS = 'https://docs.hyperstack.cloud/docs/api-reference/authentication/'

/**
 * The questions implied by a configuration. Pure and exported separately so the derivation is
 * testable without a terminal, a store, or a filesystem.
 */
export function planInitItems(input: { config: any; hosts: any[] }): InitItem[] {
  // One source of truth: the runtime catalog. The wizard's guidance, the access policy and the
  // sensitivity flags all come from the same entries, so help text and enforcement cannot drift —
  // which is what happened when this file held its own copy of the descriptions.
  const entries: SecretEntry[] = catalogFor({ config: input.config, hosts: input.hosts })
  const items: InitItem[] = entries.map((e) => ({
    name: e.name,
    kind: e.kind,
    sensitive: e.sensitive,
    inferred: e.inferred,
    required: e.required,
    purpose: e.purpose,
    how: e.how,
    scope: e.scope,
    providerUrl: e.providerUrl,
    docsUrl: e.docsUrl,
  }))

  return items
}

/** Where a value currently comes from. Only some of these the CLI can clear. */
export type ValueSource = 'shell' | '.env' | 'store'

export async function valueSource(
  name: string,
  ctx: { env?: NodeJS.ProcessEnv; envPath: string; store: SecretStore },
): Promise<ValueSource | undefined> {
  const env = ctx.env ?? process.env
  if ((env[name] ?? '') !== '') return 'shell'
  if (readEnvValue(ctx.envPath, name)) return '.env'
  try { if ((await ctx.store.get(name)) !== undefined) return 'store' } catch { /* unreadable store is reported by the caller */ }
  return undefined
}

const sourceNote = (name: string, src: ValueSource, shown?: string): string[] => {
  if (src !== 'shell') return [`   current : already set — source: (${src})${shown ? ` — ${shown}` : ''}`]
  return [
    `   current : already set — source: (shell)`,
    `   note    : this comes from your shell environment, which the CLI cannot clear.`,
    `             Remove it yourself:  unset ${name}   and delete the line from your shell profile,`,
    `             otherwise it reappears next session and wins over anything stored here.`,
  ]
}

/**
 * What to display for the current value: in full for ordinary configuration, as a character count
 * for credentials. This is the whole point of the designation — the user needs to see the bucket
 * and endpoint they have, and must never see a key.
 */
export async function currentDisplay(
  item: InitItem,
  src: ValueSource,
  ctx: { env?: NodeJS.ProcessEnv; envPath: string; store: SecretStore },
  sensitive: boolean,
): Promise<string> {
  let raw: string | undefined
  if (src === 'shell') raw = (ctx.env ?? process.env)[item.name]
  else if (src === '.env') raw = readEnvValue(ctx.envPath, item.name)
  else {
    // A stored credential reports its LENGTH only. Reading it is deliberate: "set (hidden)" tells
    // you nothing about a value you may need to spot as wrong.
    try { raw = await ctx.store.get(item.name) } catch { raw = undefined }
  }
  if (sensitive) return raw ? `set (${raw.length} chars, hidden)` : 'set (hidden)'
  return raw ? `current value: ${raw}` : 'set'
}

/** The teaching block. Printed for EVERY item, set or unset — see #82. */
function guidanceLines(item: InitItem): string[] {
  const out = [
    `── ${item.name} ${item.required ? '(required)' : '(optional)'}`,
    `   what    : ${item.purpose}`,
    `   how     : ${item.how}`,
  ]
  if (item.scope) out.push(`   scoping : ${item.scope}`)
  out.push(`   create  : ${item.providerUrl ?? 'generate this one yourself'}`)
  if (item.docsUrl) out.push(`   docs    : ${item.docsUrl}`)
  return out
}

export interface RunInitOptions {
  store: SecretStore
  items: InitItem[]
  io: Io
  envPath?: string
  /** Pre-supplied answers (CI, `--non-interactive`, or an embedding caller). */
  answers?: Record<string, string>
  interactive?: boolean
  force?: boolean
  /** Environment consulted for the shell-vs-file-vs-store report. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Re-ask just this one name, clearing it first. */
  reset?: string
  /** Retired config keys found in saip.yaml; reported before anything else. */
  deprecations?: string[]
}

/** Print the catalog with no prompts and no writes — the guidance as a help surface (#82). */
export async function runHelp(opts: {
  store: SecretStore
  items: InitItem[]
  envPath?: string
  only?: string
  io: Io
  env?: NodeJS.ProcessEnv
}): Promise<{ code: number; lines: string[] }> {
  const envPath = opts.envPath ?? envFilePath()
  const ctx = { env: opts.env, envPath, store: opts.store }
  const lines: string[] = []
  const emit = (l: string): void => { lines.push(l); opts.io.say(l) }
  const wanted = opts.only ? opts.items.filter((i) => i.name === opts.only) : opts.items
  if (opts.only && !wanted.length) {
    emit(`[saip] no guidance entry for ${opts.only}. Known: ${opts.items.map((i) => i.name).join(', ')}`)
    return { code: 1, lines }
  }
  for (const item of wanted) {
    for (const l of guidanceLines(item)) emit(l)
    const sensitive = item.sensitive
  const src = await valueSource(item.name, ctx)
    emit(src ? `   state   : ${src === 'store' ? 'stored (encrypted)' : src === '.env' ? 'set in .env' : 'set in your shell'} — ${item.required ? 'required' : 'optional'}` : `   state   : not set — ${item.required ? 'REQUIRED, must be provided' : 'optional, safe to skip'}`)
    emit('')
  }
  emit('[saip] set any of these with `saip config init` (guided) or `saip config set NAME`.')
  return { code: 0, lines }
}

/** Remove a value from every surface the CLI controls, reporting what it touched (#82). */
export async function forgetValue(opts: {
  store: SecretStore
  name: string
  envPath?: string
  env?: NodeJS.ProcessEnv
}): Promise<{ cleared: string[]; stillFromShell: boolean; lines: string[] }> {
  const envPath = opts.envPath ?? envFilePath()
  const env = opts.env ?? process.env
  const cleared: string[] = []
  const lines: string[] = []
  if (removeEnvValues(envPath, [opts.name]).length) cleared.push('.env')
  try { if (await opts.store.unset(opts.name)) cleared.push('store') }
  catch (e) { lines.push(`[saip] could not open the store to clear ${opts.name}: ${(e as Error).message}`) }
  const stillFromShell = (env[opts.name] ?? '') !== ''
  if (cleared.length) lines.push(`[saip] forgot ${opts.name} from: ${cleared.join(', ')}`)
  else lines.push(`[saip] ${opts.name} was not set in the store or ${envPath}`)
  if (stillFromShell) {
    lines.push(`[saip] WARNING: ${opts.name} is ALSO set in your shell environment, which takes precedence —`)
    lines.push(`[saip]          the CLI cannot clear it. Run: unset ${opts.name}  and remove it from your shell profile.`)
  }
  return { cleared, stillFromShell, lines }
}

export interface InitResult { code: number; lines: string[]; stored: string[]; skipped: string[] }

const clean = (v: string): string => v.replace(/\r?\n$/g, '').replace(/[\r\n]+/g, '')

/**
 * Drive the wizard. Everything user-facing goes through `io`, so CI never needs a terminal while
 * the real command path still exercises this same function — the split #73/#76 taught us to make.
 */
export async function runInit(opts: RunInitOptions): Promise<InitResult> {
  const { store, items, io, answers = {}, interactive = true, force = false, reset } = opts
  const envPath = opts.envPath ?? envFilePath()
  const ctx = { env: opts.env, envPath, store }
  const lines: string[] = []
  const stored: string[] = []
  const skipped: string[] = []
  const missing: string[] = []
  const retiredFound: { name: string; reason: string }[] = []
  // Both sinks, always. `emit` writes through io.say so a terminal sees each block BEFORE the
  // prompt it explains, and keeps a copy in `lines` for --non-interactive capture and tests.
  // Previously only the copy existed, so the entire explanation printed after the last prompt.
  const emit = (l: string): void => { lines.push(l); io.say(l) }

  // Reported before the first question: a retired key the user still has in saip.yaml
  // changes nothing, and they should learn that before being asked to configure more.
  for (const w of opts.deprecations ?? []) emit(`[saip] WARNING: ${w}`)

  emit('[saip] config init — one value at a time, hidden input, paste works')
  emit('[saip] Enter on an optional item skips it; Ctrl+C stops and keeps what is already saved.')

  // One unlock for the whole command (#86). Previously every write re-derived the key, so every
  // write re-prompted: four credentials cost four passphrase prompts and four scrypt runs, and
  // nothing said why. Unlocking first separates "wrong passphrase" from a value prompt, and hands
  // us the name list, which is the only reliable way to see variables set outside the catalog.
  if (interactive && store.exists()) {
    let names: string[] = []
    try {
      const wrap = await store.ensureUnlocked()
      names = await store.names()
      emit('')
      emit(`[saip] this command reads ${items.length} value(s): ${items.map((i) => i.name).join(', ')}`)
      if (names.length) emit(`[saip] the store already holds ${names.length}: ${names.join(', ')}`)
      emit('[saip] they are read to fill in what is already configured; nothing is sent anywhere.')
      emit(`[saip] store unlocked (via ${wrap}) — you will not be asked again in this command.`)
    } catch (e) {
      emit(`[saip] ${(e as Error).message}`)
      emit('[saip] nothing was changed. Re-run with a different passphrase, or `saip config doctor`.')
      return { code: 1, lines, stored, skipped }
    }

    // Names the catalog has never seen are surfaced here rather than in planInitItems, because
    // reading the store is async and a synchronous stub would have been dead code that looked like
    // a feature. They stay visible, and their sensitivity is labelled as inferred — a declared fact
    // and a guess must not read the same (#93).
    for (const name of names) {
      if (items.some((i) => i.name === name)) continue
      // A retired value is still a credential sitting in the store. Say what happened to it and how
      // to clear it, instead of quietly omitting it from the wizard and leaving it there.
      const retired = retiredSecret(name)
      if (retired) {
        retiredFound.push({ name, reason: retired.reason })
        items.push({
          name, kind: 'secret', sensitive: true, required: false,
          purpose: `RETIRED (${retired.since}): ${retired.reason}`,
          how: `Nothing reads this any more. Remove it: saip config forget ${name}`,
          docsUrl: `${SITE}/guides/manage-secrets/`,
        })
        continue
      }
      const sens = sensitivityOf(name)
      items.push({
        name,
        kind: 'secret',
        sensitive: sens.sensitive,
        inferred: !sens.declared,
        required: false,
        purpose: 'Present in the store but not described in the catalog, so SAIP does not know what it is for.',
        how: `Enter a new value to replace it, or remove it: saip config forget ${name}`,
        scope: sens.declared ? undefined : 'Sensitivity inferred from the name — not a declared fact (#93).',
        docsUrl: `${SITE}/guides/manage-secrets/`,
      })
    }
  }

  try {
  for (const item of items) {
    const sensitive = item.sensitive
  const src = await valueSource(item.name, ctx)
    if (reset && reset !== item.name) { if (src) stored.push(item.name); continue }

    // Guidance first, ALWAYS — including for values already set. Hiding it once something exists
    // conceals it from precisely the user whose existing value is wrong, which is the case where
    // the explanation is worth the most.
    for (const l of interactive ? guidanceLines(item) : (item.required && !answers[item.name] ? [`   missing   : ${item.name} — ${item.purpose}`] : [])) emit(l)
    if (src) for (const l of sourceNote(item.name, src, await currentDisplay(item, src, ctx, sensitive))) emit(l)

    if (reset === item.name) {
      // The user asked to redo this one; clear it first so "already set" cannot shadow the answer.
      await forgetValue({ store, name: item.name, envPath, env: opts.env })
      emit(`   → forgetting ${item.name} so it can be set again`)
    } else if (src && !force) {
      if (!interactive) { stored.push(item.name); continue }
      emit(`   → Enter keeps it; type a new value to replace it; or: saip config forget ${item.name}`)
      const next = clean(await io.ask(`${item.name}: `, { secret: sensitive }))
      if (!next) { stored.push(item.name); continue }
      await writeOne(item, next)
      continue
    }

    // Scripted answers win when provided (CI, --non-interactive, embedding callers); otherwise the
    // user is prompted. Both paths produce the same routing below, so there is no second flavour
    // of behaviour to drift out of sync.
    // Non-interactive never prompts and never writes: it reports. That is what makes the mode
    // safe to run from CI or an agent, and why a required blank is recorded rather than asked.
    let value = answers[item.name] !== undefined
      ? clean(answers[item.name]!)
      : (interactive ? clean(await io.ask(`${item.name}: `, { secret: sensitive })) : '')

    if (!value) {
      if (!interactive) {
        if (item.required) missing.push(item.name)
        else skipped.push(item.name)
        continue
      }
      if (!item.required) {
        emit(`   → skipped; anything needing ${item.name} stays inert until you set it`)
        skipped.push(item.name)
        continue
      }
      emit(`   → ${item.name} is required and was left empty. Enter it, or Ctrl+C to stop.`)
      const retry = clean(await io.ask(`${item.name}: `, { secret: sensitive }))
      if (!retry) {
        lines.push(`[saip] stopped: ${item.name} is required and cannot be empty. Nothing was written for it.`)
        return { code: 1, lines: [...lines], stored, skipped }
      }
      value = retry
    }
    await writeOne(item, value)
  }

  if (missing.length) {
    lines.push('')
    lines.push(`[saip] not configured (${missing.length} required): ${missing.join(', ')}`)
    lines.push('[saip] run `saip config init` at a terminal for the guided wizard, or set them with:')
    for (const n of missing) {
      const it = items.find((x) => x.name === n)!
      emit(it.kind === 'secret'
        ? `  printf %s "$${n}" | saip config set ${n} --stdin`
        : `  echo '${n}=...' >> ${envPath}`)
    }
    return { code: 1, lines, stored, skipped }
  }

  } catch (e) {
    if (!(e instanceof WizardCancelled)) throw e
    const remaining = items.filter((i) => !stored.includes(i.name)).map((i) => i.name)
    emit('')
    emit('[saip] stopped by Ctrl+C.')
    emit(`[saip] stored so far (${stored.length}): ${stored.join(', ') || 'nothing'}`)
    if (remaining.length) emit(`[saip] still not set (${remaining.length}): ${remaining.join(', ')}`)
    emit('[saip] re-running `saip config init` continues where this left off.')
    return { code: 130, lines, stored, skipped }
  }

  if (retiredFound.length) {
    emit('')
    for (const r of retiredFound) emit(`[saip] retired value still stored: ${r.name} — ${r.reason}`)
  }

  emit('')
  emit(`[saip] stored ${stored.length} value(s): ${stored.join(', ') || 'none'}`)
  if (skipped.length) emit(`[saip] skipped: ${skipped.join(', ')}`)
  emit(`[saip] secrets → ${store.filePath}; interpolated config → ${envPath}`)
  emit('[saip] NOTE: credentials were NOT verified — the R2 client is separate work, and an unsigned')
  emit('[saip]       request 403s for valid and invalid keys alike, so it would prove nothing.')
  emit('[saip]       `saip config verify` will do it once the storage provider lands.')
  return { code: 0, lines, stored, skipped }

  async function writeOne(item: InitItem, value: string): Promise<void> {
    if (item.kind === 'secret') await store.set(item.name, value)
    // Written as it is answered, not batched to the end: an interrupt after five answers must not
    // discard the first four.
    else setEnvFileValues(envPath, { [item.name]: value })
    stored.push(item.name)
    // Recomputed here: `writeOne` is shared by every branch, so relying on a loop-local variable
    // would silently mask the wrong way for one of them.
    emit(item.sensitive ? `   → stored ${item.name} (${value.length} chars)` : `   → stored ${item.name} = ${value}`)
  }
}

/**
 * Read one value straight from the env file. Deliberately not `loadEnvFile()` + fold into the
 * process: the wizard must ask "is this already set?" without mutating its own environment.
 */
function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined
  const m = readFileSync(path, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))
  return m?.[1] ? clean(m[1]) : undefined
}
