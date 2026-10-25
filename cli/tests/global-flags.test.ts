/**
 * `--config` and `--env` are real global flags (#149) — tested at the level a user observes them.
 *
 * Four flags used to sit in the CLI reference's Global Options table with no code behind any of them;
 * every one exited `error: unknown option` (#149, and the same class again at #114 and #162). Two of
 * them are being put back *with* the behaviour documented; two are declared out of scope in the
 * reference rather than left half-promised. These tests are written first, against the built program,
 * because the claim is about the program: "which file did this run read?" is answerable from a unit
 * test of `resolveConfigFile` without the CLI ever being wired to it — which is exactly how the
 * documented-but-unwired state survived this long.
 *
 * The precedence being pinned is the one the reference already promised: **flag > `SAIP_*` >
 * discovery**. And the failure mode worth the most attention is the quiet one: a flag accepted, then
 * ignored, or a path that does not exist falling back to whatever the directory happens to hold. A
 * credential read from the wrong file looks like a working tool.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const distBin = join(repoRoot, 'cli/dist/bin.js')

/**
 * Two projects, one obvious difference: the bucket each declares.
 *
 * `flag` is only reachable by pointing at it; `cwd` is what upward discovery finds, because the run
 * happens inside it. Anything that makes the two indistinguishable would let a broken flag pass.
 */
function twoProjects(withEnvInterpolation = false): { cwd: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), 'saip-149-'))
  const cwd = join(root, 'project')
  const other = join(root, 'elsewhere')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(cwd, 'saip.yaml'), 'storage:\n  r2:\n    bucket: bucket-of-the-working-directory\n')
  writeFileSync(join(other, 'saip.yaml'), 'storage:\n  r2:\n    bucket: bucket-named-by-the-flag\n')
  writeFileSync(join(cwd, 'hosts.yaml'), 'hosts: []\n')
  writeFileSync(join(cwd, '.env'), withEnvInterpolation
    ? 'SAIP_R2_BUCKET=bucket-from-the-cwd-file\n' : 'SAIP_R2_BUCKET=env-in-the-working-directory\n')
  writeFileSync(join(other, '.env'), withEnvInterpolation
    ? 'SAIP_R2_BUCKET=bucket-from-the-other-file\n' : 'SAIP_R2_BUCKET=env-named-by-the-flag\n')
  if (withEnvInterpolation) {
    // Interpolated, so the .env choice is visible in `status`'s own output rather than only in a
    // report about where a value came from.
    writeFileSync(join(cwd, 'saip.yaml'), 'storage:\n  r2:\n    bucket: ${SAIP_R2_BUCKET}\n')
    writeFileSync(join(other, 'saip.yaml'), 'storage:\n  r2:\n    bucket: ${SAIP_R2_BUCKET}\n')
  }
  return { cwd, other }
}

function cli(args: string[], opts: { cwd: string; env?: Record<string, string> } = { cwd: '.' }) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Nothing this shell exports may leak in: the maintainer's shell sets SAIP_R2_BUCKET, which is how a
  // first pass of #110's row 5 "failed" for a reason that lived in the driver.
  for (const k of Object.keys(env)) if (k.startsWith('SAIP_')) delete env[k]
  env.SAIP_HOSTS_FILE = join(opts.cwd, 'hosts.yaml')
  Object.assign(env, opts.env ?? {})
  const r = spawnSync(process.execPath, [distBin, ...args], { cwd: opts.cwd, env, encoding: 'utf8', timeout: 30_000 })
  // `out` is both streams for prose assertions; `stdout` is kept separate because #113's rule is that
  // the machine stream carries records ONLY — a test that concatenates the two and then parses lines as
  // JSON fails on a provenance line that is sitting exactly where it belongs (and did, on its first run
  // of this file).
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('--config selects saip.yaml for the run (#149)', () => {
  it('is accepted, and the file it names is the one that gets read', () => {
    const { cwd, other } = twoProjects()
    const without = cli(['status'], { cwd })
    expect(without.out).toContain('bucket-of-the-working-directory')   // the fixture proves discovery works
    const withFlag = cli(['--config', join(other, 'saip.yaml'), 'status'], { cwd })
    expect(withFlag.out).not.toMatch(/unknown option/)
    expect(withFlag.out).toContain('bucket-named-by-the-flag')
    expect(withFlag.out).not.toContain('bucket-of-the-working-directory')
  })

  it('works after the command too, because users type it both ways', () => {
    const { cwd, other } = twoProjects()
    const r = cli(['status', '--config', join(other, 'saip.yaml')], { cwd })
    expect(r.out).not.toMatch(/unknown option/)
    expect(r.out).toContain('bucket-named-by-the-flag')
  })

  it('beats SAIP_CONFIG, which beats discovery', () => {
    const { cwd, other } = twoProjects()
    const envOnly = cli(['status'], { cwd, env: { SAIP_CONFIG: join(other, 'saip.yaml') } })
    expect(envOnly.out).toContain('bucket-named-by-the-flag')          // env already won over discovery
    const flagWins = cli(['--config', join(cwd, 'saip.yaml'), 'status'], {
      cwd, env: { SAIP_CONFIG: join(other, 'saip.yaml') },
    })
    expect(flagWins.out).toContain('bucket-of-the-working-directory')  // flag wins over env
  })

  it('refuses a path that does not exist instead of quietly reading another project', () => {
    const { cwd } = twoProjects()
    const missing = join(cwd, 'no-such-project.yaml')
    const r = cli(['--config', missing, 'status'], { cwd })
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/no-such-project\.yaml/)                     // names the path it was given
    expect(r.out).not.toContain('bucket-of-the-working-directory')     // no fallback to discovery
  })
})

