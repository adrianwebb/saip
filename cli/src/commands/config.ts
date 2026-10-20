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
import { SecretStore, defaultStorePath, defaultKeySources, KeyFileKey, SecretToolKey, type SecretToolRunner, type WrapId } from '@saip/shared'
import type { CommandSpec } from '../lib/command-registry.js'

export interface RunDeps {
  /** Environment used to detect shadowing. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Injectable stdin reader so tests need no TTY. */
  readStdin?: () => Promise<string>
  /** Injectable secret prompt so tests need no TTY. */
  prompt?: (q: string) => Promise<string>
  /** Injectable keychain runner; omitted means probe the host for secret-tool. */
  toolRunner?: SecretToolRunner
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
export function promptTTY(question: string): Promise<string> {
  let fd: number
  try { fd = openSync('/dev/tty', 'r+') }
  catch { throw new NoTerminalError('no controlling terminal to prompt on; set SAIP_SECRETS_PASSPHRASE, or run `saip config key add unattended` once a passphrase store exists') }
  const stream = new ReadStream(fd)
  const wasRaw = stream.isRaw
  stream.setRawMode(true)
  process.stderr.write(question)
  let value = ''
  return new Promise((resolve) => {
    const done = () => {
      stream.setRawMode(!!wasRaw)
      stream.destroy()
      process.stderr.write('\n')
      resolve(value)
    }
    stream.on('data', (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\n' || ch === '\r') return done()
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if ((ch.codePointAt(0) ?? 0) >= 0x20) value += ch
      }
    })
    stream.once('error', done)
  })
}

/** Prompt with echo disabled, used when no value was supplied and stdin is not a pipe. */
async function promptHidden(question: string): Promise<string> {
  const ttyMod = await import('node:tty')
  const tty = !!ttyMod.isatty(0)
  const wasRaw = process.stdin.isRaw
  if (tty) process.stdin.setRawMode(true)
  process.stderr.write(question)
  let value = ''
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\n' || ch === '\r') {
          process.stdin.removeListener('data', onData)
          if (tty) process.stdin.setRawMode(!!wasRaw)
          process.stderr.write('\n')
          return resolve(value)
        }
        if (ch === '') value = value.slice(0, -1)
        else if (ch.codePointAt(0)! >= 0x20) value += ch
      }
    }
    process.stdin.on('data', onData)
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
  const sources = defaultKeySources(process.env, {
    prompt: deps.prompt ?? promptHidden,
    toolRunner: deps.toolRunner ?? (hasSecretTool() ? secretToolRunner() : undefined),
  })
  return new SecretStore({ path: defaultStorePath(), keySources: sources })
}

export async function runConfig(
  store: SecretStore,
  options: Record<string, unknown> = {},
  positional: string[] = [],
  deps: RunDeps = {},
): Promise<RunResult> {
  const [action, name] = positional
  const env = deps.env ?? process.env
  const fail = (msg: string): RunResult => ({ code: 1, lines: [`[saip] ${msg}`] })
  if (!action) return fail('usage: saip config <list|get|set|unset|doctor> [name]')

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
      try { value = await store.get(name) } catch (e) { return fail((e as Error).message) }
      const shadow = env[name]
      if (shadow) {
        const shown = options.reveal ? shadow : maskValue(shadow)
        return { code: 0, lines: [`[saip] ${name}=${shown}  (from shell environment — shadows the store value)`] }
      }
      if (value === undefined) return fail(`${name} is not set`)
      return { code: 0, lines: [`[saip] ${name}=${options.reveal ? value : maskValue(value)}`] }
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
        try { value = (await (deps.prompt ?? ((q) => promptTTY(q)))(`${name}: `)).replace(/\r?\n$/, '') }
        catch (e) { return fail((e as Error).message) }
      }
      if (!value) return fail('refusing to store an empty value — unset the name instead')
      // Creating the store is the one moment worth confirming: a mistyped passphrase would
      // lock the user out of every secret about to be stored, with no recovery by design.
      let target = store
      if (!target.exists() && !process.env.SAIP_SECRETS_PASSPHRASE) {
        const ask = deps.prompt ?? promptTTY
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
      try { await target.set(name, value) } catch (e) { return fail((e as Error).message) }
      // Never echo what was just stored, including on the success path.
      return { code: 0, lines: [`[saip] stored ${name} (${value.length} chars)`] }
    }

    case 'unset': {
      if (!name) return fail('unset requires a name')
      let removed = false
      try { removed = await store.unset(name) } catch (e) { return fail((e as Error).message) }
      return removed
        ? { code: 0, lines: [`[saip] removed ${name}`] }
        : fail(`${name} was not set`)
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

    default:
      return fail(`unknown subcommand "${action}" (expected list|get|set|unset|key|doctor)`)
  }
}

const spec: CommandSpec = {
  name: 'config',
  description: 'Manage the encrypted local secret store (list|get|set|unset|key|doctor)',
  positional: '<action> [name] [arg]',
  positionalDescription: 'subcommand, secret name, and wrap id for `key add|remove`',
  options: [
    { flag: '--value <v>', description: 'Value for `set` (prefer --stdin or the prompt; arguments are visible in ps)' },
    { flag: '--stdin', description: 'Read the value from standard input' },
    { flag: '--reveal', description: 'Print the actual value for `get` (off by default)' },
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
        const store = config.store ?? new SecretStore({
          path: defaultStorePath(),
          keySources: defaultKeySources(),
        })
        const result = await runConfig(store, options, positional)
        for (const l of result.lines) console.log(l)
        process.exitCode = result.code
      },
    })
  },
}
