/**
 * Config loading: YAML parse → environment interpolation, in one place.
 *
 * Every package used to hand-roll `parseYaml(readFileSync(...))`, so `saip.yaml` reached
 * consumers with its `${VAR}` tokens still literal — `storage.r2.bucket` was the string
 * "${SAIP_R2_BUCKET}". Interpolation is documented in
 * `docs/src/content/docs/reference/configuration.mdx`; this module is the implementation of
 * that contract, and the docs were corrected first so the interface was fixed before the
 * internals.
 *
 * Deliberate choices:
 * - **Fail closed.** An unset or empty variable is an error, not an empty string. Empty
 *   credentials fail much later as an opaque provider 403, which is a bad debugging story.
 * - **Single pass.** A substituted value is never re-scanned, so a secret containing `${...}`
 *   cannot trigger another lookup, and nested tokens are rejected rather than guessed at.
 * - **Strings only.** Numbers and booleans are never stringified by proximity to a token.
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

/** Thrown for interpolation failures. `errors` lists every problem, not just the first. */
export class ConfigInterpolationError extends Error {
  readonly name = 'ConfigInterpolationError'
  constructor(message: string, readonly errors: Array<{ path: string; variable: string; message: string }>) {
    super(message)
  }
}

/** A token is `${NAME}`, `${NAME:-default}`, or `${NAME:?message}`. Nothing else. */
const TOKEN = /\$\{([^{}]*)\}/g
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type Env = Record<string, string | undefined>

const toPath = (src: string | URL): string =>
  typeof src === 'string' ? src : fileURLToPath(src)

/**
 * Walk a parsed document, substituting `${...}` tokens in every string value.
 * Returns a new structure; the input is never mutated.
 */
export function interpolate<T>(value: T, env: Env, path = ''): T {
  const problems: Array<{ path: string; variable: string; message: string }> = []

  const walk = (v: unknown, p: string): unknown => {
    if (typeof v === 'string') {
      // Reject nesting before any substitution: `${A_${B}}` yields a malformed token, and
      // guessing an intent here would invent a feature the docs say does not exist.
      if (/\$\{[^{}]*\$\{/.test(v)) {
        problems.push({ path: p, variable: v, message: `invalid interpolation token at ${p}: nested \${\${...}\} is not supported` })
        return v
      }
      return v.replace(TOKEN, (whole, raw: string) => {
        const sepDefault = raw.indexOf(':-')
        const sepRequired = raw.indexOf(':?')
        let name = raw
        let fallback: string | undefined
        let requiredMessage: string | undefined
        if (sepDefault >= 0) {
          name = raw.slice(0, sepDefault); fallback = raw.slice(sepDefault + 2)
        } else if (sepRequired >= 0) {
          name = raw.slice(0, sepRequired); requiredMessage = raw.slice(sepRequired + 2)
        }
        name = name.trim()
        if (!VALID_NAME.test(name)) {
          problems.push({ path: p, variable: name || whole, message: `invalid interpolation token at ${p}: ${whole}` })
          return whole
        }
        const resolved = env[name]
        if (resolved !== undefined && resolved !== '') return resolved
        if (fallback !== undefined) return fallback
        if (requiredMessage !== undefined) {
          problems.push({ path: p, variable: name, message: `missing variable: ${name} (at ${p || 'root'}) — ${requiredMessage}` })
          return whole
        }
        problems.push({ path: p, variable: name, message: `missing variable: ${name} (at ${p || 'root'})` })
        return whole
      })
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${p}[${i}]`))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, p ? `${p}.${k}` : k)
      return out
    }
    return v
  }

  const result = walk(value, path) as T
  if (problems.length) {
    const detail = problems.map((e) => e.message).join('; ')
    throw new ConfigInterpolationError(`config interpolation failed — ${detail}`, problems)
  }
  return result
}

/**
 * Parse a `.env` file into a plain object without touching `process.env`.
 *
 * Callers merge with the shell winning: `{...loadEnvFile(p), ...process.env}`. Absent file is
 * an empty object — `.env` is optional by design. Lines whose key is indented or malformed are
 * skipped rather than guessed at, so `  F=x` does not silently become `F`.
 */
export function loadEnvFile(src: string | URL): Record<string, string> {
  const path = toPath(src)
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || /^\s/.test(line) || /^\s*#/.test(line)) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    if (!VALID_NAME.test(key)) continue
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
        (val.startsWith("'") && val.endsWith("'") && val.length > 1)) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

export interface LoadOptions {
  /** Fully resolved environment. Omit to use shell over `.env` over defaults. */
  env?: Env
  /** `.env` location when `env` is not supplied. */
  envFile?: string | URL
}

/** Read, parse, and interpolate a YAML config in one step. */
export function loadYamlConfig<T = Record<string, any>>(src: string | URL, opts: LoadOptions = {}): T {
  const path = toPath(src)
  if (!existsSync(path)) throw new ConfigInterpolationError(`config file not found: ${path}`, [])
  const env = opts.env ?? { ...loadEnvFile(opts.envFile ?? defaultEnvFile()), ...stripUndefined(process.env) }
  let doc: unknown
  try {
    doc = parseYaml(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new ConfigInterpolationError(`cannot parse config ${path}: ${(e as Error).message}`, [])
  }
  return interpolate((doc ?? {}) as T, env)
}

function stripUndefined(env: NodeJS.ProcessEnv): Env {
  const out: Env = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

function defaultEnvFile(): string {
  return process.env.SAIP_ENV_FILE ?? '.env'
}
