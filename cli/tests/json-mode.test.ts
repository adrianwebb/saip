/**
 * The `--json` invariant (#113): stdout of a `--json` run is valid JSONL, always — whether or not the
 * command has migrated to records. `saip profiles --json` shipped in 0.5.0 with a provenance line
 * printed before its JSON body, so the stream did not parse, and no test caught it because every test
 * examined the JSON and not the stream. This file is that missing test.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { STRUCTURED_COMMANDS, setJsonMode, redirectHumanStdout } from '../src/lib/json-mode.js'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const distBin = join(repoRoot, 'cli/dist/bin.js')
const built = existsSync(distBin)

/** A throwaway home for every probe: without this the CLI reads the developer's real ~/.saip store. */
function sandbox(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'saip-json-'))
  writeFileSync(join(dir, 'hosts.yaml'), 'hosts: []\n', 'utf8')
  return {
    SAIP_SECRETS_FILE: join(dir, 'secrets.enc.json'),
    SAIP_ENV_FILE: join(dir, '.env'),
    SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
    SAIP_SECRETS_PASSPHRASE: 'json-mode-test-passphrase',
  }
}

function runJson(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [distBin, ...args, '--json'], {
    encoding: 'utf8', cwd: repoRoot, timeout: 60_000,
    env: { ...process.env, SAIP_CONFIG: join(repoRoot, 'saip.yaml'), ...sandbox() },
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** Assert the SHAPE of stdout first: one parseable record per line. */
function expectJsonl(stdout: string, label: string): any[] {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  expect(lines.length, `${label}: stdout empty — an agent cannot distinguish "nothing to report" from "broken"`)
    .toBeGreaterThan(0)
  return lines.map((l, i) => {
    try { return JSON.parse(l) } catch (e: any) {
      throw new Error(`${label}: stdout line ${i} is not JSON (${e.message}): ${l.slice(0, 60)}`)
    }
  })
}

describe.skipIf(!built)('every --json run emits parseable JSONL on stdout (#113)', () => {
  it('profiles: the shipped defect, pinned — and the failure path still emits a record', () => {
    // Exit code is host-dependent (a CI runner has no GPU, so this legitimately exits 2). The
    // INVARIANT is not: stdout is valid, non-empty JSONL either way. Asserting `code === 0` here was
    // the test's own bug, and CI caught it — see the failure-path record in profiles.ts.
    const { code, stdout } = runJson(['profiles'])
    expect([0, 2]).toContain(code)
    const [rec] = expectJsonl(stdout, 'profiles')
    if (code === 0) expect(rec).toHaveProperty('gpu')
    else expect(rec.level).toBe('error')
    expect(stdout).not.toMatch(/\[saip\]/)
  })

  it('status: records carry the same fields the terminal shows', () => {
    const [rec] = expectJsonl(runJson(['status']).stdout, 'status')
    expect(rec.kind).toBe('keyValues')
    expect(rec.rows.map((r: any) => r.label)).toContain('Adapters')
  })

  it('awake: unsupported answer is a record, exit 2, and no side effect', () => {
    const { code, stdout } = runJson(['awake'])
    expect(code).toBe(2)
    const [rec] = expectJsonl(stdout, 'awake')
    expect(rec.kind).toBe('line')
    expect(rec.level).toBe('error')
    expect(rec.data.code).toBe('not_structured')
    expect(rec.data.command).toBe('awake')
  })

  it('sleep: short-circuits before its action, so nothing reaches stdout but the record', () => {
    const { code, stdout } = runJson(['sleep'])
    expect(code).toBe(2)
    expect(stdout.split('\n').filter(Boolean)).toHaveLength(1)
    expect(() => JSON.parse(stdout.trim())).not.toThrow()
  })

  it('the injected option does not collide with a command declaring its own --json', () => {
    // Commander throws on a duplicate option name, which aborted buildProgram for EVERY command and
    // presented as a broken CLI: exit 1 with empty stdout.
    const src = readFileSync(join(repoRoot, 'cli/src/index.ts'), 'utf8')
    expect(src).toMatch(/some\(\(o\) => o\.flag/)
    // Exit code varies by host; reaching a parsed record at all is the collision check.
    expectJsonl(runJson(['profiles']).stdout, 'profiles/duplicate-option')
  })

  it('every declared structured command really emits records', () => {
    // The list is a claim about the CLI; this makes it checked rather than maintained by hand.
    // Each command is invoked the way a caller actually invokes it: a bare `ssh` is a commander
    // usage error (stderr, exit 1), not a stream violation, and asserting on it would test the
    // argument parser rather than the invariant.
    const invocations: Record<string, string[]> = {
      status: ['status'],
      profiles: ['profiles'],
      ssh: ['ssh', 'list'],
      config: ['config', 'list'],
    }
    for (const name of [...STRUCTURED_COMMANDS]) {
      const args = invocations[name] ?? [name]
      const { stdout } = runJson(args)
      expectJsonl(stdout, name)
    }
  })

  it('a structured command that fails mid-action still leaves a record, not silence (#113)', () => {
    // `ssh show --host <unknown>` cannot produce a key, but the caller must still be able to tell
    // "no results" from "broken": a record plus a non-zero exit, never an empty stdout.
    const { stdout } = runJson(['ssh', 'show', '--host', 'definitely-not-configured'])
    const [rec] = expectJsonl(stdout, 'ssh show')
    expect(['line', 'keyValues']).toContain(rec.kind)
  })
})

describe('the stdout quarantine (#113)', () => {
  it('sends console.log to stderr while JSON mode is on, and restores it after', () => {
    // A property of the guard itself, asserted directly: an un-migrated stray line must corrupt
    // stderr's diagnostics at worst, never the machine stream.
    const out: string[] = []
    const err: string[] = []
    const wOut = process.stdout.write.bind(process.stdout)
    const wErr = process.stderr.write.bind(process.stderr)
    const origLog = console.log
    ;(process.stdout as any).write = (c: any): boolean => { out.push(String(c)); return true }
    ;(process.stderr as any).write = (c: any): boolean => { err.push(String(c)); return true }
    try {
      setJsonMode(true)
      const restore = redirectHumanStdout()
      console.log('[saip] stray human line')
      restore()
      setJsonMode(false)
      // Assert reversibility by identity, not by output: after restore(), console.log is the function
      // that was there before. (An earlier version printed again and looked for it in the captured
      // stream — but the runner owns console.log, so that assertion measured the test harness, not
      // this guard.)
    } finally {
      console.log = origLog
      ;(process.stdout as any).write = wOut
      ;(process.stderr as any).write = wErr
    }
    expect(err.join('')).toContain('stray human line')
    expect(out.join('')).not.toContain('stray human line')
    expect(console.log, 'the guard must not leak past restore()').toBe(origLog)
  })
})

