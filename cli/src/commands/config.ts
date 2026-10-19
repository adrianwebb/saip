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
import { statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { SecretStore, defaultStorePath, defaultKeySources } from '@saip/shared'
import type { CommandSpec } from '../lib/command-registry.js'

export interface RunDeps {
  /** Environment used to detect shadowing. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Injectable stdin reader so tests need no TTY. */
  readStdin?: () => Promise<string>
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

/**
 * The command body, separated from Cordis wiring so it can be driven with an injected store,
 * env, and stdin — which is what lets these paths be tested without a keychain or a terminal.
 */
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
      // A pipe is not a terminal: reading stdin automatically when it is redirected means
      // `printf secret | saip config set NAME` works without a flag, and the hidden prompt only
      // runs when a human is actually at a keyboard.
      const piped = !process.stdin.isTTY
      if (value === undefined && (options.stdin || piped || deps.readStdin)) {
        value = (await (deps.readStdin ?? readStdinLine)()).replace(/\r?\n$/, '')
      }
      if (value === undefined) value = (await promptHidden(`${name}: `)).replace(/\r?\n$/, '')
      if (!value) return fail('refusing to store an empty value — unset the name instead')
      try { await store.set(name, value) } catch (e) { return fail((e as Error).message) }
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
      let source = 'unknown'
      let readable = true
      try { source = await store.activeKeySource() } catch { readable = false }
      lines.push(`  key source:  ${source}`)
      try {
        const mode = (statSync(store.path).mode & 0o777).toString(8)
        lines.push(`  file mode:   ${mode}`)
        if (mode !== '600' && mode !== '0600') {
          return { code: 1, lines: [...lines, `  [saip] permissive file mode ${mode} — run: chmod 600 ${store.path}`] }
        }
      } catch {
        lines.push('  file mode:   n/a (no store yet)')
      }
      if (!store.exists()) return { code: 0, lines: [...lines, '  status:      not created (first `set` will create it)'] }
      try {
        const names = await store.names()
        lines.push(`  status:      readable (${names.length} secret${names.length === 1 ? '' : 's'})`)
        const shadowed = names.filter((n) => (env[n] ?? '') !== '')
        if (shadowed.length) {
          lines.push(`  note:        ${shadowed.join(', ')} also set in shell — the shell value wins`)
        }
      } catch (e) {
        return { code: 1, lines: [...lines, `  status:      UNREADABLE — ${(e as Error).message}`] }
      }
      void readable
      return { code: 0, lines }
    }

    default:
      return fail(`unknown subcommand "${action}" (expected list|get|set|unset|doctor)`)
  }
}

const spec: CommandSpec = {
  name: 'config',
  description: 'Manage the encrypted local secret store (list|get|set|unset|doctor)',
  positional: '<action> [name]',
  positionalDescription: 'subcommand and secret name',
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
