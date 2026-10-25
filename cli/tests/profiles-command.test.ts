/**
 * `saip profiles` + the profile-aware command surface.
 *
 * The probe is injected, so these run deterministically on any card — and on none. The
 * point of the command is that the answer comes from the same ProfileService the gateways
 * use, so a mismatch between "what the CLI says fits" and "what the server tries to run"
 * is structurally impossible.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { CommandRegistryService } from '../src/lib/command-registry.js'
import profilesPlugin, { profileBlocks, profileReport } from '../src/commands/profiles.js'
import { plainRenderer } from '../src/ui/plain.js'
import { jsonlRenderer } from '../src/ui/json.js'
import { CommandRegistryService as SharedCmds } from '../src/lib/command-registry.js'
import { FakeGpuProbe, type GpuInfo, type ProfileMap } from '@saip/shared'

/**
 * What a user of this command SEES, rendered by the plain renderer from the blocks the command builds.
 *
 * Every assertion below once read `out.text`, a string the resolver had already padded and prefixed.
 * #156 removed that string — the resolver returns data, the command builds blocks, `ctx.ui` renders — so
 * these cases keep their original meaning ("is the deficit named?", "does the tier appear?") by asking
 * the renderer instead. Deleting them would have deleted the guarantees; asserting on `text` again would
 * have re-introduced the thing that was removed.
 */
const shown = (report: Awaited<ReturnType<typeof profileReport>>): string => plainRenderer.renderAll(profileBlocks(report))

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

function capture(): { lines: string[]; run: (fn: () => void) => void } {
  const lines: string[] = []
  return {
    lines,
    run(fn: () => void) {
      const orig = console.log
      console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
      try { fn() } finally { console.log = orig }
    },
  }
}

