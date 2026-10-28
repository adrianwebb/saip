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
 * Parse-level records (#147): the same guarantee, applied where no command action ever ran.
 *
 * Commander decides missing arguments, unknown options, unknown commands, `--help` and `--version`
 * BEFORE `cmd.action` is reached, so a rule enforced inside the action could not cover them — and the
 * result was the one output a machine consumer must not get: empty stdout with exit 1, or 1 KB of human
 * prose where a record was promised.
 *
 * These deliberately reuse the established record shape (`kind: "line"` + `data.code`) rather than
 * inventing a `kind` per condition: records are rendered from blocks (#113), and `not_structured` /
 * `command_failed` / `profile_report` already set the convention of naming the condition in `data`.
 */
/**
 * Text commander wanted to print while `--json` was active.
 *
 * Suppressed at the write (never written and then retracted), because two outputs on one stream is how
 * #115's provenance bug happened. Kept anyway so a `help` record can carry the real usage text rather
 * than commander's internal exception message — under `exitOverride` that message is the literal
 * string `(outputHelp)`, which is worthless to a caller.
 */
let suppressed = ''

export function suppressHumanText(text: string): void { suppressed += text }

export function takeSuppressedText(): string {
  const t = suppressed
  suppressed = ''
  return t
}

export type ParseCondition =
  | 'usage_error' | 'unknown_option' | 'unknown_command' | 'version' | 'help'

export interface ParseDetail {
  command?: string
  flag?: string
  name?: string
  argument?: string
  commands?: string[]
  [k: string]: unknown
}

export function parseRecord(condition: ParseCondition, text: string, detail: ParseDetail = {}): Block {
  const level = condition === 'version' || condition === 'help' ? 'info' : 'error'
  return {
    kind: 'line',
    level,
    text,
    data: { code: condition, ...Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined)) },
  }
}

/**
 * Map a commander failure onto the condition it represents.
 *
 * The library's own codes are stable strings, so this table is checked against the installed
 * commander rather than remembered — an unmapped code still yields a valid `usage_error` record,
 * because "some new commander error prints nothing" is exactly the bug being fixed.
 */
export function classifyCommanderError(code: string | undefined): ParseCondition {
  switch (code) {
    case 'commander.unknownOption': return 'unknown_option'
    case 'commander.unknownCommand': case 'commander.invalidArgument': return 'unknown_command'
    default: return 'usage_error'      // missingArgument, missingMandatoryOptionValue, excessArguments, …
  }
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
