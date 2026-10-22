/**
 * Unknown-host errors must name the role and the flag that fixes them (#117).
 *
 * `saip deploy --target box2` on a registry without a `default` host answered
 * `unknown host "default". Known hosts: localbox` — accurate, useless, and actively misleading: the user
 * had just typed `--target`, `box2` was known, and the failing host was the **implicit source**. The only
 * actionable fact, "pass `--source`", had to be guessed. `deploy` is also the one command that takes two
 * hosts, so a single `--host`-shaped message cannot be right for it.
 *
 * These run against the assembled program rather than the error class, because the thing being fixed is
 * what a person reads in a terminal — a unit test on `UnknownHostError` would have passed the whole time
 * the message was wrong.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distBin = join(here, '..', 'dist', 'bin.js')
const built = existsSync(distBin)

interface Ctx { env: NodeJS.ProcessEnv; dir: string }

function context(hostsYaml: string): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'saip-hosterr-'))
  writeFileSync(join(dir, 'hosts.yaml'), hostsYaml)
  return {
    dir,
    env: {
      ...process.env,
      HOME: join(dir, 'home'),
      SAIP_CONFIG: join(dir, 'saip.yaml'),
      SAIP_ENV_FILE: join(dir, '.env'),
      SAIP_SECRETS_FILE: join(dir, 'secrets.enc.json'),
      SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
      SAIP_DRY_RUN: '1',
    },
  }
}

/** Run and capture BOTH streams plus the real exit code — never `$?` through a pipe. */
function run(args: string[], c: Ctx): { code: number | null; out: string } {
  try {
    const stdout = execFileSync(process.execPath, [distBin, ...args], { encoding: 'utf8', env: c.env, cwd: c.dir })
    return { code: 0, out: stdout }
  } catch (e: any) {
    return { code: e?.status ?? null, out: `${e?.stdout ?? ''}${e?.stderr ?? ''}` }
  }
}

const ONE_HOST = 'hosts:\n  - name: box2\n    kind: local\n    role: inference\n'
const TWO_HOSTS = 'hosts:\n  - name: local\n    kind: local\n    role: both\n  - name: box2\n    kind: local\n    role: inference\n'

describe('deploy names the role that failed (#117)', () => {
  it.skipIf(!built)('a known --target with no default source says SOURCE and --source', () => {
    const r = run(['deploy', '--target', 'box2'], context(ONE_HOST))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/unknown deploy source host "default"/)
    expect(r.out).toMatch(/set --source <name>/)
    // The misdirection this fixes: nothing about the message may point at --host or --target.
    expect(r.out).not.toMatch(/--host/)
    expect(r.out).not.toMatch(/--target/)
    expect(r.out).toMatch(/box2/)                   // known hosts still listed
  })

  it.skipIf(!built)('an unknown --target says TARGET and --target', () => {
    const r = run(['deploy', '--source', 'local', '--target', 'box9'], context(TWO_HOSTS))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/unknown deploy target host "box9"/)
    expect(r.out).toMatch(/set --target <name>/)
    expect(r.out).not.toMatch(/--source/)
  })

  it.skipIf(!built)('an explicit --source that is unknown is still blamed as the source', () => {
    const r = run(['deploy', '--source', 'nope', '--target', 'box2'], context(TWO_HOSTS))
    expect(r.out).toMatch(/unknown deploy source host "nope"/)
    expect(r.out).toMatch(/set --source <name>/)
  })
})

describe('single-host commands name --host and SAIP_HOST (#117)', () => {
  // `status` is deliberately NON-fatal since #114: it describes an unreadable host in its Host row and
  // still exits 0, because its job is to report state. So it is asserted on wording, not exit code —
  // requiring a failure here would contradict the behaviour #114 chose on purpose.
  for (const cmd of ['awake', 'sleep', 'down']) {
    it.skipIf(!built)(`${cmd} with an unresolvable default names --host and SAIP_HOST and fails closed`, () => {
      const r = run([cmd], context(ONE_HOST))
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/unknown host "default"/)
      expect(r.out).toMatch(/set --host <name> or SAIP_HOST/)
      expect(r.out).toMatch(/box2/)
      // A single-host command must not imply a deploy-style flag pair.
      expect(r.out).not.toMatch(/--source/)
    })
  }

  it.skipIf(!built)('status keeps its #114 non-fatal contract while naming the flag', () => {
    const r = run(['status'], context(ONE_HOST))
    expect(r.code).toBe(0)                       // reporting, not failing — set by #114
    expect(r.out).toMatch(/Host:.*unknown host "default"/)
    expect(r.out).toMatch(/set --host <name> or SAIP_HOST/)
    expect(r.out).toMatch(/box2/)
  })

  it.skipIf(!built)('an explicit --host typo names the flag too', () => {
    const r = run(['status', '--host', 'bo2'], context(TWO_HOSTS))     // transposed typo
    // Not `/--host/`: commander's help block lists that flag anyway, and the case passed for that
    // reason rather than because the error told the user what to do. Assert the suggestion itself.
    expect(r.out).toMatch(/unknown host "bo2"/)
    expect(r.out).toMatch(/set --host <name>/)
  })
})

describe('the known-host list stays readable (#117)', () => {
  it.skipIf(!built)('truncates a large inventory rather than burying the suggestion', () => {
    const many = 'hosts:\n' + Array.from({ length: 14 }, (_, i) =>
      `  - name: host-${String(i).padStart(2, '0')}\n    kind: local\n    role: inference\n`).join('')
    const r = run(['status', '--host', 'missing'], context(many))
    expect(r.out).toMatch(/unknown host "missing"/)
    expect(r.out).toMatch(/\+6 more/)                       // 14 known, 8 shown
    expect((r.out.match(/host-\d\d/g) ?? []).length).toBeLessThanOrEqual(8)
  })

  it.skipIf(!built)('says (none) when the registry is empty, which is a different problem', () => {
    const r = run(['status'], context('hosts: []\n'))
    expect(r.out).toMatch(/\(none\)/)
  })

  it.skipIf(!built)('lists up to eight names in full when the inventory is small', () => {
    const r = run(['status', '--host', 'zzz'], context(TWO_HOSTS))
    expect(r.out).toMatch(/Known hosts: local, box2/)
  })
})
