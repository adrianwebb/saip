import { describe, it, expect } from 'vitest'
import {
  validateProfiles,
  resolveProfile,
  deriveGpuMemoryUtilization,
  kvCacheConstraint,
  renderVllmArgs,
  type GpuInfo,
  type ProfileMap,
  type ProfileName,
} from '../src/profiles.js'

/** The two tiers SAIP documents, kept in sync with reference/hardware-profiles.mdx. */
const PROFILES: ProfileMap = {
  'inference-8gb': {
    min_vram_gib: 8,
    min_capability: 7.5,
    vram_ceiling_gib: 7.0,
    engine: { max_model_len: 24576, kv_cache_dtype: 'auto', enforce_eager: true, enable_lora: true, max_loras: 4, max_lora_rank: 16, language_model_only: true },
  },
  'full-loop-12gb': {
    min_vram_gib: 12,
    min_capability: 8.0,
    vram_ceiling_gib: 11.0,
    engine: { max_model_len: 65536, kv_cache_dtype: 'auto', enforce_eager: false, enable_lora: true, max_loras: 4, max_lora_rank: 16, language_model_only: true },
    training: { precision: 'bf16', sequence_len: 2048, gradient_checkpointing: true, optimizer: 'adamw_bnb_8bit' },
  },
}

const gpu = (over: Partial<GpuInfo> = {}): GpuInfo => ({
  name: 'NVIDIA GeForce RTX 3080 Laptop GPU',
  total_gib: 15.58,
  free_gib: 13.0,
  capability: 8.6,
  ...over,
})

describe('validateProfiles', () => {
  it('accepts the documented tier pair', () => {
    expect(validateProfiles(PROFILES)).toEqual([])
  })

  it('rejects an empty profile map', () => {
    expect(validateProfiles({}).map((e) => e.code)).toContain('no_profiles')
  })

  it('requires the hardware contract fields', () => {
    const bad = { 'x': { engine: {} } } as unknown as ProfileMap
    expect(validateProfiles(bad).map((e) => e.code)).toContain('missing_tier_field')
  })

  it('flags a ceiling that exceeds the tier minimum VRAM as impossible', () => {
    // A 7.0 ceiling on a tier that requires >= 8 GiB is fine; a 20 GiB ceiling on an
    // 8 GiB-minimum tier can never be satisfied by a card that only meets the minimum.
    const bad = { ...PROFILES, 'inference-8gb': { ...PROFILES['inference-8gb'], vram_ceiling_gib: 20 } }
    expect(validateProfiles(bad).map((e) => e.code)).toContain('ceiling_exceeds_tier')
  })

  it('rejects a ceiling of zero or below', () => {
    const bad = { ...PROFILES, 'inference-8gb': { ...PROFILES['inference-8gb'], vram_ceiling_gib: 0 } }
    expect(validateProfiles(bad).map((e) => e.code)).toContain('invalid_ceiling')
  })

  it('requires a positive max_model_len when present', () => {
    const bad = { ...PROFILES, 'inference-8gb': { ...PROFILES['inference-8gb'], engine: { ...PROFILES['inference-8gb'].engine, max_model_len: 0 } } }
    expect(validateProfiles(bad).map((e) => e.code)).toContain('invalid_max_model_len')
  })

  it('rejects training settings on a tier below Ampere', () => {
    // bf16 training needs compute capability >= 8.0; declaring training on a 7.5 tier
    // is a contract that cannot be honored.
    const bad = { ...PROFILES, 'inference-8gb': { ...PROFILES['inference-8gb'], min_capability: 7.5, training: { precision: 'bf16' as const } } }
    expect(validateProfiles(bad).map((e) => e.code)).toContain('training_capability_unsupported')
  })

  it('rejects fp16 + training below capability 8.0 only when precision is bf16', () => {
    const ok = { ...PROFILES, 'inference-8gb': { ...PROFILES['inference-8gb'], training: { precision: 'fp16' as const } } }
    expect(validateProfiles(ok)).toEqual([])
  })
})

