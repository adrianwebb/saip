/**
 * `saip status` must report real fields, never a placeholder shaped like a value (#114).
 *
 * The shipped command printed `Mode: TODO (awake / asleep / down)`, `Uptime: TODO`, and
 * `Bucket: TODO (R2 bucket name)`. Those passed CI because the existing tests pinned only
 * `Platform Status`, `Adapters: 3 defined` and `registry valid` — the three lines that happened to be
 * finished. That is the failure mode AGENTS.md describes: a documented surface with no assertion at the
 * level a user observes it.
 *
 * So the central assertion here is the negative one — **no line may contain `TODO`** — written so it
 * fails today and keeps failing if any future field is stubbed. The positive assertions then require
 * each line to name its source, because "unknown" is only honest when it says what was asked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distBin = join(here, '..', 'dist', 'bin.js')

const isolated = (extra: Record<string, string> = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'saip-status-'))
  return {
    dir: d,
    env: {
      ...process.env,
      HOME: join(d, 'home'),
      SAIP_CONFIG: join(d, 'saip.yaml'),
      SAIP_ENV_FILE: join(d, '.env'),
      SAIP_SECRETS_FILE: join(d, 'secrets.enc.json'),
      SAIP_HOSTS_FILE: join(d, 'hosts.yaml'),
      SAIP_DRY_RUN: '1',
      ...extra,
    } as NodeJS.ProcessEnv,
  }
}

/** Run the assembled program as a program, capturing its real exit code (#76 rule). */
function status(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  try {
    const stdout = execFileSync(process.execPath, [distBin, ...args], { encoding: 'utf8', env, cwd })
    return { code: 0, stdout }
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '') }
  }
}

/** Find one report line by label, ignoring the indentation and padding the renderer adds. */
function line(out: string, label: string): string {
  const re = new RegExp(`^\\s*${label}:\\s*(.*)$`, 'm')
  return (out.match(re)?.[1] ?? '').trim()
}

describe('saip status emits no placeholder (#114)', () => {
  let env: NodeJS.ProcessEnv, dir: string
  beforeEach(() => { const i = isolated(); env = i.env; dir = i.dir })

  it('text mode: no line contains the literal TODO', () => {
    const r = status(['status'], env, dir)
    expect(r.stdout).not.toBe('')
    const offenders = r.stdout.split('\n').filter((l) => /TODO/.test(l))
    expect(offenders, `placeholder lines: ${JSON.stringify(offenders)}`).toEqual([])
  })

  it('json mode: no record value contains TODO either', () => {
    const r = status(['status', '--json'], env, dir)
    const records = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(records.length).toBeGreaterThan(0)
    // The rows are NESTED (`{"kind":"keyValues","rows":[{label,value}]}`), so a check that reads
    // `.value` off the record sees `undefined` and passes for every stub — an unfailable test, the
    // class this repo has been bitten by repeatedly. Walk the rows, and assert rows exist at all.
    for (const rec of records) {
      const values = (rec.rows ?? (rec.value !== undefined ? [rec] : [])).map((x: any) => String(x.value ?? ''))
      expect(values.length, `record carried no values: ${JSON.stringify(rec)}`).toBeGreaterThan(0)
      for (const v of values) expect(v).not.toMatch(/TODO/)
    }
  })
})

describe('saip status reports the mode it learned (#114)', () => {
  let env: NodeJS.ProcessEnv, dir: string
  beforeEach(() => {
    const i = isolated()
    env = i.env; dir = i.dir
    writeFileSync(join(dir, 'hosts.yaml'), 'hosts:\n  - name: default\n    kind: local\n    role: both\n')
  })

  it('Mode names a real state or says why it is unknown — never a template', () => {
    const r = status(['status'], env, dir)
    const mode = line(r.stdout, 'Mode')
    expect(mode).not.toBe('')
    // MEASURED TRAP: the shipped placeholder is `TODO (awake / asleep / down)`, which CONTAINS the
    // words `awake`, `asleep` and `down`. An assertion written as /awake|asleep|down/ therefore
    // passed against the stub — this test's first version was unfailable. The whole value must be
    // a state (optionally with an explanation), not a template that merely mentions states.
    expect(mode).not.toMatch(/TODO/i)
    expect(mode).toMatch(/^(awake|asleep|down|unknown)\b/)
    // And an unknown/failed read has to say what was asked, not just "unknown".
    if (/^unknown/.test(mode)) expect(mode).toMatch(/—|no |not |because/)
  })

  it('the host line reports what was asked, not a bare success word', () => {
    const r = status(['status'], env, dir)
    const host = line(r.stdout, 'Host')
    expect(host).toMatch(/default/)                        // names the target
    expect(host).toMatch(/local/)                          // and its kind
  })

  it('with no hosts.yaml the host line names the missing source', () => {
    const i = isolated()
    const r = status(['status'], i.env, i.dir)
    const host = line(r.stdout, 'Host')
    expect(host).toMatch(/unknown host|no host/)
    // And mode still cannot be a placeholder when nothing is reachable.
    expect(r.stdout).not.toMatch(/TODO/)
  })
})

describe('saip status bucket and adapters describe absence (#114)', () => {
  it('an unset bucket says how to set it', () => {
    const i = isolated()
    const r = status(['status'], i.env, i.dir)
    const bucket = line(r.stdout, 'Bucket')
    expect(bucket).toMatch(/not set|no bucket/)
    expect(bucket).toMatch(/saip\.yaml|config init/)       // names the fix, not just the gap
  })

  it('a configured bucket is printed verbatim, interpolated like the gateways do', () => {
    const i = isolated({ SAIP_R2_BUCKET: 'from-env-bucket' })
    writeFileSync(join(i.dir, 'saip.yaml'), 'storage:\n  r2:\n    bucket: ${SAIP_R2_BUCKET}\n')
    const r = status(['status'], i.env, i.dir)
    expect(r.stdout).toMatch(/Bucket:\s+from-env-bucket/)
    expect(r.stdout).not.toMatch(/\$\{SAIP_R2_BUCKET\}/)    // a literal token is worse than nothing
  })

  it('zero adapters reads as zero, not as a TODO', () => {
    const i = isolated()
    writeFileSync(join(i.dir, 'saip.yaml'), 'adapters: []\n')
    const r = status(['status'], i.env, i.dir)
    const adapters = line(r.stdout, 'Adapters')
    expect(adapters).toMatch(/0 defined/)
    expect(adapters).not.toMatch(/TODO/)
  })
})

describe('saip status uptime (#114)', () => {
  it('uptime is a value or an explained absence — never the bare word TODO', () => {
    const i = isolated()
    writeFileSync(join(i.dir, 'hosts.yaml'), 'hosts:\n  - name: default\n    kind: local\n    role: both\n')
    const r = status(['status'], i.env, i.dir)
    const up = line(r.stdout, 'Uptime')
    expect(up).not.toBe('')
    expect(up).not.toMatch(/\bTODO\b/)
    // Nothing is awake under SAIP_DRY_RUN, so the honest answer names that reason.
    expect(up).toMatch(/not reported|no state|not awake|\d+[smh]/)
  })
})
