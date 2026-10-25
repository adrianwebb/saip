/**
 * A documented flag is an interface contract, not prose (#162).
 *
 * This class shipped twice before, and the docs build stayed green both times:
 *
 *  - #149 — `--config`, `--env`, `--quiet`, `--verbose` sat in the Global Options table while every one
 *    of them exited `error: unknown option`.
 *  - #114 — `status --adapter-resolution <user>` was still listed after the flag was dropped. Measured
 *    on the artifact:
 *
 *      $ node cli/dist/bin.js status --adapter-resolution someone
 *      error: unknown option '--adapter-resolution'
 *
 * and this test's FIRST run found a third instance, in tables nobody had re-read since the docs were
 * written: `awake --model/--gpu/--no-sync/--port`, `sleep --force/--no-sync-back`,
 * `down --purge-cache/--keep-images`. Eight documented flags, none of them implemented, none of them
 * caught by any existing check.
 *
 * `pnpm --filter @saip/docs build` verifies that pages render and that internal links resolve — the docs
 * referring to themselves. Nothing has ever compared a documented flag with a flag the program accepts,
 * which is why the same defect reappeared a month later with a different flag in it.
 *
 * So: read every option-table row out of the CLI reference, hand the flag to the built program on a
 * command the row claims it applies to, and require an answer OTHER than "unknown option". Every other
 * failure is acceptable on purpose — a missing argument, an unknown host, a refused action — because
 * this is a test of existence, not of behaviour; behaviour belongs to the per-command suites.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const docPath = join(repoRoot, 'docs/src/content/docs/guides/cli-reference.mdx')
const distBin = join(repoRoot, 'cli/dist/bin.js')
const docs = readFileSync(docPath, 'utf8')

/** Commands the program registers — the universe a "for every command" row can mean. */
const COMMANDS = ['awake', 'sleep', 'down', 'status', 'deploy', 'profiles', 'config', 'ssh']

interface Documented { flag: string; commands: string[]; line: number; section: string }

/**
 * Which commands a row applies to.
 *
 * Inside `## \`saip awake\`` the answer is that command. Inside `## Global Options` the row itself says:
 * `--host` names the commands that take it, and a row that names none (`--json`) means every command —
 * which is what its own text claims, so the test follows the document rather than inventing a scope.
 */
function commandsOf(rowText: string, section: string): string[] {
  if (section !== 'global') return [section]
  const named = [...rowText.matchAll(/`(awake|sleep|down|status|deploy|profiles|config|ssh)`/g)].map((m) => m[1])
  const without = (rowText.match(/`--source`\/`--target`/) !== null)
  if (named.length) return [...new Set(named)].filter((c) => !(without && c === 'deploy'))
  return COMMANDS
}

