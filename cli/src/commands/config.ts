/**
 * `saip config` — manage the encrypted local secret store.
 *
 * Written to a threat model, not a feature list. The rules that shape it:
 * - **Never print a value unless explicitly told to.** `list` shows names; `get` shows a mask plus
 *   a length, because a length is enough to confirm a rotation took effect without disclosing it.
 * - **Prefer paths that keep the secret off the process boundary.** An argument is visible in `ps`
 *   and lands in shell history, so the prompt and `--stdin` routes are the primary ones and
 *   `--value` is documented as the exception for callers that have already solved that problem.
 * - **Surface the footgun instead of hiding it.** The store sits *below* the parent environment in
 *   resolution order, so an exported variable shadows a stored one. Every read says so rather than
 *   letting someone conclude the store is broken.
 * - **File mode is part of the security story.** A store readable by group or other is reported as
 *   a failure, not noted politely.
 */
import { Service } from 'cordis'
import type { Context } from 'cordis'
import { statSync, openSync } from 'node:fs'
import { ReadStream } from 'node:tty'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { SecretAccess, SecretStore, defaultStorePath, defaultKeySources, KeyFileKey, SecretToolKey, envFilePath, isSensitiveName, sensitivityOf, readAudit, loadYamlConfig, resolveConfigFile, type SecretToolRunner, type WrapId } from '@saip/shared'
import type { CommandSpec } from '../lib/command-registry.js'
import { planInitItems, runInit, runHelp, forgetValue, cardGuidance, type InitItem, newLineAccumulator, WizardCancelled, type Io } from './config-init.js'

export interface RunDeps {
  /** Environment used to detect shadowing. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Injectable stdin reader so tests need no TTY. */
  readStdin?: () => Promise<string>
  /** Injectable secret prompt so tests need no TTY. */
  prompt?: (q: string) => Promise<string>
  /** Injectable keychain runner; omitted means probe the host for secret-tool. */
  toolRunner?: SecretToolRunner
  /** Injectable store path, so tests never touch the real ~/.saip. */
  storePath?: string
  /** Why the passphrase is being asked for. Printed immediately before the prompt. */
  reason?: string
  /** Card renderer for a human terminal; omitted means plain labelled lines (pipes, CI, tests). */
  formatItem?: (item: InitItem) => string[]
  /** Injectable access gateway; the default wraps the same store so the KEK cache is shared. */
  access?: SecretAccess
}

export interface RunResult { code: number; lines: string[] }

/**
 * Masks a value. Deliberately contains no substring of the original — an ellipsis-plus-tail like
 * `super…2345` is a partial disclosure and narrows a guess space substantially.
 */
export function maskValue(value: string): string {
  return `•••• (${value.length} chars)`
}

async function readStdinLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin })
  const first = await new Promise<string>((resolve) => rl.once('line', resolve))
  rl.close()
  return first
}

/** Raised when a secret must be typed but there is no controlling terminal. */
export class NoTerminalError extends Error { readonly name = 'NoTerminalError' }

/**
 * Read a secret from the controlling terminal, not from stdin.
 *
 * This matters because the documented zero-friction path is `printf x | saip config set NAME
 * --stdin`: the pipe supplies the value, so a passphrase prompt that read stdin would get
 * nothing and silently store an empty passphrase. `sudo` and `ssh-add` avoid this by using
 * /dev/tty; so do we — and with no controlling terminal we refuse outright rather than storing
 * a key that nobody knows, which would look like success and be unrecoverable.
 */
/** One stream for the controlling terminal, opened once and reused. */
let ttyStream: ReadStream | undefined
function ttyInput(): ReadStream {
  if (ttyStream) return ttyStream
  let fd: number
  try { fd = openSync('/dev/tty', 'r+') }
  catch { throw new NoTerminalError('no controlling terminal to prompt on; set SAIP_SECRETS_PASSPHRASE, or run `saip config key add unattended` once a passphrase store exists') }
  ttyStream = new ReadStream(fd)
  return ttyStream
}

/**
 * Bytes that arrived but were not consumed by the previous prompt.
 *
 * This is the fix for a paste that appears to lock the wizard up. A clipboard value usually carries
 * its own trailing newline, so the terminal delivers `value\r` — sometimes several lines at once —
 * in a SINGLE chunk. The first newline ended the prompt and everything after it was previously
 * discarded along with the stream, so the next prompt waited for input that had already arrived and
 * the program looked hung. Retaining the remainder is also what makes scripted input work at all.
 */
