import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { ProfileService } from '../src/services.js'
import { FakeGpuProbe, type GpuInfo, type ProfileMap } from '../src/profiles.js'

const PROFILES: ProfileMap = {
  'inference-8gb': {
    min_vram_gib: 8, min_capability: 7.5, vram_ceiling_gib: 7.0,
    engine: { max_model_len: 24576, kv_cache_dtype: 'auto', enforce_eager: true, enable_lora: true, max_loras: 4 },
  },
  'full-loop-12gb': {
    min_vram_gib: 12, min_capability: 8.0, vram_ceiling_gib: 11.0,
    engine: { max_model_len: 65536, kv_cache_dtype: 'auto', enable_lora: true, max_loras: 4 },
    training: { precision: 'bf16', sequence_len: 2048 },
  },
}

const gpu = (over: Partial<GpuInfo> = {}): GpuInfo => ({ name: 'test-gpu', total_gib: 15.58, free_gib: 13, capability: 8.6, ...over })

async function wire(config: { profiles?: ProfileMap; profile?: string; probe?: GpuInfo } = {}) {
  const ctx = new Context()
  await ctx.plugin(ProfileService, {
    profiles: config.profiles ?? PROFILES,
    profile: config.profile,
    probe: new FakeGpuProbe(config.probe ?? gpu()),
  })
  return ctx as any
}

describe('ProfileService (Cordis wrapper)', () => {
  it('lands on ctx.profiles for any consumer', async () => {
    const ctx = await wire()
    expect(ctx.profiles).toBeInstanceOf(ProfileService)
  })

  it('auto-resolves the best tier the probed card satisfies', async () => {
    const ctx = await wire({ probe: gpu({ total_gib: 8, free_gib: 7.6 }) })
    const r = await ctx.profiles.resolve()
    expect(r.ok && r.profile).toBe('inference-8gb')
    expect(r.ok && r.auto).toBe(true)
  })

  it('derives utilization from the ceiling over the card total', async () => {
    const ctx = await wire({ profile: 'inference-8gb' })
    const u = await ctx.profiles.utilization()
    expect(u.ok && u.utilization).toBeCloseTo(7.0 / 15.58, 4)
  })

  it('surfaces invalid profile declarations instead of resolving past them', async () => {
    const ctx = await wire({ profiles: { bad: { engine: {} } } as any })
    const r = await ctx.profiles.resolve()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('missing_tier_field')
  })

  it('refuses to resolve when the shared GPU has too little free memory', async () => {
    // 15.58 GiB card that only meets the 12 GiB tier by TOTAL, but a desktop session has
    // eaten the memory — the profile must fail here, not inside vLLM minutes later.
    const ctx = await wire({ profile: 'full-loop-12gb', probe: gpu({ total_gib: 15.58, free_gib: 4.0 }) })
    const u = await ctx.profiles.utilization()
    expect(u.ok).toBe(false)
    if (!u.ok) expect(u.error.code).toBe('insufficient_free_vram')
  })

  it('rejects a profile poisoned with a KV dtype the probed card cannot use', async () => {
    // The whole point: this combination boots, reports a bigger cache, and returns garbage.
    const poisoned: ProfileMap = {
      'int8-8gb': { min_vram_gib: 8, min_capability: 7.5, vram_ceiling_gib: 7.0, engine: { kv_cache_dtype: 'int8_per_token_head' } },
    }
    const ctx = await wire({ profiles: poisoned, profile: 'int8-8gb', probe: gpu({ capability: 8.6 }) })
    const r = await ctx.profiles.resolve()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('forbidden_kv_cache_dtype')
      expect(r.error.message).toMatch(/8\.9/)
    }
  })

  it('accepts that same profile on Ada (it is the card, not the flag)', async () => {
    const poisoned: ProfileMap = {
      'int8-8gb': { min_vram_gib: 8, min_capability: 7.5, vram_ceiling_gib: 7.0, engine: { kv_cache_dtype: 'int8_per_token_head' } },
    }
    const ctx = await wire({ profiles: poisoned, profile: 'int8-8gb', probe: gpu({ capability: 8.9 }) })
    expect((await ctx.profiles.resolve()).ok).toBe(true)
  })

  it('caches the probe — one device read per boot', async () => {
    let calls = 0
    const ctx = new Context()
    await ctx.plugin(ProfileService, {
      profiles: PROFILES,
      probe: { probe: async () => { calls++; return gpu() } },
    })
    const svc = (ctx as any).profiles
    await svc.resolve()
    await svc.resolve()
    expect(calls).toBe(1)
  })

  it('reads the shipped saip.yaml profiles and resolves them', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const YAML = (await import('yaml')).default ?? (await import('yaml'))
    const path = new URL('../../saip.yaml', import.meta.url)
    if (!existsSync(path)) return
    const doc = YAML.parse(readFileSync(path, 'utf8'))
    expect(doc.profiles).toBeDefined()
    const ctx = await wire({ profiles: doc.profiles, profile: doc.profile })
    expect(ctx.profiles.assertValid()).toEqual([])
  })
})
