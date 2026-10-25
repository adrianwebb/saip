/**
 * `awake`'s profile gate refuses, and the refusal reaches the user (#156 coverage for a branch that
 * had none).
 *
 * `awake` resolves the hardware contract BEFORE starting compose, because a tier the card cannot hold
 * surfaces as a vLLM crash loop that keeps reserving VRAM — measured at three restarts in three minutes
 * on a shared GPU. The code that prints that refusal was changed by #156 (it interpolated `report.text`;
 * it now renders `profileBlocks(report)` through the seam) and NOTHING tested it: the existing `awake`
 * cases cover host resolution and the happy path only. A rewritten branch with no test is how
 * silent-success ships, so this file lands with the change rather than after it.
 *
 * Driven as a program, in a temp workspace, with `nvidia-smi` AND `docker` stubbed on PATH. The stub
 * card is 6 GiB and every declared tier needs at least 8, so the gate must refuse; the `docker` stub is
 * a tripwire, so if the gate ever let the command through the test reports that instead of a test suite
 * touching a container runtime.
 */
import { describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const distBin = join(repoRoot, 'cli/dist/bin.js')
const mkTemp = (): string => mkdtempSync(join(tmpdir(), 'saip-awake-gate-'))

/** Build a workspace whose stub card cannot hold any declared tier, with `docker` stubbed as a tripwire. */
function gatedWorkspace(): { dir: string; env: NodeJS.ProcessEnv; out: string; err: string } {
  const dir = mkTemp()
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'nvidia-smi'), '#!/bin/sh\necho "STUB GRID, 6144, 5222, 7.5"\n')
  chmodSync(join(bin, 'nvidia-smi'), 0o755)
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" >> ${join(dir, 'docker-called.txt')}\nexit 0\n`)
  chmodSync(join(bin, 'docker'), 0o755)

  writeFileSync(join(dir, 'saip.yaml'), [
    'model:',
    '  base: QuantTrio/Qwen3.5-4B-AWQ',
    'profiles:',
    '  inference-8gb: { min_vram_gib: 8, min_capability: 7.5, vram_ceiling_gib: 7.0, engine: { max_model_len: 24576 } }',
    '  full-loop-12gb: { min_vram_gib: 12, min_capability: 8.0, vram_ceiling_gib: 11.0, engine: { max_model_len: 65536 } }',
    '',
  ].join('\n'))
  // `default` is the NAME the resolver looks for, not a `default: true` flag — the first draft of
  // this test hit `unknown host "default"` and never reached the gate it was meant to exercise.
  writeFileSync(join(dir, 'hosts.yaml'), 'hosts:\n  - { name: default, kind: local }\n')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: join(dir, 'home'),
    SAIP_CONFIG: join(dir, 'saip.yaml'),
    SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
    SAIP_SECRETS_FILE: join(dir, 'secrets.enc.json'),
    SAIP_ENV_FILE: join(dir, 'none.env'),
  }
  const keep = new Set(['SAIP_CONFIG', 'SAIP_HOSTS_FILE', 'SAIP_SECRETS_FILE', 'SAIP_ENV_FILE'])
  for (const k of Object.keys(env)) if (k.startsWith('SAIP_') && !keep.has(k)) delete env[k]

  const out = join(dir, 'stdout.txt')
  const err = join(dir, 'stderr.txt')
  return { dir, env, out, err }
}

const runFor = (args: string[], w: { dir: string; env: NodeJS.ProcessEnv; out: string; err: string }) => ({
  status: spawnSync(process.execPath, [distBin, ...args], {
    cwd: w.dir, env: w.env, timeout: 60_000,
    stdio: ['ignore', openSync(w.out, 'w'), openSync(w.err, 'w')],
  }).status,
  text: `${readFileSync(w.out, 'utf8')}\n${readFileSync(w.err, 'utf8')}`,
})

describe('awake refuses when no profile fits the card', () => {
  it('names the deficit, exits 2, and never reaches compose', () => {
    const w = gatedWorkspace()
    const r = runFor(['awake'], w)

    expect(r.status, `exit ${r.status}\n${r.text}`).toBe(2)
    const all = r.text
    // Stated with the measured numbers, not as a generic failure.
    expect(all).toMatch(/no service profile fits|no_satisfiable_profile/)
    expect(all).toMatch(/6 GiB/)
    // Nothing may claim a start that did not happen (#150's rule)…
    expect(all).not.toMatch(/Services (are )?awake|started successfully/)
    // …and the refusal must come before any attempt to talk to a runtime.
    expect(existsSync(join(w.dir, 'docker-called.txt')), 'awake reached compose despite an unsatisfiable profile').toBe(false)
  })
})

/**
 * `status` reads the same report. #156 replaced its `report.text.match(/insufficient_free_vram/)` test
 * — one command pattern-matching another command's prose — with a field check, so both the deficit row
 * and the "GPU row when nothing resolved" row needed an assertion, and neither had one.
 */
describe('status reports the same deficit without inventing a start', () => {
  it('names the GPU and why no profile fits, and never prints a placeholder', () => {
    const w = gatedWorkspace()
    const r = runFor(['status'], w)
    expect(r.text).toMatch(/STUB GRID/)                              // the card is still named
    expect(r.text).toMatch(/no service profile fits|gpu_unavailable|insufficient/)
    expect(r.text).not.toMatch(/TODO/)                               // #114's rule, re-asserted here
    expect(r.text).not.toMatch(/Mode:\s+awake/)                      // no claimed state it did not measure
  })

  it('the JSON row for GPU carries the named reason, not an empty value', () => {
    const w = gatedWorkspace()
    const r = runFor(['status', '--json'], w)
    const rows = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind?: string; rows?: { label: string; value: string }[] })
    const kv = rows.find((x) => x.kind === 'keyValues')
    expect(kv, `no keyValues record in: ${r.text.slice(0, 200)}`).toBeTruthy()
    const gpu = kv!.rows!.find((x) => x.label === 'GPU')
    expect(gpu, `no GPU row in: ${JSON.stringify(kv!.rows)}`).toBeTruthy()
    expect(gpu!.value).toMatch(/STUB GRID|no service profile fits|insufficient|gpu_unavailable/)
  })
})