describe('profileReport', () => {
  it('resolves the highest tier a 16 GiB Ampere card satisfies and derives utilization', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()) })
    expect(out.exitCode).toBe(0)
    expect(out.resolution.profile).toBe('full-loop-12gb')
    expect(out.utilization?.utilization).toBeCloseTo(11 / 16, 4)
    expect(shown(out)).toMatch(/full-loop-12gb/)
  })

  it('lists every tier with whether this card fits it', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()) })
    expect(shown(out)).toContain('inference-8gb')
    expect(shown(out)).toContain('full-loop-12gb')
    expect(out.tiers.map((t) => t.name)).toEqual(['inference-8gb', 'full-loop-12gb'])
    expect(out.tiers.every((t) => t.fits)).toBe(true)
  })

  it('marks tiers the card misses and resolves the best one it does satisfy', async () => {
    // An 8 GiB Turing card: inference-8gb fits, full-loop-12gb misses on both axes.
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe({ name: 'RTX 2080', total_gib: 8, free_gib: 7.6, capability: 7.5 }) })
    const twelve = out.tiers.find((t) => t.name === 'full-loop-12gb')
    expect(twelve?.fits).toBe(false)
    expect(twelve?.why).toMatch(/8(\.0)? GiB|capability/)
    expect(out.exitCode).toBe(0)
    expect(out.resolution?.profile).toBe('inference-8gb')
  })

  it('a 6 GiB Turing card fits nothing at all: exit 2 with the deficit named', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(turing6()), require: 'full-loop-12gb' })
    expect(out.exitCode).toBe(2)
    expect(shown(out)).toMatch(/insufficient_vram/)
  })

  it('reports no_satisfiable_profile as exit 2 when the card holds nothing', async () => {
    const tiny: GpuInfo = { name: 'MX150', total_gib: 2, free_gib: 1.5, capability: 6.1 }
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(tiny) })
    expect(out.exitCode).toBe(2)
    expect(shown(out)).toMatch(/no_satisfiable_profile|no service profile fits/)
  })

  it('turns an invalid profiles block into exit 1, not a stack trace', async () => {
    const bad = { 'x': { engine: {} } } as unknown as ProfileMap
    const out = await profileReport({ profiles: bad, probe: new FakeGpuProbe(ampere16()) })
    expect(out.exitCode).toBe(1)
    expect(shown(out)).toMatch(/missing_tier_field|profiles/)
  })

  it('renders the engine args implied by the resolved tier', async () => {
    const out = await profileReport({
      profiles: PROFILES, probe: new FakeGpuProbe(ampere16()), model: 'QuantTrio/Qwen3.5-4B-AWQ',
    })
    expect(out.engineArgs).toContain('--max-model-len')
    expect(out.engineArgs).toContain('65536')
    expect(out.engineArgs).toContain('--max-num-seqs')
    // #156: the report carries an argv LIST; the joined command line is a rendering. Both must hold —
    // an agent reads the list, a human reads the line.
    expect(shown(out)).toMatch(/--max-model-len 65536/)
  })

  it('surfaces a forbidden KV dtype as a configuration error rather than printing it', async () => {
    const poisoned: ProfileMap = {
      'poisoned-8gb': { min_vram_gib: 8, min_capability: 7.5, vram_ceiling_gib: 7.0, engine: { kv_cache_dtype: 'int8_per_token_head' } },
    }
    const out = await profileReport({ profiles: poisoned, probe: new FakeGpuProbe(ampere16()), require: 'poisoned-8gb' })
    expect(out.exitCode).toBe(2)
    expect(shown(out)).toMatch(/forbidden_kv_cache_dtype|8\.9/)
  })

  it('survives a GPU that cannot be read at all', async () => {
    const out = await profileReport({
      profiles: PROFILES,
      probe: { async probe() { throw Object.assign(new Error('nvidia-smi failed'), { code: 'gpu_unavailable' }) } },
    })
    expect(out.exitCode).toBe(2)
    expect(shown(out)).toMatch(/nvidia-smi|gpu/i)
  })

  it('answers a machine reader with records that carry kind (#156)', async () => {
    // The old contract was `profileReport({ json: true })` returning one pretty-printed blob with no
    // `kind`, i.e. exactly the object an agent could not dispatch on. Machine output is now the seam's
    // jsonl renderer over the SAME blocks, so the parity claim is checkable: same facts, two renderings.
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()) })
    const records = jsonlRenderer.renderAll(profileBlocks(out)).split('\n').map((l) => JSON.parse(l))
    for (const rec of records) expect(typeof rec.kind).toBe('string')
    const table = records.find((r) => r.kind === 'columns')
    expect(table.rows).toHaveLength(2)
    const facts = records.find((r) => r.kind === 'keyValues')
    const value = (label: string): string => facts.rows.find((r: { label: string }) => r.label === label).value
    expect(value('Profile')).toContain('full-loop-12gb')
    expect(value('GPU')).toContain('cc 8.6')
  })
})

describe('saip profiles command', () => {
  let ctx: any
  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(CommandRegistryService as any)
    await ctx.plugin(profilesPlugin as any, { profiles: PROFILES, probe: new FakeGpuProbe(ampere16()) })
  })

  it('registers itself on the command registry', async () => {
    expect(ctx.commandRegistry.list().map((s: any) => s.name)).toContain('profiles')
  })

  it('exposes --profile, and gets --json from the dispatcher rather than from itself (#156)', async () => {
    const spec = ctx.commandRegistry.get('profiles')
    const flags = (spec.options ?? []).map((o: any) => o.flag)
    expect(flags).toContain('--profile <name>')
    // Declaring its own --json is what let this command keep a private, hand-built JSON branch. The
    // dispatcher adds the flag to every command, so the USER-VISIBLE surface is unchanged; the spec is
    // asserted against the built program, because that is where the flag actually comes from now.
    expect(flags.some((f: string) => f.includes('--json'))).toBe(false)
    const { buildProgram } = await import('../src/index.js')
    const program = await buildProgram()
    const profiles = program.commands.find((c) => c.name() === 'profiles')
    expect((profiles?.options ?? []).map((o) => o.long)).toContain('--json')
  })

  it('is registered by buildProgram alongside the existing commands', async () => {
    const { buildProgram } = await import('../src/index.js')
    const program = await buildProgram()
    expect(program.commands.map((c) => c.name())).toContain('profiles')
  })

  it('keeps the same registry service the shared commands use', async () => {
    const ctx2 = new Context() as any
    await ctx2.plugin(SharedCmds as any)
    expect(typeof ctx2.commandRegistry.register).toBe('function')
  })
})