describe('--env selects the .env for the run (#149)', () => {
  // Which surfaces may be asserted: the file is READ by the shared loader that interpolates
  // `saip.yaml` (`defaultEnvFile()` = `SAIP_ENV_FILE ?? '.env'`) and by the wizard's own
  // "where is this already set?" report. Verified before writing these cases, because the first draft
  // asserted `config get SAIP_R2_BUCKET` would resolve from the file — and it does not: the gateway's
  // chain is shell + encrypted store. That inconsistency (the wizard says a value is set in `.env`,
  // `config get` says it is not set) is tracked separately rather than fixed sideways here.
  it('is accepted, and the file it names is the one interpolation resolves from', () => {
    const { cwd, other } = twoProjects(true)
    const r = cli(['--env', join(other, '.env'), 'status'], { cwd })
    expect(r.out).not.toMatch(/unknown option/)
    expect(r.out).toContain('bucket-from-the-other-file')
    expect(r.out).not.toContain('bucket-from-the-cwd-file')
  })

  it('is what the wizard reports as the source of a value', () => {
    const { cwd, other } = twoProjects(true)
    const r = cli(['--env', join(other, '.env'), 'config', 'init', '--non-interactive'], { cwd })
    expect(r.out).toMatch(/source: \(\.env\) — current value: bucket-from-the-other-file/)
  })

  it('beats SAIP_ENV_FILE and refuses a missing path', () => {
    const { cwd, other } = twoProjects(true)
    const wins = cli(['--env', join(other, '.env'), 'status'], { cwd, env: { SAIP_ENV_FILE: join(cwd, '.env') } })
    expect(wins.out).toContain('bucket-from-the-other-file')
    const missing = cli(['--env', join(cwd, 'absent.env'), 'status'], { cwd })
    expect(missing.code).not.toBe(0)
    expect(missing.out).toMatch(/absent\.env/)
    expect(missing.out).not.toContain('bucket-from-the-cwd-file')     // no silent fallback
  })
})

describe('the flags are part of the documented surface (#149, #162)', () => {
  it('help lists both, before and after a command', () => {
    const { cwd } = twoProjects()
    const r = cli(['--help'], { cwd })
    expect(r.out).toMatch(/--config <path>/)
    expect(r.out).toMatch(/--env <path>/)
    // The reference's Global Options table claims these apply to every command, and #162's guard checks
    // per-command, so the per-command help must show them too.
    for (const cmd of ['status', 'awake', 'profiles']) {
      const sub = cli([cmd, '--help'], { cwd })
      expect(sub.out, `saip ${cmd} --help must list --config`).toMatch(/--config <path>/)
      expect(sub.out, `saip ${cmd} --help must list --env`).toMatch(/--env <path>/)
    }
  })

  it('a machine run reports the chosen file, not just a well-formed refusal', () => {
    const { cwd, other } = twoProjects()
    const r = cli(['--config', join(other, 'saip.yaml'), 'profiles', '--json'], { cwd })
    const lines = r.stdout.split('\n').filter(Boolean)
    expect(lines.length, `no records on stdout; stderr said: ${r.stderr.slice(0, 160)}`).toBeGreaterThan(0)
    const records = lines.map((l) => JSON.parse(l) as { kind?: string; level?: string; text?: string; data?: Record<string, unknown> })
    // Asserted because the first draft of this case was vacuous: a broken `--config` also produced
    // parseable JSONL (#147's parse-level record), so "it did not crash" passed while the flag did not
    // exist. Well-formed output is not the contract; the flag being accepted is.
    expect(records.some((x) => x.data?.code === 'unknown_option'), r.out).toBe(false)
    // `other/saip.yaml` declares no profiles block, so the honest answer is a named config error.
    expect(records[0]?.level).toBe('error')
    expect(String(records[0]?.text)).toMatch(/no `profiles:` block|profiles/)
  })
})
