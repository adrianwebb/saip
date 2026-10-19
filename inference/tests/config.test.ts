import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/lib/config.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

describe('loadConfig', () => {
  it('reads the shipped saip.yaml into a typed runtime config', () => {
    const cfg = loadConfig(repoConfig)
    // The reference checkpoint must already be AWQ-quantized: vLLM cannot AWQ-quantize a
    // BF16 repo at load time, and `Qwen/Qwen3.5-4B` is BF16.
    expect(cfg.model.base).toBe('QuantTrio/Qwen3.5-4B-AWQ')
    expect(cfg.adapters.length).toBe(3)
    expect(cfg.users[0].adapters.inference).toBe('default-agent@latest')
    expect(cfg.inference.systemone.enabled).toBe(true)
    expect(cfg.inference.maxLoras).toBe(4)
  })

  it('carries the hardware-dependent model knobs the engine needs', () => {
    const cfg = loadConfig(repoConfig)
    expect(cfg.model.quantization).toBe('awq')
    expect(cfg.model.revision).toBe('32c292e3a73afe1138518180b1b6d2868c980ee2')
    expect(cfg.model.language_model_only).toBe(true)
    expect(cfg.model.kv_cache_dtype).toBe('auto')
  })

  it('exposes the active profile and the declared profile map', () => {
    const cfg = loadConfig(repoConfig)
    expect(cfg.profile).toBe('inference-8gb')
    expect(Object.keys(cfg.profiles).sort()).toEqual(['full-loop-12gb', 'inference-8gb'])
    expect(cfg.profiles['inference-8gb'].vram_ceiling_gib).toBe(7.0)
  })

  it('exposes training method reward_range for feedback validation', () => {
    const cfg = loadConfig(repoConfig)
    expect(cfg.training?.methods?.weighted_kto?.reward_range).toEqual([-3, 3])
  })

  it('returns safe empty defaults when the file is missing', () => {
    const cfg = loadConfig('/nonexistent/saip.yaml')
    expect(cfg.adapters).toEqual([])
    expect(cfg.users).toEqual([])
    expect(cfg.inference.systemone.enabled).toBe(false)
  })
})