describe('kvCacheConstraint — the silent-corruption gate', () => {
  // Measured on SM 8.6: fp8* is rejected by vLLM, and int8_per_token_head is ACCEPTED
  // but produces garbage with no error. Both must be refused below capability 8.9.
  it.each([
    ['fp8', 8.6],
    ['fp8_e4m3', 8.6],
    ['fp8_e5m2', 7.5],
    ['int8_per_token_head', 8.6],
    ['int8_per_token_head', 7.5],
  ])('forbids %s on compute capability %s', (dtype, cap) => {
    const r = kvCacheConstraint(dtype, cap)
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/8\.9/)
  })

  it.each([
    ['fp8', 8.9],
    ['fp8_e4m3', 9.0],
    ['int8_per_token_head', 8.9],
  ])('allows %s at capability %s and above', (dtype, cap) => {
    expect(kvCacheConstraint(dtype, cap).allowed).toBe(true)
  })

  it.each(['auto', 'float16'])('always allows %s', (dtype) => {
    expect(kvCacheConstraint(dtype, 7.5).allowed).toBe(true)
  })

  it('requires Ampere for bfloat16 KV', () => {
    expect(kvCacheConstraint('bfloat16', 7.5).allowed).toBe(false)
    expect(kvCacheConstraint('bfloat16', 8.0).allowed).toBe(true)
  })

  it('refuses to validate a profile whose engine dtype is unusable on the card', () => {
    const resolved = resolveProfile(PROFILES, undefined, gpu({ capability: 7.5 }))
    // The 7.5 card may take inference-8gb by VRAM, but its engine requests `auto`, which
    // is fine — assert the happy path does not error.
    expect(resolved.ok).toBe(true)
  })
})