const pending = new WeakMap<NodeJS.ReadableStream, string>()

/**
 * Read one line from the terminal.
 *
 * `secret: true` suppresses echo. Doing that requires raw mode, which also turns off `OPOST`, so the
 * terminal will not expand a lone `\n` into carriage-return + line-feed. The old code wrote a bare
 * `\n`, and the cursor walked down to the *same column* where the prompt ended — the "cursor on the
 * line after the variable name" artifact. In raw mode we therefore terminate with `\r\n`, and when
 * echo is on we write nothing, because the terminal already advanced.
 *
 * Bracketed paste mode is enabled while hidden input is expected so a pasted secret's embedded
 * newline is content rather than an accidental submission. Terminals that ignore the sequence still
 * behave, because callers strip trailing newlines.
 */
export function promptTTY(
  question: string,
  opts: { echo?: boolean; secret?: boolean; stream?: ReadStream } = {},
): Promise<string> {
  const hidden = opts.secret ?? (opts.echo === undefined ? true : !opts.echo)
  const stream = opts.stream ?? ttyInput()
  const wasRaw = stream.isRaw
  if (hidden) { try { stream.setRawMode(true) } catch { /* injected stream in tests */ } }
  // Ask the terminal for bracketed paste so a clipboard value's own newlines are content rather
  // than accidental submissions. Older terminals ignore the sequence, which is why a secret
  // containing newlines is better piped — the prompt says so instead of failing quietly.
  if (hidden) process.stdout.write('\u001b[?2004h')
  process.stdout.write(question)

  let value = ''
  let inPaste = false
  let csi = ''                 // CSI parameter bytes, to recognise the paste markers
  // ECMA-48: `ESC [` is a two-byte introducer, and only then do parameter bytes begin. Collapsing
  // this into "ESC then final byte" made `[` itself look final, so a bracketed-paste marker's
  // digits and `~` were treated as typed characters and leaked into the value.
  let escState: 'none' | 'introducer' | 'params' = 'none'

  return new Promise((resolve, reject) => {
    const carryFrom = (text: string, index: number): void => {
      const rest = text.slice(index + 1)
      if (rest) pending.set(stream, (pending.get(stream) ?? '') + rest)
    }
    const cleanup = (): void => {
      if (hidden) { try { stream.setRawMode(!!wasRaw) } catch { /* not a real tty */ } }
      if (hidden) process.stdout.write('\u001b[?2004l')     // leave the terminal as we found it
      stream.removeListener('data', onData)
      stream.removeListener('error', onError)
    }
    const finish = (): void => {
      cleanup()
      // Raw mode has no OPOST, so the line break must carry its own carriage return. A bare \n
      // leaves the cursor under the middle of the prompt — the "cursor on the next line" artifact.
      if (hidden) process.stdout.write('\r\n')
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        const code = ch.codePointAt(0) ?? 0
        if (escState === 'introducer') {
          escState = ch === '[' ? 'params' : 'none'   // other escapes: swallow their next byte
          continue
        }
        if (escState === 'params') {
          if (code >= 0x30 && code <= 0x3f) { csi += ch; continue }
          escState = 'none'
          if (ch === '~' && csi === '200') { inPaste = true; csi = ''; continue }
          if (ch === '~' && csi === '201') { inPaste = false; csi = ''; continue }
          csi = ''
          continue
        }
        if (code === 0x1b) { escState = 'introducer'; csi = ''; continue }
        if (ch === '\n' || ch === '\r') {
          if (inPaste) { value += '\n'; continue }        // pasted newline is content
          carryFrom(text, i)
          return finish()
        }
        if (code === 0x04) { carryFrom(text, i); return finish() }          // Ctrl+D = EOF
        if (code === 0x03) {                                            // Ctrl+C
          value = ''; pending.delete(stream); inPaste = false
          cleanup()
          return reject(new WizardCancelled('cancelled by user'))
        }
        if (code === 0x7f || code === 0x08) { value = value.slice(0, -1); continue }
        if (code < 0x20) continue                                            // never store control bytes
        value += ch
      }
    }
    const onError = (): void => { cleanup(); reject(new WizardCancelled('terminal closed')) }
    stream.on('data', onData)
    stream.once('error', onError)
    const queued = pending.get(stream)
    if (queued) {
      pending.delete(stream)
      // A clipboard value often carries a trailing blank line, and that newline used to submit the
      // NEXT prompt empty — a required secret reported as "left empty" that the user never typed
      // into. Leftover text that contains a real character is typed-ahead input and must survive;
      // a remainder made only of line terminators is the tail of the previous paste, and is dropped.
      if (/^[\r\n\u0004]+$/.test(queued)) {
        /* discarded */
      } else {
        queueMicrotask(() => onData(Buffer.from(queued, 'utf8')))
      }
    }
  })
}


