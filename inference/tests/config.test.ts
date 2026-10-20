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

  it('exposes the declared profile map and leaves the tier unpinned', () => {
    const cfg = loadConfig(repoConfig)
    expect(Object.keys(cfg.profiles).sort()).toEqual(['full-loop-12gb', 'inference-8gb'])
    expect(cfg.profiles['inference-8gb'].vram_ceiling_gib).toBe(7.0)
    // Unpinned on purpose: a pin in the shipped config would cap a 16 GB dev machine at the
    // 8 GB tier forever. Resolution picks the highest tier the probed card satisfies.
    expect(cfg.profile).toBeUndefined()
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

describe('retired security keys (#90)', () => {
  it('loads a config that still sets security.ui.admin_secret and warns instead of ignoring it', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const p = join(mkdtempSync(join(tmpdir(), 'saip-depr-')), 'saip.yaml')
    writeFileSync(p, `platform:\n  name: saip\nsecurity:\n  dev_mode: false\n  ui:\n    admin_secret: SAIP_UI_ADMIN\n`)
    const { loadConfig } = await import('../src/lib/config.js')
    const cfg = loadConfig(p) as any
    // Silently dropping a retired key is how a user keeps believing they configured protection.
    expect(cfg.deprecations?.length).toBeGreaterThan(0)
    expect(cfg.deprecations.join(' ')).toMatch(/security\.ui\.admin_secret/)
    expect(cfg.deprecations.join(' ')).toMatch(/retired|removed/i)
  })
})

describe('deprecation warnings reach output (#90)', () => {
  it('createApp prints a warning naming the retired key, and still boots', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const d = mkdtempSync(join(tmpdir(), 'saip-depr2-'))
    const p = join(d, 'saip.yaml')
    writeFileSync(p, `platform:\n  name: saip\nsecurity:\n  dev_mode: true\n  ui:\n    admin_secret: SAIP_UI_ADMIN\n`)
    const { createApp } = await import('../src/index.js')
    const written: string[] = []
    const real = process.stderr.write.bind(process.stderr)
    ;(process as any).stderr.write = (c: any) => { written.push(String(c)); return true }
    try { await createApp({ configPath: p }) } finally { (process as any).stderr.write = real }
    const text = written.join('')
    expect(text).toMatch(/WARNING/)
    expect(text).toMatch(/security\.ui\.admin_secret/)
    expect(text).toMatch(/retired/)
  })
})