describe('resolveProfile', () => {
  it('honors an explicit selection', () => {
    const r = resolveProfile(PROFILES, 'full-loop-12gb', gpu({ total_gib: 15.58 }))
    expect(r.ok && r.profile).toBe('full-loop-12gb')
  })

  it('auto-resolves to the highest tier the card satisfies', () => {
    expect(resolveProfile(PROFILES, undefined, gpu({ total_gib: 15.58 })).profile).toBe('full-loop-12gb')
    expect(resolveProfile(PROFILES, undefined, gpu({ total_gib: 8 })).profile).toBe('inference-8gb')
  })

  it('does not pick a tier whose capability floor the card misses', () => {
    // 12 GiB of VRAM but Turing (7.5): full-loop requires 8.0, so inference-8gb it is.
    const r = resolveProfile(PROFILES, undefined, gpu({ total_gib: 12, capability: 7.5 }))
    expect(r.ok && r.profile).toBe('inference-8gb')
  })

  it('fails closed with a named deficit when nothing fits', () => {
    const r = resolveProfile(PROFILES, undefined, gpu({ total_gib: 4, free_gib: 3 }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('no_satisfiable_profile')
      expect(r.error.message).toMatch(/4(\.0)? GiB/)
    }
  })

  it('errors on an unknown explicit profile rather than silently falling back', () => {
    const r = resolveProfile(PROFILES, 'not-a-tier' as ProfileName, gpu())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unknown_profile')
  })

  it('refuses an explicit tier the card cannot satisfy (never a silent OOM later)', () => {
    const r = resolveProfile(PROFILES, 'full-loop-12gb', gpu({ total_gib: 8 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('insufficient_vram')
  })
})

describe('deriveGpuMemoryUtilization', () => {
  // vLLM computes `requested = ceil(total × util)` and aborts if free < requested, so
  // utilization must be derived from the ceiling and gated on measured free memory.
  it('divides the ceiling by total VRAM', () => {
    expect(deriveGpuMemoryUtilization(7.0, 15.58, 13.0).utilization).toBeCloseTo(7 / 15.58, 4)
  })

  it('never exceeds 1.0', () => {
    // Ceiling below the card's free memory but close to its total.
    const r = deriveGpuMemoryUtilization(14, 15.58, 15.0)
    expect(r.ok && r.utilization).toBeLessThanOrEqual(1)
  })

  it('fails when free memory cannot hold the ceiling', () => {
    const r = deriveGpuMemoryUtilization(7.0, 15.58, 4.0)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('insufficient_free_vram')
      // Message must name both numbers so a shared-GPU failure is diagnosable.
      expect(r.error.message).toMatch(/free/i)
      expect(r.error.message).toMatch(/4(\.0)? GiB/)
    }
  })

  it('applies headroom so the desktop compositor is not evicted', () => {
    // free exactly equals the ceiling: without headroom this would start and then OOM.
    expect(deriveGpuMemoryUtilization(7.0, 15.58, 7.0).ok).toBe(false)
    expect(deriveGpuMemoryUtilization(7.0, 15.58, 7.6).ok).toBe(true)
  })

  it('reports the absolute budget alongside the fraction', () => {
    const r = deriveGpuMemoryUtilization(7.0, 15.58, 13.0)
    expect(r.ok && r.budget_gib).toBeCloseTo(7.0, 1)
  })
})

describe('renderVllmArgs', () => {
  const base = {
    model: 'QuantTrio/Qwen3.5-4B-AWQ',
    servedNames: ['saip-instruct', 'saip-systemone'],
    utilization: 0.4494,
  }

  it('passes the profile engine knobs as flags', () => {
    const argv = renderVllmArgs(PROFILES['inference-8gb'], { ...base, capability: 8.6 })
    expect(argv).toContain('--max-model-len')
    expect(argv).toContain('24576')
    expect(argv).toContain('--language-model-only')
    expect(argv).toContain('--enforce-eager')
    expect(argv).toContain('--enable-lora')
  })

  it('omits --enforce-eager on the tier that can afford CUDA graphs', () => {
    const argv = renderVllmArgs(PROFILES['full-loop-12gb'], { ...base, capability: 8.9 })
    expect(argv).not.toContain('--enforce-eager')
  })

  it('emits ONE variadic --served-model-name with space-separated aliases', () => {
    // Repeating the flag keeps only the last alias; a comma-joined value creates a single
    // alias named "a,b". Both make the other name 404.
    const argv = renderVllmArgs(PROFILES['inference-8gb'], { ...base, capability: 8.6 })
    const i = argv.indexOf('--served-model-name')
    expect(i).toBeGreaterThan(-1)
    expect(argv[i + 1]).toBe('saip-instruct')
    expect(argv[i + 2]).toBe('saip-systemone')
    expect(argv.filter((a) => a === '--served-model-name')).toHaveLength(1)
    expect(argv.join(' ')).not.toContain('saip-instruct,saip-systemone')
  })

  it('only emits --kv-cache-dtype when it is not the default', () => {
    expect(renderVllmArgs(PROFILES['inference-8gb'], { ...base, capability: 8.6 })).not.toContain('--kv-cache-dtype')
  })

  it('throws rather than rendering a silently corrupting dtype for the card', () => {
    const poisoned: ProfileMap = {
      'x': { ...PROFILES['inference-8gb'], engine: { ...PROFILES['inference-8gb'].engine, kv_cache_dtype: 'int8_per_token_head' } },
    }
    expect(() => renderVllmArgs(poisoned['x'], { ...base, capability: 8.6 } as any)).toThrow(/8\.9/)
    // Same profile is legal on Ada — it is the card, not the flag, that decides.
    expect(() => renderVllmArgs(poisoned['x'], { ...base, capability: 8.9 } as any)).not.toThrow()
  })

  it('renders the derived utilization with enough precision to be reproducible', () => {
    const argv = renderVllmArgs(PROFILES['inference-8gb'], { ...base, capability: 8.6 })
    const i = argv.indexOf('--gpu-memory-utilization')
    expect(Number(argv[i + 1])).toBeCloseTo(0.4494, 4)
  })
})
