/**
 * Output must describe what actually happened (#150).
 *
 * Two defects, both found by running the released binary:
 *
 * 1. `config init --non-interactive` **writes nothing** — correctly — yet labelled already-set values
 *    `missing` and closed with `stored 4 value(s): …`. An agent that parses that footer reports a
 *    mutation that never occurred, which is a worse failure than a crash.
 * 2. `awake`/`sleep`/`down` print their action announcement before resolving the host, so a command
 *    that did nothing at all reads as an action that then failed. `Shutting down all services…` is
 *    precisely the line that must not appear for a request that was never valid.
 *
 * Asserted against the assembled program in a pty-free but real environment: every prior test called
 * `runInit` directly and read its return value, which is exactly why the footer survived — the pure
 * function never claimed to have stored anything, only the emitted text did.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distBin = join(here, '..', 'dist', 'bin.js')
const built = existsSync(distBin)

const CONFIG = `storage:
  r2:
    bucket: \${SAIP_R2_BUCKET}
    endpoint: \${SAIP_R2_ENDPOINT}
inference:
  systemone:
    enabled: false
`

/**
 * Drop every inherited `SAIP_*` name.
 *
 * Not hygiene for its own sake: the shell this suite runs in has `SAIP_R2_BUCKET` exported, which
 * quietly relabelled a `.env`-sourced value as `(shell)` and made a source assertion pass or fail
 * depending on the developer's environment. A test whose verdict depends on the machine it runs on
 * is the #159 lesson in a new place.
 */
function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Order matters: scrubbing after spreading `extra` would delete the very SAIP_* values the case
  // is setting — which is exactly how this file's first version lost its `(shell)` source labels.
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(base)) if (k.startsWith('SAIP_')) delete base[k]
  return { ...base, ...extra }
}

/** A workspace where every R2 credential already has a value: two via .env, two via the shell. */
function fullWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'saip-truth-'))
  writeFileSync(join(dir, 'saip.yaml'), CONFIG)
  writeFileSync(join(dir, 'hosts.yaml'), 'hosts:\n  - name: local\n    kind: local\n    role: both\n')
  writeFileSync(join(dir, '.env'), 'SAIP_R2_BUCKET=real-bucket\nSAIP_R2_ENDPOINT=https://account.r2.cloudflarestorage.com\n')
  return {
    dir,
    env: cleanEnv({
      HOME: join(dir, 'home'),
      SAIP_CONFIG: join(dir, 'saip.yaml'),
      SAIP_ENV_FILE: join(dir, '.env'),
      SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
      SAIP_SECRETS_FILE: join(dir, 'secrets.enc.json'),
      SAIP_SECRETS_PASSPHRASE: 'spike-passphrase',
      // The two credentials come from the shell; the bucket/endpoint pair comes from .env — so the
      // `source:` labels below are asserting a real distinction, not inheriting one.
      SAIP_R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAIP_R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-KMD-HFLAG',
      SAIP_DRY_RUN: '1',
    } as NodeJS.ProcessEnv),
  }
}

function cli(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const r = spawnSync(process.execPath, [distBin, ...args], { encoding: 'utf8', env, cwd })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' }
}

