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
import profilesPlugin, { profileReport } from '../src/commands/profiles.js'
import { CommandRegistryService as SharedCmds } from '../src/lib/command-registry.js'
import { FakeGpuProbe, type GpuInfo, type ProfileMap } from '@saip/shared'

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
    expect(out.text).toMatch(/full-loop-12gb/)
  })

  it('lists every tier with whether this card fits it', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()) })
    expect(out.text).toContain('inference-8gb')
    expect(out.text).toContain('full-loop-12gb')
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
    expect(out.text).toMatch(/insufficient_vram/)
  })

  it('reports no_satisfiable_profile as exit 2 when the card holds nothing', async () => {
    const tiny: GpuInfo = { name: 'MX150', total_gib: 2, free_gib: 1.5, capability: 6.1 }
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(tiny) })
    expect(out.exitCode).toBe(2)
    expect(out.text).toMatch(/no_satisfiable_profile|no service profile fits/)
  })

  it('turns an invalid profiles block into exit 1, not a stack trace', async () => {
    const bad = { 'x': { engine: {} } } as unknown as ProfileMap
    const out = await profileReport({ profiles: bad, probe: new FakeGpuProbe(ampere16()) })
    expect(out.exitCode).toBe(1)
    expect(out.text).toMatch(/missing_tier_field|profiles/)
  })

  it('renders the engine args implied by the resolved tier', async () => {
    const out = await profileReport({
      profiles: PROFILES, probe: new FakeGpuProbe(ampere16()), model: 'QuantTrio/Qwen3.5-4B-AWQ',
    })
    expect(out.engineArgs).toContain('--max-model-len')
    expect(out.engineArgs).toContain('65536')
    expect(out.engineArgs).toContain('--max-num-seqs')
  })

  it('surfaces a forbidden KV dtype as a configuration error rather than printing it', async () => {
    const poisoned: ProfileMap = {
      'poisoned-8gb': { min_vram_gib: 8, min_capability: 7.5, vram_ceiling_gib: 7.0, engine: { kv_cache_dtype: 'int8_per_token_head' } },
    }
    const out = await profileReport({ profiles: poisoned, probe: new FakeGpuProbe(ampere16()), require: 'poisoned-8gb' })
    expect(out.exitCode).toBe(2)
    expect(out.text).toMatch(/forbidden_kv_cache_dtype|8\.9/)
  })

  it('survives a GPU that cannot be read at all', async () => {
    const out = await profileReport({
      profiles: PROFILES,
      probe: { async probe() { throw Object.assign(new Error('nvidia-smi failed'), { code: 'gpu_unavailable' }) } },
    })
    expect(out.exitCode).toBe(2)
    expect(out.text).toMatch(/nvidia-smi|gpu/i)
  })

  it('produces parseable JSON when asked', async () => {
    const out = await profileReport({ profiles: PROFILES, probe: new FakeGpuProbe(ampere16()), json: true })
    const parsed = JSON.parse(out.text)
    expect(parsed.resolved).toBe('full-loop-12gb')
    expect(parsed.gpu.capability).toBe(8.6)
    expect(parsed.tiers).toHaveLength(2)
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

  it('exposes --profile and --json flags', async () => {
    const spec = ctx.commandRegistry.get('profiles')
    const flags = (spec.options ?? []).map((o: any) => o.flag)
    expect(flags).toContain('--profile <name>')
    expect(flags.some((f: string) => f.includes('--json'))).toBe(true)
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
