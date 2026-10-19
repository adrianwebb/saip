/**
 * Typed runtime configuration loader for the inference gateway.
 *
 * Reads saip.yaml (path overridable via SAIP_CONFIG or an argument) and maps
 * the snake_case on-disk schema into a small typed shape the plugins consume.
 * Pure: no side effects, safe defaults when the file is absent so tests and
 * partial configs never crash the boot path.
 */

import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { AdapterDefinition, UserEntry, ApiTokenConfig } from '@saip/shared'

export interface Message {
  role: string
  content: string
}

export interface SecurityConfig {
  dev_mode: boolean
  api_tokens: ApiTokenConfig[]
  ui?: { admin_secret?: string }
}

export interface SaipRuntimeConfig {
  model: { base: string }
  users: UserEntry[]
  adapters: AdapterDefinition[]
  inference: {
    port: number
    maxLoras: number
    systemone: { enabled: boolean }
  }
  training?: {
    methods?: {
      weighted_kto?: { reward_range?: [number, number] }
    }
  }
  storage?: Record<string, unknown>
  security: SecurityConfig
}

const DEFAULTS: SaipRuntimeConfig = {
  model: { base: '' },
  users: [],
  adapters: [],
  inference: { port: 8000, maxLoras: 4, systemone: { enabled: false } },
  security: { dev_mode: false, api_tokens: [] },
}

export function loadConfig(path = process.env.SAIP_CONFIG ?? 'saip.yaml'): SaipRuntimeConfig {
  if (!existsSync(path)) return structuredClone(DEFAULTS)

  let raw: any
  try {
    raw = parseYaml(readFileSync(path, 'utf8'))
  } catch {
    return structuredClone(DEFAULTS)
  }
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULTS)

  const inf = raw.inference ?? {}
  const kto = raw.training?.methods?.weighted_kto
  return {
    model: { base: raw.model?.base ?? '' },
    users: Array.isArray(raw.users) ? raw.users : [],
    adapters: Array.isArray(raw.adapters) ? raw.adapters : [],
    inference: {
      port: Number(inf.port ?? 8000),
      maxLoras: Number(inf.max_loras ?? 4),
      systemone: { enabled: !!inf.systemone?.enabled },
    },
    training: raw.training
      ? {
          methods: {
            ...(kto ? { weighted_kto: { reward_range: kto.reward_range } } : {}),
          },
        }
      : undefined,
    storage: raw.storage,
    security: {
      dev_mode: !!raw.security?.dev_mode,
      api_tokens: Array.isArray(raw.security?.api_tokens)
        ? raw.security.api_tokens.map((t: any) => ({ caller: String(t.caller), token_secret: String(t.token_secret ?? t.secret ?? '') }))
        : [],
      ui: raw.security?.ui ? { admin_secret: raw.security.ui.admin_secret } : undefined,
    },
  }
}
