/**
 * Typed runtime configuration loader for the inference gateway.
 *
 * Reads saip.yaml (path overridable via SAIP_CONFIG or an argument) and maps
 * the snake_case on-disk schema into a small typed shape the plugins consume.
 * Pure: no side effects, safe defaults when the file is absent so tests and
 * partial configs never crash the boot path.
 */

import { existsSync } from 'node:fs'
import { loadYamlConfig } from '@saip/shared'
import type { AdapterDefinition, UserEntry, ApiTokenConfig } from '@saip/shared'
import type { ProfileMap } from '@saip/shared'

export interface Message {
  role: string
  content: string
}

export interface SecurityConfig {
  dev_mode: boolean
  api_tokens: ApiTokenConfig[]
  ui?: { admin_secret?: string }
}

export interface ModelConfig {
  base: string
  quantization?: string
  revision?: string
  dtype?: string
  max_model_len?: number
  language_model_only?: boolean
  kv_cache_dtype?: string
}

export interface SaipRuntimeConfig {
  model: ModelConfig
  /** Active service profile name; undefined means auto-resolve from the probed GPU. */
  profile?: string
  /** Declared service profiles (hardware contract) — validated by `ProfileService`. */
  profiles: ProfileMap
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
  profiles: {},
  users: [],
  adapters: [],
  inference: { port: 8000, maxLoras: 4, systemone: { enabled: false } },
  security: { dev_mode: false, api_tokens: [] },
}

export function loadConfig(path = process.env.SAIP_CONFIG ?? 'saip.yaml'): SaipRuntimeConfig {
  if (!existsSync(path)) return structuredClone(DEFAULTS)

  let raw: any
  try {
    // Shared loader: YAML parse then ${VAR} interpolation, shell winning over .env.
    raw = loadYamlConfig(path)
  } catch (e) {
    // A missing required variable is a real configuration error and must propagate with the
    // variable name — swallowing it reproduces the silent-failure class this loader exists to
    // end. Only unreadable/corrupt YAML keeps the previous lenient behavior.
    //
    // Matched by name, not `instanceof`: this package consumes @saip/shared from dist/ while
    // tests load it from src/, and a dual-identity class makes instanceof fail — which would
    // silently downgrade a real config error to defaults, the exact failure mode being removed.
    if ((e as { name?: string })?.name === 'ConfigInterpolationError') throw e
    return structuredClone(DEFAULTS)
  }
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULTS)

  const inf = raw.inference ?? {}
  const kto = raw.training?.methods?.weighted_kto
  const m = raw.model ?? {}
  return {
    model: {
      base: m.base ?? '',
      quantization: m.quantization,
      revision: m.revision,
      dtype: m.dtype,
      max_model_len: m.max_model_len === undefined ? undefined : Number(m.max_model_len),
      language_model_only: m.language_model_only === undefined ? undefined : !!m.language_model_only,
      kv_cache_dtype: m.kv_cache_dtype,
    },
    profile: raw.profile === undefined ? undefined : String(raw.profile),
    // Passed through unvalidated: ProfileService (shared) owns profile semantics, so the
    // loader stays a parser and every package can validate the same way.
    profiles: raw.profiles && typeof raw.profiles === 'object' ? (raw.profiles as ProfileMap) : {},
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
