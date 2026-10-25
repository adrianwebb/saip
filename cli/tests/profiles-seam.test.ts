/**
 * `saip profiles` describes blocks; the seam renders them (#156).
 *
 * Before this, `profiles` was the last command that formatted its own output: the resolver returned a
 * finished string (padded columns, `[saip] ` prefixes, and for `--json` a hand-rolled object with no
 * `kind` at all) and the command printed it with `console.log`. Two consequences, both asserted against
 * here rather than described:
 *
 *  - The piped cleanliness that #110 verifies was **luck**. A pipe showed no box-drawing because the
 *    string happened to contain none, not because a renderer decided so. Nothing stopped a decorative
 *    character — or a colour code — reaching `saip profiles | jq`.
 *  - `--json` produced a valid but **kind-less** record, which is the one thing #113's machine contract
 *    forbids: a consumer dispatches on `kind`, and had nothing to dispatch on. #110 recorded it as
 *    NOT-IMPLEMENTED for exactly that reason.
 *
 * The contract is now: the resolver returns data, the command turns data into blocks, `ctx.ui` renders
 * the blocks. Ink frames / plain lines / JSONL records are three renderings of ONE content path, so they
 * cannot disagree about whether a tier fits.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommandRegistryService } from '../src/lib/command-registry.js'
import profilesPlugin, { profileReport, profileBlocks } from '../src/commands/profiles.js'
import { plainRenderer } from '../src/ui/plain.js'
import { inkRenderer } from '../src/ui/ink.js'
import { FakeGpuProbe, type GpuInfo, type ProfileMap } from '@saip/shared'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const distBin = join(repoRoot, 'cli/dist/bin.js')

const PROFILES: ProfileMap = {
  'inference-8gb': {
    min_vram_gib: 8, min_capability: 7.5, vram_ceiling_gib: 7.0,
    engine: { max_model_len: 24576, kv_cache_dtype: 'auto', language_model_only: true, enforce_eager: true, enable_lora: true, max_loras: 4, max_lora_rank: 16 },
  },
  'full-loop-12gb': {
    min_vram_gib: 12, min_capability: 8.0, vram_ceiling_gib: 11.0,
    engine: { max_model_len: 65536, kv_cache_dtype: 'auto', language_model_only: true, enable_lora: true, max_loras: 4, max_lora_rank: 16, max_num_seqs: 128 },
  },
}
const ampere16 = (): GpuInfo => ({ name: 'RTX 3080 Laptop', total_gib: 16, free_gib: 13.46, capability: 8.6 })
const turing6 = (): GpuInfo => ({ name: 'RTX 2060', total_gib: 6, free_gib: 5.1, capability: 7.5 })

describe('profileReport returns data, not a finished string (#156)', () => {
  it('carries the facts a renderer needs and no prose', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()) })
    expect(out.exitCode).toBe(0)
    // The field that made this command the formatting layer is gone, and not "kept for compatibility".
    expect(out).not.toHaveProperty('text')
    expect(out.gpu?.name).toBe('RTX 3080 Laptop')
    expect(out.tiers.map((t) => t.name)).toEqual(['inference-8gb', 'full-loop-12gb'])
    expect(out.resolution?.ok && out.resolution.profile).toBe('full-loop-12gb')
    expect(out.utilization?.ok && out.utilization.utilization).toBeCloseTo(11 / 16, 4)
  })

  it('engine args stay an argv list, because joining is presentation', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()), model: 'QuantTrio/Qwen3.5-4B-AWQ' })
    expect(Array.isArray(out.engineArgs)).toBe(true)
    expect(out.engineArgs).toContain('--max-model-len')
    expect(out.engineArgs).toContain('65536')
    // A list can be quoted correctly by whatever renders it; a string has already lost that option.
    expect(out.engineArgs).toContain('--model')
  })

  it('a failure names its code and message as fields, not as a sentence to re-parse', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(turing6()), require: 'full-loop-12gb' })
    expect(out.exitCode).toBe(2)
    expect(out.error?.code).toBe('insufficient_vram')
    expect(out.error?.message).toMatch(/needs 12 GiB/)
    // `status` used to detect this condition with `report.text.match(/insufficient_free_vram/)` — a
    // command pattern-matching its own prose. Nothing may have to do that again.
    expect(out).not.toHaveProperty('text')
  })

  it('an unreadable GPU is a named error, still with the tiers it never got to compare', async () => {
    const out = await profileReport({
      profiles: PROFILES,
      probe: { async probe() { throw Object.assign(new Error('nvidia-smi failed'), { code: 'gpu_unavailable' }) } },
    })
    expect(out.exitCode).toBe(2)
    expect(`${out.error?.code} ${out.error?.message}`).toMatch(/nvidia-smi|gpu/i)
  })
})

describe('profileBlocks is the only presentation the command owns (#156)', () => {
  it('keeps the fits column short and puts the reasons on their own lines', async () => {
    // A prose cell in a right-aligned column is what made the first version of this table unReadable:
    // `no — needs 12 GiB VRAM, card has 6 GiB; needs compute capability 8…` widened the column past 70
    // characters and shoved every header away from its value.
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(turing6()) })
    const blocks = profileBlocks(out)
    const table = blocks.find((b) => b.kind === 'columns') as Extract<(typeof blocks)[number], { kind: 'columns' }>
    const fitsCol = table.header.indexOf('fits')
    // A 6 GiB / cc 7.5 card fails BOTH tiers here (8 GiB and 12 GiB minimums), which is why the
    // expectations say `no, no` rather than one each: my first draft asserted `yes` for the 8 GiB tier
    // from memory of a different fixture and the product correctly contradicted it.
    expect(table.rows.map((r) => r[fitsCol])).toEqual(['no', 'no'])
    const notes = blocks.filter((b) => b.kind === 'note') as Extract<(typeof blocks)[number], { kind: 'note' }>[]
    expect(notes.length, 'every deficit stays stated').toBe(2)
    expect(notes.map((n) => n.text).join('\n')).toMatch(/inference-8gb: needs 8 GiB/)
    expect(notes.map((n) => n.text).join('\n')).toMatch(/full-loop-12gb: needs 12 GiB/)
    expect(plainRenderer.renderAll(blocks)).toMatch(/needs 12 GiB/)
  })

  it('renders the tier table as a columns block and the facts as labelled rows', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()), model: 'm' })
    const blocks = profileBlocks(out)
    const kinds = blocks.map((b) => b.kind)
    expect(kinds).toContain('columns')
    expect(kinds).toContain('keyValues')
    const table = blocks.find((b) => b.kind === 'columns') as Extract<(typeof blocks)[number], { kind: 'columns' }>
    expect(table.header[0]).toBe('profile')
    expect(table.rows.map((r) => r[0])).toEqual(['inference-8gb', 'full-loop-12gb'])
    const rows = blocks.find((b) => b.kind === 'keyValues') as Extract<(typeof blocks)[number], { kind: 'keyValues' }>
    const labels = rows.rows.map((r) => r.label)
    for (const want of ['GPU', 'Profile', 'Utilization']) expect(labels, `missing row: ${want}`).toContain(want)
  })

  it('the plain renderer keeps its promise for this command, structurally rather than by luck', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()), model: 'm' })
    const text = plainRenderer.renderAll(profileBlocks(out))
    expect(text).not.toMatch(/[\u2500-\u257F]/)                 // no box-drawing
    expect(text).not.toMatch(/\x1b\[[0-9;?]*[0-9a-zA-Z]/)       // no ANSI
    // and the facts are all still there
    for (const want of ['RTX 3080 Laptop', 'full-loop-12gb', 'inference-8gb']) expect(text).toContain(want)
    expect(text).toMatch(/0\.6875/)
  })

  it('the ink renderer shows the SAME content, which is the reason one seam exists', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()) })
    const blocks = profileBlocks(out)
    const ink = inkRenderer.renderAll(blocks).replace(/\s+/g, ' ')
    const plain = plainRenderer.renderAll(blocks).replace(/\s+/g, ' ')
    // Content parity: the pretty path cannot disagree with the log path about which tier resolved.
    for (const token of ['RTX 3080 Laptop', 'full-loop-12gb', 'inference-8gb']) {
      expect(plain, `plain is missing ${token}`).toContain(token)
      expect(ink, `ink is missing ${token}`).toContain(token)
    }
  })

  it('a refusal renders as an error line, in every renderer', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(turing6()), require: 'full-loop-12gb' })
    const blocks = profileBlocks(out)
    expect(blocks.some((b) => b.kind === 'line' && b.level === 'error')).toBe(true)
    expect(plainRenderer.renderAll(blocks)).toMatch(/insufficient_vram/)
  })
})

describe('the assembled command answers through the seam (#156, #76 rule)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saip-156-'))
    writeFileSync(join(dir, 'saip.yaml'), `profile: full-loop-12gb\nprofiles:\n${Object.entries(PROFILES).map(([n, p]) =>
      `  ${n}: { min_vram_gib: ${p.min_vram_gib}, min_capability: ${p.min_capability}, vram_ceiling_gib: ${p.vram_ceiling_gib}, engine: { max_model_len: ${p.engine?.max_model_len} } }`).join('\n')}\n`)
  })

  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [distBin, ...args], { encoding: 'utf8', timeout: 30_000, env, cwd: dir })

  const scrubbed = (): NodeJS.ProcessEnv => {
    const env = { ...process.env, SAIP_CONFIG: join(dir, 'saip.yaml'), SAIP_SECRETS_FILE: join(dir, 's.enc.json'), SAIP_ENV_FILE: join(dir, 'none.env'), SAIP_HOSTS_FILE: join(dir, 'hosts.yaml') }
    for (const k of Object.keys(env)) if (k.startsWith('SAIP_') && !['SAIP_CONFIG', 'SAIP_SECRETS_FILE', 'SAIP_ENV_FILE', 'SAIP_HOSTS_FILE'].includes(k)) delete env[k]
    return env as NodeJS.ProcessEnv
  }

  it('--json yields one record per block and EVERY record carries kind', () => {
    const r = run(['profiles', '--json'], scrubbed())
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines.length, `no records on stdout (exit ${r.status}): ${r.stderr.slice(0, 200)}`).toBeGreaterThan(0)
    const parsed = lines.map((l) => {
      try { return JSON.parse(l) as Record<string, unknown> }
      catch { throw new Error(`not a JSONL record: ${l.slice(0, 120)}`) }
    })
    for (const rec of parsed) {
      expect(typeof rec.kind, `record without kind: ${JSON.stringify(rec).slice(0, 160)}`).toBe('string')
    }
    // The old shape was one pretty-printed multi-line blob with no `kind`; it could not be JSONL and an
    // agent could not dispatch on it. The block records only exist on the success path, so this host
    // (no NVIDIA device) still proves the contract that matters — every record is dispatched by kind —
    // while the full block set is asserted against an injected probe above.
    if (r.status === 0) {
      expect(parsed.some((p) => p.kind === 'columns' || p.kind === 'keyValues'),
        `success path emitted no table: ${JSON.stringify(parsed.map((p) => p.kind))}`).toBe(true)
    }
  })

  it('a refusal under --json is a record too, never silence (#113)', () => {
    const env = { ...scrubbed(), NVIDIA_SMI_PATH: join(dir, 'no-such-binary') }
    const r = run(['profiles', '--json'], env)
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    if (r.status === 0) return                       // a machine with a working GPU cannot exercise this
    expect(lines.length, `exit ${r.status} with empty stdout: ${r.stderr.slice(0, 200)}`).toBeGreaterThan(0)
    const rec = JSON.parse(lines[0]) as { kind?: string; level?: string }
    expect(typeof rec.kind).toBe('string')
    expect(rec.level).toBe('error')
  })

  it('piped output is plain because the renderer chose it', () => {
    const r = run(['profiles'], scrubbed())
    // Cleanliness must hold on BOTH paths: this host may have no NVIDIA device, and the refusal is
    // rendered by the same seam. A test that only checks the success path passes by accident on a
    // machine with no GPU — and the box characters it was meant to catch would arrive with one.
    expect(r.stdout).not.toMatch(/[\u2500-\u257F]/)
    expect(r.stdout).not.toMatch(/\x1b\[[0-9;?]*[0-9a-zA-Z]/)
    if (r.status === 0) expect(r.stdout).toMatch(/profile/)     // the tier table, when there is a card
    else expect(r.stdout).toMatch(/gpu_unavailable|insufficient|no service profile fits/)
  })
})

describe('no command formats its own output any more (#156 criterion: console.log reaches zero)', () => {
  it('cli/src/commands contains no console.log call', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const dir = fileURLToPath(new URL('../src/commands', import.meta.url))
    const offenders: string[] = []
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f)) continue
      const src = readFileSync(join(dir, f), 'utf8')
      // Comments may mention console.log (several explain WHY it went); calls may not.
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\/\*\*)/.test(l)).join('\n')
      if (/\bconsole\.log\(/.test(code)) offenders.push(f)
    }
    expect(offenders, `console.log() in: ${offenders.join(', ')} — render through ctx.ui (#113/#156)`).toEqual([])
  })
})

/**
 * The plugin path is what `buildProgram` wires, so the seam must be reachable from the registered
 * action — otherwise a test above could pass while the command still prints by hand.
 */
describe('the registered action renders through ctx.ui', () => {
  it('uses the seam rather than console.log', async () => {
    const ctx = new Context() as any
    await ctx.plugin(CommandRegistryService as any)
    await ctx.plugin(profilesPlugin as any, { profiles: PROFILES, probe: new FakeGpuProbe(ampere16()) })
    const spec = ctx.commandRegistry.get('profiles')
    const out: string[] = []
    const ui = {
      structured: false,
      useRenderer: (k: string) => { if (k !== 'jsonl') throw new Error(`unexpected renderer ${k}`) },
      show: (b: unknown) => { out.push(JSON.stringify(b)) },
      showAll: (bs: any[]) => { for (const b of bs) out.push(JSON.stringify(b)) },
      showLine: (t: string) => { out.push(t) },
    }
    ctx.ui = ui
    await spec.action(ctx, {}, [])
    expect(out.some((s) => s.includes('"columns"'))).toBe(true)
    expect(out.some((s) => s.includes('"keyValues"'))).toBe(true)
  })
})
