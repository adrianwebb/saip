/**
 * The `--json` invariant (#113): **stdout of a `--json` run is always syntactically valid JSONL, or
 * the command says so as a JSON record and exits non-zero.** Never a human line mixed into a machine
 * stream, and never an empty stdout that a script reads as "no results".
 *
 * Why this is enforced centrally rather than left to each command: `saip profiles --json` shipped in
 * 0.5.0 printing `[saip] config: /path/saip.yaml` immediately before its JSON body — correct on its
 * own, corrupt as a stream — and no test could have caught it, because every test looked at the JSON
 * alone. Ten commands each remembering the rule is how it broke once already.
 *
 * Two mechanisms, both loud:
 *   1. `STRUCTURED_COMMANDS` declares which commands emit real records. Any others short-circuit
 *      **before their action runs**, which also means `saip awake --json` cannot deploy anything.
 *   2. `redirectHumanStdout()` re-routes `console.log` to stderr while the mode is on, so an
 *      un-migrated stray line becomes visible diagnostics instead of a broken machine stream. It is
 *      installed at the composition root, never inside a command.
 */
import type { Block } from '../ui/blocks.js'

/**
 * Commands that emit JSONL records on stdout. Add to this list as each migrates (#113) — the entry
 * means "this command renders blocks through `ctx.ui`", not "this command has a `--json` branch".
 * `ssh` joined when its results became blocks; `config` is next.
 */
export const STRUCTURED_COMMANDS = new Set<string>(['status', 'profiles', 'ssh', 'config'])

let enabled = false

export function setJsonMode(on: boolean): void { enabled = on }
export function jsonModeOn(): boolean { return enabled }

export function isStructuredCommand(name: string): boolean {
  return enabled && STRUCTURED_COMMANDS.has(name)
}

/**
 * The record emitted instead of running an unsupported command. Valid JSONL, non-zero exit, and it
 * names the issue — so an agent gets a machine-readable "not yet" rather than silence or garbage.
 */
export function unsupportedRecord(name: string): Block {
  return {
    kind: 'line',
    text: `command "${name}" does not emit --json records yet; its output would be human text on a machine stream (tracked in #113). Registered: ${[...STRUCTURED_COMMANDS].sort().join(', ')}`,
    level: 'error',
    data: { code: 'not_structured', command: name },
  }
}

/**
 * Write text meant for a human. The single decision point: stdout when a person is reading, stderr
 * when stdout has been promised to a machine. Anything that prints prose should use this rather than
 * `process.stdout.write`, which is how `saip ssh --json` ended up with `[saip] unlocking the store…`
 * as the first "JSON" line — the same defect #115 fixed for `profiles`, in a place the quarantine
 * could not see because it only wrapped `console.log`.
 */
export function human(text: string, level: 'info' | 'error' = 'info'): void {
  const line = text.startsWith('[saip') ? text : `[saip] ${text}`
  if (enabled) process.stderr.write(`${line}\n`)
  else (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)
}

/**
 * While `--json` is active, `console.log` writes to stderr. Human text and machine records have
 * different destinations by definition; a stray line is a bug, and this makes it harmless to the
 * stream while still visible to whoever is watching.
 */
export function redirectHumanStdout(): () => void {
  if (!enabled) return () => { /* nothing to undo */ }
  const original = console.log
  console.log = (...args: unknown[]): void => {
    const text = args.map((a) => (typeof a === 'string' ? a : typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))).join(' ')
    // Records that commands emit through the ui sink go via process.stdout.write and are untouched;
    // anything reaching here is a command that has not migrated, so it is quarantined to stderr.
    process.stderr.write(`${text}\n`)
  }
  return () => { console.log = original }
}