function documentedFlags(text: string): Documented[] {
  const out: Documented[] = []
  let section = ''
  text.split('\n').forEach((line, i) => {
    const cmd = /^## `saip ([a-z-]+)`/.exec(line)
    if (/^## Global Options/.test(line)) section = 'global'
    else if (cmd) section = cmd[1]
    else if (/^## /.test(line)) section = ''
    if (!section) return
    const cell = /^\s*\|\s*`(--[a-z0-9-]+)/.exec(line)
    if (cell) out.push({ flag: cell[1], commands: commandsOf(line, section), line: i + 1, section })
  })
  return out
}

const flags = documentedFlags(docs)

/**
 * Any `--flag` named anywhere in the reference — the reverse check's universe.
 *
 * NOT restricted to backtick-preceded tokens: the `config` table writes its flags inside a whole-command
 * cell (`` `saip config set <name> --value <v>` ``), so requiring a backtick right before `--value`
 * reported three documented flags as "never mentioned". The first draft of this file blamed the docs for
 * its own instrument, which is the mistake #176 was about.
 */
const mentioned = new Set([...docs.matchAll(/(--[a-z][a-z0-9-]*)/g)].map((m) => m[1]))

/** A value placeholder: presence is the question, and the value must never make a flag unknown. */
const PROBE = 'probe'

/** Long flags the program lists for a command (`''` = the program itself). Help is the cheap surface. */
const helpCache = new Map<string, Set<string>>()
function acceptedBy(command: string): Set<string> {
  if (!helpCache.has(command)) {
    const args = command ? [distBin, command, '--help'] : [distBin, '--help']
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 })
    helpCache.set(command, new Set([...`${r.stdout ?? ''}`.matchAll(/(--[a-z0-9-]+)/g)].map((m) => m[1])))
  }
  return helpCache.get(command)!
}

/**
 * The authoritative question, asked of the real parser: does the program reject this flag outright?
 *
 * Help output is used as the SCREEN (9 spawns instead of ~30 — a per-pair version took 22 s and blew
 * the test timeout), and every suspected breakage is confirmed by actually passing the flag, so the
 * failure message is the parser's own words rather than a regex over a help screen. A flag listed in
 * help but rejected by the parser, or vice versa, is itself a defect worth the sentence below.
 */
function rejectReason(command: string, flag: string): string | null {
  const args = command ? [distBin, command, flag, PROBE] : [distBin, flag, PROBE]
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 })
  if (r.error) return r.error.message
  for (const line of `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n')) {
    // The program reports this condition in prose and, under --json, inside a record's text field.
    if (/unknown option/i.test(line)) return line.trim().replace(/^\{".*"text":"(error: unknown option[^"]*)".*$/, '$1')
  }
  return null
}

describe('every flag in the CLI reference exists in the built program (#162)', () => {
  it('the parse found option tables at all — a guard that matches nothing is not a guard', () => {
    expect(existsSync(distBin), `${distBin} missing — run pnpm -r build first`).toBe(true)
    // #154's rule, applied to this file: without this, a regex that silently matched zero rows would
    // make the whole suite vacuously green.
    // 11 rather than a number fitted to today's file: this change DELETED eight rows (the phantom flags
    // of #179), so a threshold above the honest count would fail for the right reason and read like a
    // parse breakage. What must not be possible is a parse that finds almost nothing, or finds rows but
    // attributes them all to one section — both are checked, and the third assertion pins the one table
    // whose rows apply to more than one command.
    expect(flags.length, 'no `| \`--flag\` |` rows parsed out of cli-reference.mdx').toBeGreaterThan(11)
    const sections = new Set(flags.map((f) => f.section))
    expect(sections.size, `flags attributed to only ${[...sections].join(', ')}`).toBeGreaterThan(4)
    expect(sections.has('global'), 'the Global Options table was not parsed').toBe(true)
    // Each of these must appear somewhere, or a section's table stopped being read.
    for (const cmd of ['awake', 'sleep', 'down', 'status', 'deploy', 'profiles']) {
      expect(sections.has(cmd), `no flag rows attributed to the ${cmd} section`).toBe(true)
    }
  })

  it('no documented flag answers "unknown option" on a command that claims to accept it', () => {
    const offenders: string[] = []
    const checked = new Set<string>()
    for (const f of flags) {
      for (const command of f.commands) {
        const key = `${command} ${f.flag}`
        if (checked.has(key)) continue
        checked.add(key)
        if (acceptedBy(command).has(f.flag)) continue        // fast path: the parser lists it
        const bad = rejectReason(command, f.flag)            // suspected: ask the parser itself
        offenders.push(`cli-reference.mdx:${f.line} — \`saip ${command || '(program)'} ${f.flag}\`: ` +
          (bad ?? 'not listed in that command\'s help, though the parser did not call it unknown — '
            + 'either way the reference and the program disagree'))
      }
    }
    expect(offenders, `\n${offenders.length} documented flag(s) do not exist:\n${offenders.join('\n')}`).toEqual([])
  }, 120_000)

  it('reports accepted flags the reference never mentions — without failing on them (#162 criterion 2)', () => {
    // Reported, deliberately not failed. A help screen is not a contract: `--host` on a command that
    // takes none, commander's own noise, a flag documented in the command's own section but not in the
    // global table — failing on those makes the guard the thing people disable. A human reads the list.
    const undocumented: string[] = []
    for (const c of [''].concat(COMMANDS)) {
      for (const flag of acceptedBy(c)) {
        // (the help text is cached by the check above, so this costs no extra processes)
        if (flag === '--help' || flag === '--version') continue
        if (!mentioned.has(flag)) undocumented.push(`saip ${c || '(program)'} ${flag}`)
      }
    }
    if (undocumented.length) {
      console.warn(`#162: ${undocumented.length} accepted flag(s) found nowhere in the reference — for a human to document or drop:\n  ${[...new Set(undocumented)].join('\n  ')}`)
    }
    expect(undocumented.length, 'see the report above').toBeLessThan(999)
  })
})