/** True when the libsecret CLI exists. Probed, never assumed (see #68, #73). */
export function hasSecretTool(): boolean {
  try { return spawnSync('which', ['secret-tool'], { encoding: 'utf8' }).status === 0 } catch { return false }
}

/** Runs secret-tool with the passphrase supplied on stdin, as its CLI requires. */
export function secretToolRunner(): SecretToolRunner {
  return (args, stdin) => new Promise((resolve) => {
    const child = spawn('secret-tool', args, { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.on('error', () => resolve({ code: 1, stdout: '' }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: out }))
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

/**
 * The command body, separated from Cordis wiring so it can be driven with an injected store,
 * env, and stdin — which is what lets these paths be tested without a keychain or a terminal.
 */
export function buildStore(deps: RunDeps = {}): SecretStore {
  // Every key source is wired here. Both were unreachable before #73, which is how a fully
  // green test suite coexisted with a `saip config set` that could never create a store:
  // the sources were only ever constructed inside tests.
  const env = deps.env ?? process.env
  const storePath = deps.storePath ?? defaultStorePath(env)
  // The passphrase is the one prompt that must never arrive bare: it is the gate on every other
  // secret, and a user who does not know what it unlocks cannot judge whether to answer.
  const askPassphrase: (q: string) => Promise<string> = async (q) => {
    // The reason is the caller's; the escape hatch is ours. Appending it here means every prompt
    // path offers it, rather than each call site having to remember the same sentence — the kind
    // of "documented in one place, true in another" split this project keeps having to repair.
    const lines: string[] = []
    if (deps.reason) lines.push(deps.reason)
    if (!env.SAIP_SECRETS_PASSPHRASE) {
      lines.push('SAIP_SECRETS_PASSPHRASE skips this prompt; `saip config key add unattended` removes the need for one, at a weaker guarantee (run `saip config doctor` to see it).')
      lines.push('Pasting works. A value that contains newlines is safer piped: printf %s "$VALUE" | saip config set NAME --stdin')
    }
    if (lines.length) process.stdout.write(`[saip] ${lines.join('\n[saip] ')}\n`)
    return deps.prompt ? deps.prompt(q) : promptTTY(q)
  }
  const sources = defaultKeySources(env, {
    prompt: askPassphrase,
    toolRunner: deps.toolRunner ?? (hasSecretTool() ? secretToolRunner() : undefined),
    // Reading has to OFFER every tier that might exist on disk, otherwise `key add
    // unattended` creates a wrap this CLI can never use. Creation stays opt-in — only
    // `key add` provisions the key file — and a store without such a wrap is untouched,
    // because the source returns null when the file is absent.
    allowUnattended: true,
    storePath,
  })
  return new SecretStore({ path: storePath, keySources: sources })
}

/**
 * Cordis hands positionals as strings, so an omitted optional can arrive as the literal
 * 'undefined' or an empty string. Treated as absent, or bare `saip config help` reads as a
 * lookup for a name that does not exist and prints the not-found message instead of the catalog.
 */
function cleanArg(v: string | undefined): string | undefined {
  return !v || v === 'undefined' ? undefined : v
}

function cfgFileForInit() { return resolveConfigFile('saip.yaml', { envVar: 'SAIP_CONFIG' }) }
function readConfigForInit(): any {
  const f = cfgFileForInit()
  try { return f.path ? loadYamlConfig(f.path) : {} } catch { return {} }
}
function readHostsForInit(): any[] {
  const f = resolveConfigFile('hosts.yaml', { envVar: 'SAIP_HOSTS_FILE' })
  try { return f.path ? (loadYamlConfig<{ hosts?: any[] }>(f.path).hosts ?? []) : [] } catch { return [] }
}

export async function runConfig(
  store: SecretStore,
  options: Record<string, unknown> = {},
  positional: string[] = [],
  deps: RunDeps = {},
): Promise<RunResult> {
  const [action, name] = positional
  const env = deps.env ?? process.env
  // Commands that touch the store go through the gateway, which is what makes the access record
  // exist at all — a service registered in the composition root but bypassed by every command is
  // the #76 pattern in a new place, and it is exactly what the first version of this did.
  const access = deps.access ?? new SecretAccess(store, env, `${store.filePath}.access.json`)
  const lines: string[] = []
  const fail = (msg: string): RunResult => ({ code: 1, lines: [`[saip] ${msg}`] })
  if (!action) return fail('usage: saip config <init|help|list|get|set|unset|forget|key|doctor> [name]')

  switch (action) {
    case 'list': {
      let names: string[]
      try { names = await store.names() } catch (e) { return fail((e as Error).message) }
      if (!names.length) return { code: 0, lines: ['[saip] store is empty — no secrets set'] }
      const shadowed = new Set(names.filter((n) => (env[n] ?? '') !== ''))
      return {
        code: 0,
        lines: ['', ...names.map((n) => `  ${n}${shadowed.has(n) ? '  (shadowed by shell env)' : ''}`), ''],
      }
    }

    case 'get': {
      if (!name) return fail('get requires a name')
      let value: string | undefined
      try {
        await access.unlock()
        access.declare('config get', [{ name, purpose: 'displayed to the user' }])
        value = await access.read(name)
      } catch (e) { return fail((e as Error).message) }
      // Display follows the DECLARED flag: a bucket name is ordinary configuration and is shown
      // plainly so it can be checked, while a credential stays masked unless --reveal. Masking
      // everything contradicted the catalog the same release introduced, and hid the very values a
      // user needs to eyeball for the typo that made them run `forget` in the first place.
      const sens = sensitivityOf(name)
      const plain = options.reveal || !sens.sensitive
      const note = sens.declared ? '' : '  (sensitivity inferred — not in the catalog)'
      const shadow = env[name]
      if (shadow) {
        const shown = plain ? shadow : maskValue(shadow)
        return { code: 0, lines: [`[saip] ${name}=${shown}  (from shell environment — shadows the store value)${note}`] }
      }
      if (value === undefined) return fail(`${name} is not set`)
      return { code: 0, lines: [`[saip] ${name}=${plain ? value : maskValue(value)}${note}`] }
    }

    case 'set': {
      if (!name) return fail('set requires a name')
      let value: string | undefined = typeof options.value === 'string' ? options.value : undefined
      // Stdin is read only when explicitly requested. Auto-detecting "not a TTY" looks
      // convenient but is a trap: a script, CI job, or agent that invoked `set` without a
      // value would block forever on a pipe nobody intends to write to — which is exactly how
      // this test suite hung. An explicit --stdin that is not fed still hangs, and that is a
      // bug the caller can see in their own command line rather than one we introduce.
      if (value === undefined && (options.stdin || deps.readStdin)) {
        value = (await (deps.readStdin ?? readStdinLine)()).replace(/\r?\n$/, '')
      }
      if (value === undefined) {
        try { value = (await (deps.prompt ?? ((q) => promptTTY(q, { echo: !isSensitiveName(name) })))(`${name}: `)).replace(/\r?\n$/, '') }
        catch (e) { return fail((e as Error).message) }
      }
      if (!value) return fail('refusing to store an empty value — unset the name instead')
      // Creating the store is the one moment worth confirming: a mistyped passphrase would
      // lock the user out of every secret about to be stored, with no recovery by design.
      let target = store
      if (!target.exists() && !process.env.SAIP_SECRETS_PASSPHRASE) {
        const ask = deps.prompt ?? ((q: string) => promptTTY(q, { echo: false }))
        const first = await ask('choose a passphrase: ')
        if (!first) return fail('a passphrase is required to create the store; nothing was stored')
        if ((await ask('confirm passphrase: ')) !== first) return fail('passphrases did not match; nothing was stored')
        // Rebuild with a source that returns the confirmed passphrase, so the store is keyed
        // by what the user actually typed rather than by a second, possibly different, prompt.
        target = new SecretStore({
          path: target.filePath,
          keySources: defaultKeySources(process.env, {
            prompt: async () => first,
            toolRunner: deps.toolRunner ?? (hasSecretTool() ? secretToolRunner() : undefined),
          }),
        })
      }
      try {
        // Bound to the store that actually wrote. The confirm-on-create path rebuilds the store
        // with the typed passphrase, so an access object captured earlier would read the old
        // instance's key sources and report a successful write as a failure.
        const writer = deps.access ?? new SecretAccess(target, env, `${target.filePath}.access.json`)
        writer.declare('config set', [{ name, purpose: 'value being stored' }])
        await target.set(name, value)
        try {
          // Read it back: proves the write landed and puts the write in the access record.
          // An unverified store is the shape every silent failure in this issue set has taken.
          await writer.unlock()
          if ((await writer.read(name)) !== value) return fail(`${name} did not persist as written`)
        } catch (e) { return fail(`stored ${name} but could not read it back: ${(e as Error).message}`) }
      } catch (e) { return fail((e as Error).message) }
      // Never echo what was just stored, including on the success path.
      return { code: 0, lines: [`[saip] stored ${name} (${value.length} chars)`] }
    }

    case 'unset':
    case 'forget': {
      if (!name) return fail(`${action} requires a name`)
      // One verb, one meaning: `unset` used to clear only the encrypted store, so forgetting an
      // interpolated value (bucket, endpoint) reported "not in the store" while the value stayed
      // in .env and kept winning at resolution. Both names now clear every surface we control and
      // say which ones they touched.
      const r = await forgetValue({ store, name, envPath: envFilePath(process.env), env })
      // Nothing removed is a failure to report, not a success: the old `unset` said
      // "not in the store" for a value sitting in .env, which read like a clean no-op.
      return { code: r.cleared.length ? 0 : 1, lines: r.lines }
    }

    case 'help': {
      const items = planInitItems({ config: readConfigForInit(), hosts: readHostsForInit() })
      // A `say` that collects into the shared buffer AND a returned copy produced a transcript
      // printed twice — found only by running the command, since every unit test called runHelp
      // directly and read only its return value.
      const io: Io = { say: () => {}, ask: async () => '' }
      return await runHelp({ store, items, envPath: envFilePath(process.env), env, only: cleanArg(name), io, formatItem: deps.formatItem })
    }

    case 'doctor': {
      const lines: string[] = ['[saip] secret store']
      lines.push(`  path:        ${store.path}`)
      let unlocked = 'none reachable'
      const ids = store.wrapIds()
      try { unlocked = (await store.activeWrap()) ?? 'none reachable' } catch { /* reported below */ }
      lines.push(`  wraps:       ${ids.length ? ids.join(', ') : 'none (store not created)'}`)
      lines.push(`  unlocked by: ${unlocked}`)
      try {
        const mode = (statSync(store.path).mode & 0o777).toString(8)
        lines.push(`  file mode:   ${mode}`)
        if (mode !== '600' && mode !== '0600') {
          return { code: 1, lines: [...lines, `  [saip] permissive file mode ${mode} — run: chmod 600 ${store.path}`] }
        }
      } catch {
        lines.push('  file mode:   n/a (no store yet)')
      }
      if (!store.exists()) {
        lines.push(`  key sources: passphrase${hasSecretTool() ? ', keyring (secret-tool found)' : ' only — no secret-tool found on this host'}`)
        return { code: 0, lines: [...lines, '  status:      not created (first `set` will create it, prompting for a passphrase)'] }
      }
      try {
        const names = await store.names()
        lines.push(`  status:      readable (${names.length} secret${names.length === 1 ? '' : 's'})`)
        if (store.wrapIds().includes('unattended')) {
          lines.push(`  WARNING:     an 'unattended' wrap exists at ${store.unattendedKeyPath} — these secrets unlock with no passphrase, for any process that can read your home directory`)
        }
        // The answer to "why did it ask me for a password?", readable after the fact.
        try {
          const history = readAudit(`${store.filePath}.access.json`)
          if (history.length) {
            lines.push(`  recent access: ${history.length} record(s), latest first`)
            for (const r of history.slice(-5).reverse()) {
              const when = new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')
              lines.push(`    ${when}  ${r.command} -> ${r.name}${r.declared ? '' : ' (sensitivity inferred)'}: ${r.purpose}`)
            }
          }
        } catch { /* history is diagnostic only */ }
        const shadowed = names.filter((n) => (env[n] ?? '') !== '')
        if (shadowed.length) {
          lines.push(`  note:        ${shadowed.join(', ')} also set in shell — the shell value wins`)
        }
      } catch (e) {
        return { code: 1, lines: [...lines, `  status:      UNREADABLE — ${(e as Error).message}`] }
      }
      return { code: 0, lines }
    }

    case 'key': {
      const sub = positional[1]
      const id = positional[2] as WrapId | undefined
      if (!sub || sub === 'list') {
        const ids = store.wrapIds()
        const active = await store.activeWrap().catch(() => undefined)
        return { code: 0, lines: ['', ...ids.map((w) => `  ${w}${w === active ? '  (unlocked this session)' : ''}`), ''] }
      }
      if (sub === 'add') {
        if (id === 'unattended') {
          // Opt-in only, and explicit about the weaker guarantee it buys.
          try { await store.addWrap(new KeyFileKey(store.unattendedKeyPath)) }
          catch (e) { return fail((e as Error).message) }
          return { code: 0, lines: [`[saip] added 'unattended' wrap; key at ${store.unattendedKeyPath} (mode 600)`, '[saip] WARNING: this unlock method can be used by any process reading your home directory — it defends against repo-scoped readers and other users, not against an agent running as you.'] }
        }
        if (id === 'keyring') {
          if (!hasSecretTool()) return fail('no secret-tool (libsecret) on this host; run `saip config doctor` to see what is available')
          try { await store.addWrap(new SecretToolKey(deps.toolRunner ?? secretToolRunner())) }
          catch (e) { return fail((e as Error).message) }
          return { code: 0, lines: ["[saip] added 'keyring' wrap"] }
        }
        return fail("key add expects 'unattended' or 'keyring'")
      }
      if (sub === 'remove') {
        if (!id) return fail('key remove expects an id')
        try { await store.removeWrap(id) } catch (e) { return fail((e as Error).message) }
        return { code: 0, lines: [`[saip] removed wrap '${id}'`] }
      }
      return fail(`unknown key subcommand "${sub}" (expected list|add|remove)`)
    }

    case 'init': {
      // The onboarding path. Questions come from the user's own saip.yaml/hosts.yaml so a config
      // that declares no API tokens is never asked for token secrets — a hardcoded checklist is
      // how docs and reality drift, which is the disease this issue set has been treating.
      let cfg: any = {}
      try { if (cfgFileForInit().path) cfg = loadYamlConfig(cfgFileForInit().path!) } catch (e) { return fail(`cannot read ${cfgFileForInit().path}: ${(e as Error).message}`) }
      // Same retirement the gateway reports, so the warning appears whether the user starts the
      // gateway or runs the wizard.
      const cfgDeprecations = cfg?.security?.ui?.admin_secret
        ? [`security.ui.admin_secret ("${cfg.security.ui.admin_secret}") is retired (#90): no UI route enforces it and PasswordSessionAuth is never constructed, so it protects nothing. Remove the key; clear a stored value with: saip config forget ${cfg.security.ui.admin_secret}`]
        : []
      const hosts = readHostsForInit()

      // Saying so beats guessing quietly: with no saip.yaml found the plan is built from an
      // empty config, so the user would be asked about R2 only and never about their declared
      // API tokens — and would have no way to know the project file was not read at all.
      // Written before the io object exists would be awkward, so the warning is emitted here in
      // the same immediate style the wizard uses, rather than queued into a buffer that prints late.
      if (!cfgFileForInit().path) {
        process.stdout.write('[saip] WARNING: no saip.yaml found from this directory upward. The questions below\n')
        process.stdout.write('[saip]          come only from the built-in defaults; run this from your project,\n')
        process.stdout.write('[saip]          or set SAIP_CONFIG=/path/to/saip.yaml.\n')
      }

      const items = planInitItems({ config: cfg, hosts })
      const nonInteractive = Boolean(options.nonInteractive)
      // Cards for a human at a terminal, plain labelled lines for pipes, CI, agents and dumb
      // terminals. Chosen once here rather than at each call site (#88).
      // Presentation comes from deps, injected by the command action, because runConfig
      // has no context of its own — keeping it pure is what makes it testable (#76).
      const formatItem = deps.formatItem
      const io: Io = {
        // Immediate. The previous version pushed to `lines`, which the command printed only after
        // the whole wizard finished — so a user saw "NAME: " with none of the guidance that was
        // supposed to come first. That is the defect this closes.
        say: (line) => process.stdout.write(`${line}\n`),
        // --non-interactive never prompts: runInit only calls `ask` when interactive is true, and
        // this guard makes that contract fail loudly rather than opening a terminal mid-report.
        ask: async (question, o) => {
          if (nonInteractive) throw new NoTerminalError('non-interactive mode does not prompt')
          return promptTTY(question, { echo: !o.secret })
        },
      }
      let envPath: string | undefined
      try { envPath = envFilePath(process.env) } catch { envPath = undefined }
      try {
        const r = await runInit({
          store, items, io,
          formatItem,
          deprecations: cfgDeprecations,
          envPath,
          interactive: !nonInteractive,
          answers: nonInteractive ? {} : undefined,
          force: Boolean(options.force),
          reset: typeof options.reset === 'string' ? options.reset : undefined,
        })
        // Nothing is appended to `lines` here: io.say already wrote every line to stdout as it
        // happened. Returning them again would print the whole transcript a second time.
        return { code: r.code, lines: [] }
      } catch (e) {
        if (e instanceof NoTerminalError) {
          return { code: 1, lines: [
            '[saip] no controlling terminal: `saip config init` needs one to hide your typing.',
            '[saip] set values non-interactively instead, e.g.:',
            ...items.filter((x) => x.required).map((i) => i.kind === 'secret'
              ? `  printf %s "$${i.name}" | saip config set ${i.name} --stdin`
              : `  echo '${i.name}=...' >> ${envPath ?? '.env'}`),
          ] }
        }
        if (e instanceof WizardCancelled) {
          // Ctrl+C reaches here when it happens on the passphrase prompt, before the store exists.
          return { code: 130, lines: ['[saip] cancelled. Nothing further was written.'] }
        }
        return fail((e as Error).message)
      }
    }

    default:
      return fail(`unknown subcommand "${action}" (expected init|help|list|get|set|unset|forget|key|doctor)`)
  }
}

const spec: CommandSpec = {
  name: 'config',
  description: 'Manage credentials (init|help|list|get|set|unset|forget|key|doctor)',
  positional: '<action> [name] [arg]',
  positionalDescription: 'subcommand, secret name, and wrap id for `key add|remove`',
  options: [
    { flag: '--value <v>', description: 'Value for `set` (prefer --stdin or the prompt; arguments are visible in ps)' },
    { flag: '--stdin', description: 'Read the value from standard input' },
    { flag: '--reveal', description: 'Print the actual value for `get` (off by default)' },
    { flag: '--force', description: 'With `init`, re-ask values that are already set' },
    { flag: '--non-interactive', description: 'With `init`, report what is missing without prompting or writing anything' },
    { flag: '--reset <name>', description: 'With `init`, clear one value first and re-ask just that one' },
  ],
  action: async () => { /* replaced at registration */ },
}

export interface ConfigPluginOptions { store?: SecretStore }

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context, config: ConfigPluginOptions = {}) {
    ctx.commandRegistry!.register({
      ...spec,
      action: async (_ctx: Context, options, positional) => {
        // Single construction point. A second, separate `new SecretStore(...)` here is what
        // let a real key-source wiring bug live in one path while the other looked correct.
        const store = config.store ?? buildStore({})
        // Cards when a human is at a terminal; plain lines otherwise. Decided once, here, from the
        // DisplayService plugin — no command body branches on isTTY itself (#88).
        const display = _ctx.display
        const formatItem = display && !display.plain
          ? (item: InitItem) => cardGuidance(item, display.options)
          : undefined
        const result = await runConfig(store, options, positional, { formatItem })
        for (const l of result.lines) console.log(l)
        process.exitCode = result.code
      },
    })
  },
}
