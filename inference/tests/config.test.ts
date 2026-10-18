import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/lib/config.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))

describe('loadConfig', () => {
  it('reads the shipped saip.yaml into a typed runtime config', () => {
    const cfg = loadConfig(repoConfig)
    expect(cfg.model.base).toBe('Qwen/Qwen3.5-4B')
    expect(cfg.adapters.length).toBe(3)
    expect(cfg.users[0].adapters.inference).toBe('default-agent@latest')
    expect(cfg.inference.systemone.enabled).toBe(true)
    expect(cfg.inference.maxLoras).toBe(4)
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