describe('config init --non-interactive never claims a mutation (#150)', () => {
  it.skipIf(!built)('a complete configuration: no "stored N value(s)" footer, no missing labels', () => {
    const w = fullWorkspace()
    const before = existsSync(w.env.SAIP_SECRETS_FILE!) ? readFileSync(w.env.SAIP_SECRETS_FILE!, 'utf8') : null
    const r = cli(['config', 'init', '--non-interactive'], w.env, w.dir)

    // The footer that lied. Note the assertion is on the CLAIM (`stored N value(s)`), not the English
    // word: the shadowing note legitimately says "wins over anything stored here", and a /stored/
    // regex would fail on honest prose. My first version asserted exactly that wrong thing.
    expect(r.out).not.toMatch(/stored \d+ value\(s\)/)
    expect(r.out).not.toMatch(/^\[saip\] stored /m)
    expect(r.out).toMatch(/written now: 0/)
    // An already-set value must never be introduced as a gap.
    expect(r.out).not.toMatch(/missing\s*:/)
    expect(r.out).toMatch(/already set/)
    expect(r.code).toBe(0)                              // complete, so success — not a failure to "fix"
    // And the claim is true: the store file was not created, .env unchanged.
    const after = existsSync(w.env.SAIP_SECRETS_FILE!) ? readFileSync(w.env.SAIP_SECRETS_FILE!, 'utf8') : null
    expect(after).toBe(before)
    expect(readFileSync(w.env.SAIP_ENV_FILE!, 'utf8')).toContain('SAIP_R2_BUCKET=real-bucket')
  })

  it.skipIf(!built)('an incomplete one: each gap is a `to fill:` line, still no stored claim', () => {
    const w = fullWorkspace()
    delete w.env.SAIP_R2_ACCESS_KEY_ID
    delete w.env.SAIP_R2_SECRET_ACCESS_KEY
    const r = cli(['config', 'init', '--non-interactive'], w.env, w.dir)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/to fill:\s+SAIP_R2_ACCESS_KEY_ID/)
    expect(r.out).toMatch(/to fill:\s+SAIP_R2_SECRET_ACCESS_KEY/)
    expect(r.out).toMatch(/written now: 0/)
    expect(r.out).not.toMatch(/stored \d+ value\(s\)/)
    expect(r.out).not.toMatch(/missing\s*:/)
    // Values that ARE set must not be listed as gaps.
    expect(r.out).toMatch(/SAIP_R2_BUCKET.*already set|already set.*SAIP_R2_BUCKET|current :.*SAIP_R2_BUCKET/s)
  })

  it.skipIf(!built)('names the SOURCE of an already-set value, because only some can be cleared', () => {
    const w = fullWorkspace()
    const r = cli(['config', 'init', '--non-interactive'], w.env, w.dir)
    expect(r.out).toMatch(/source: \(\.env\)/)
    expect(r.out).toMatch(/source: \(shell\)/)
  })
})

describe('host verbs resolve the target before announcing an action (#150)', () => {
  const missingHost = (file: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'saip-order-'))
    writeFileSync(join(dir, 'hosts.yaml'), 'hosts:\n  - name: local\n    kind: local\n    role: both\n')
    const env = cleanEnv({ HOME: join(dir, 'home'), SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
      SAIP_CONFIG: join(dir, 'saip.yaml'), SAIP_ENV_FILE: join(dir, '.env'),
      SAIP_SECRETS_FILE: join(dir, 's.enc.json'), SAIP_DRY_RUN: '1' } as NodeJS.ProcessEnv)
    return cli([file, '--host', 'nope'], env, dir)
  }

  const announcements: Record<string, RegExp> = {
    awake: /Switching to AWAKE mode/i,
    sleep: /Switching to SLEEP mode/i,
    down: /Shutting down all services/i,
  }

  for (const [cmd, re] of Object.entries(announcements)) {
    it.skipIf(!built)(`${cmd} with an unknown host prints no announcement at all`, () => {
      const r = missingHost(cmd)
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/unknown host "nope"/)
      // Not "announced then failed" — never announced.
      expect(r.out).not.toMatch(re)
    })
  }

  it.skipIf(!built)('a VALID host still gets its announcement before the work', () => {
    // The other half: the ordering fix must not remove the progress line people rely on.
    const dir = mkdtempSync(join(tmpdir(), 'saip-order2-'))
    writeFileSync(join(dir, 'hosts.yaml'), 'hosts:\n  - name: local\n    kind: local\n    role: both\n')
    const env = cleanEnv({ HOME: join(dir, 'home'), SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
      SAIP_CONFIG: join(dir, 'saip.yaml'), SAIP_ENV_FILE: join(dir, '.env'),
      SAIP_SECRETS_FILE: join(dir, 's.enc.json'), SAIP_DRY_RUN: '1' } as NodeJS.ProcessEnv)
    const r = cli(['down', '--host', 'local'], env, dir)
    expect(r.out).toMatch(/Shutting down all services/i)
  })

  it.skipIf(!built)('deploy with an unknown target announces nothing either', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saip-order3-'))
    writeFileSync(join(dir, 'hosts.yaml'), 'hosts:\n  - name: local\n    kind: local\n    role: both\n')
    const env = cleanEnv({ HOME: join(dir, 'home'), SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
      SAIP_CONFIG: join(dir, 'saip.yaml'), SAIP_ENV_FILE: join(dir, '.env'),
      SAIP_SECRETS_FILE: join(dir, 's.enc.json'), SAIP_DRY_RUN: '1' } as NodeJS.ProcessEnv)
    const r = cli(['deploy', '--source', 'local', '--target', 'ghost'], env, dir)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/unknown deploy target host "ghost"/)
    expect(r.out).not.toMatch(/planned|applied/i)
  })
})
