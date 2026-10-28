/**
 * `--json` must produce a record even when no command action ever ran (#147).
 *
 * The guarantee (#113/#115) was enforced inside `cmd.action`, so every path commander resolves BEFORE
 * an action — a missing positional, an unknown option, an unknown command, `--help`, `--version` —
 * fell outside it. The result is the worst output a machine consumer can get: empty stdout with a
 * non-zero exit, or bare human text where a record was promised.
 *
 * Measured against the shipped artifact before the fix (`stdout bytes` counted, not eyeballed):
 *
 *   saip config --json            -> 0 bytes, exit 1     (missing argument)
 *   saip notacommand --json       -> 0 bytes, exit 1
 *   saip status --json --bogus    -> 0 bytes, exit 1     (unknown option)
 *   saip --version --json         -> 5 bytes  "0.7.0"    (bare text, not a record)
 *   saip --help --json            -> 1147 bytes of prose (not a record)
 *
 * Each case is asserted on the three things a script can actually use: stdout parses as exactly one
 * JSON record, `data.code` names the condition, and the exit code keeps its documented meaning.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distBin = join(here, '..', 'dist', 'bin.js')
const built = existsSync(distBin)

function cli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'saip-parse-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(dir, 'home'),
    SAIP_CONFIG: join(dir, 'saip.yaml'),
    SAIP_ENV_FILE: join(dir, '.env'),
    SAIP_SECRETS_FILE: join(dir, 's.enc.json'),
    SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
    SAIP_DRY_RUN: '1',
  }
  const r = spawnSync(process.execPath, [distBin, ...args], { encoding: 'utf8', env, cwd: dir })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** The whole point: stdout is exactly one parseable record. Returns it, failing loudly otherwise. */
function oneRecord(stdout: string, label: string): any {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  expect(lines.length, `${label}: stdout carried ${lines.length} line(s); the guarantee is exactly one record. raw=${JSON.stringify(stdout.slice(0, 160))}`).toBe(1)
  expect(lines[0], `${label}: record is not JSON`).toMatch(/^\{.*\}$/)
  return JSON.parse(lines[0])
}

describe('parse-level --json failures emit a record (#147)', () => {
  it.skipIf(!built)('missing positional: config --json', () => {
    const r = cli(['config', '--json'])
    const rec = oneRecord(r.stdout, 'config --json')
    expect(rec.kind).toBe('line')
    expect(rec.level).toBe('error')
    expect(rec.data?.code).toBe('usage_error')
    expect(r.code).toBe(1)
    expect(rec.text).toMatch(/action|argument|required/i)
  })

  it.skipIf(!built)('unknown option: status --json --bogus', () => {
    const r = cli(['status', '--json', '--bogus'])
    const rec = oneRecord(r.stdout, 'status --json --bogus')
    expect(rec.data?.code).toBe('unknown_option')
    expect(rec.data?.flag).toBe('--bogus')
    expect(rec.data?.command).toBe('status')
    expect(r.code).toBe(1)
  })

  it.skipIf(!built)('a global flag BEFORE the command still names the command in the record', () => {
    // #162's first run surfaced this: the record picked "the first token that does not start with a
    // dash", which for `saip --bogus ./some-file.yaml status --json` is the option's VALUE — an agent
    // reading `data.command` was handed a filename. The token must also be a registered command.
    const r = cli(['--bogus', './not-a-command.yaml', 'status', '--json'])
    const rec = oneRecord(r.stdout, '--bogus ./not-a-command.yaml status --json')
    expect(rec.data?.code).toBe('unknown_option')
    expect(rec.data?.flag).toBe('--bogus')
    expect(rec.data?.command).toBe('status')
  })

  it.skipIf(!built)('unknown command: notacommand --json', () => {
    const r = cli(['notacommand', '--json'])
    const rec = oneRecord(r.stdout, 'notacommand --json')
    expect(rec.data?.code).toBe('unknown_command')
    expect(rec.data?.name).toBe('notacommand')
    // Names the real commands, because "unknown command" alone sends a script hunting. They live in
    // `data.commands` — the structured location — not in the human `text`, which is the message
    // commander actually produced. Asserting the field rather than the prose is the point (#113).
    expect(Array.isArray(rec.data?.commands)).toBe(true)
    expect(rec.data.commands).toContain('status')
    expect(rec.data.commands).toContain('config')
    expect(r.code).toBe(1)
  })

  it.skipIf(!built)('unknown option on the program itself: --nope --json', () => {
    const r = cli(['--nope', '--json'])
    const rec = oneRecord(r.stdout, '--nope --json')
    expect(rec.data?.code).toBe('unknown_option')
    expect(rec.data?.flag).toBe('--nope')
    expect(r.code).toBe(1)
  })
})

describe('--version and --help answer as records under --json (#147)', () => {
  it.skipIf(!built)('--version --json is a record, not bare text', () => {
    const r = cli(['--version', '--json'])
    const rec = oneRecord(r.stdout, '--version --json')
    expect(r.code).toBe(0)
    expect(rec.data?.code).toBe('version')
    expect(rec.text).toMatch(/^\d+\.\d+\.\d+/)
    // Same fields provenance already carries, so an agent does not have to run a second command.
    expect(rec.data?.version).toBeTruthy()
    expect(rec.data?.target).toBeTruthy()
  })

  it.skipIf(!built)('--help --json is a record, not a page of prose', () => {
    const r = cli(['--help', '--json'])
    const rec = oneRecord(r.stdout, '--help --json')
    expect(r.code).toBe(0)
    expect(rec.data?.code).toBe('help')
    expect(Array.isArray(rec.data?.commands)).toBe(true)
    expect(rec.data?.commands).toContain('status')
  })

  it.skipIf(!built)('saip config --help --json is a record naming the command', () => {
    const r = cli(['config', '--help', '--json'])
    const rec = oneRecord(r.stdout, 'config --help --json')
    expect(rec.data?.code).toBe('help')
    expect(rec.data?.command).toBe('config')
    expect(r.code).toBe(0)
  })
})

describe('the human path is untouched (#147)', () => {
  // The fix must not turn machine handling into the only behaviour: without --json these are still
  // commander's normal text output, and `--version` still prints a bare version for `saip --version`.
  it.skipIf(!built)('--version without --json still prints the plain version', () => {
    const r = cli(['--version'])
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(r.stdout).not.toMatch(/^\{/)
    expect(r.code).toBe(0)
  })

  it.skipIf(!built)('--help without --json still prints usage text', () => {
    const r = cli(['--help'])
    expect(r.stdout).toMatch(/Usage: saip/)
    expect(r.stdout).not.toMatch(/^\{/)
    expect(r.code).toBe(0)
  })

  it.skipIf(!built)('a usage error without --json keeps its prose form on stderr', () => {
    const r = cli(['notacommand'])
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/unknown command/i)
    expect(r.code).toBe(1)
  })
})

describe('exit codes keep their documented meaning (#147)', () => {
  it.skipIf(!built)('0 success, 1 usage/failure, 2 refused-for-no-records', () => {
    expect(cli(['--version', '--json']).code).toBe(0)
    expect(cli(['config', '--json']).code).toBe(1)
    expect(cli(['awake', '--json']).code).toBe(2)      // #113 refusal, pre-existing
  })
})
