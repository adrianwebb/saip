/**
 * @saip/shared Cordis services.
 *
 * Cross-cutting capabilities exposed as injectable Services so the CLI,
 * inference gateway, and training gateway consume identical implementations.
 * The pure logic lives in adapter-registry.ts; these classes are thin wrappers
 * that put it on the Cordis reflect surface under a stable name.
 */

import { Service } from 'cordis'
import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { AdapterDefinition } from './types.js'
import {
  validateRegistry,
  parseRef,
  type RegistryInput,
  type ValidationResult,
} from './adapter-registry.js'
import {
  validateHostRegistry,
  EnvSecrets,
  type HostConfig,
  type HostRegistryFile,
  type HostValidationError,
  type SecretsProvider,
} from './hosting.js'
import {
  validateProfiles,
  resolveProfile,
  deriveGpuMemoryUtilization,
  kvCacheConstraint,
  NvidiaSmiProbe,
  type GpuProbe,
  type ProfileMap,
  type ProfileName,
  type ProfileResolution,
  type ProfileValidationError,
  type UtilizationResult,
} from './profiles.js'

/** Namespaced service key used across all SAIP packages. */
export const PROFILE_SERVICE = 'profiles'

/** Namespaced service key used across all SAIP packages. */
export const ADAPTER_REGISTRY_SERVICE = 'adapterRegistry'

/**
 * Provides registry validation and resolution helpers to any Cordis context.
 * Inject with `ctx.plugin(AdapterRegistryService)` then access via `ctx.adapterRegistry`.
 */
export class AdapterRegistryService extends Service {
  static readonly provide = ADAPTER_REGISTRY_SERVICE

  constructor(ctx: any) {
    super(ctx, ADAPTER_REGISTRY_SERVICE)
  }

  /** Validate a full registry (adapters + users) against the documented contract. */
  validate(input: RegistryInput): ValidationResult {
    return validateRegistry(input)
  }

  /** Build a name → definition index for a validated adapter list. */
  index(adapters: AdapterDefinition[]): Map<string, AdapterDefinition> {
    return new Map(adapters.map((a) => [a.name, a]))
  }

  /** True when the named adapter is a composite (derived, not trainable). */
  isComposite(name: string, adapters: AdapterDefinition[]): boolean {
    const found = adapters.find((a) => a.name === name)
    return !!found?.composite || found?.trainable === false
  }

  /** Resolve a `name@version` reference against a concrete-version lookup fn. */
  resolveVersion(
    ref: string,
    latestFor: (name: string) => number | undefined,
  ): { name: string; version?: string } {
    const parsed = parseRef(ref)
    if (parsed.version && parsed.version !== 'latest') return parsed
    const latest = latestFor(parsed.name)
    return { name: parsed.name, version: latest == null ? undefined : String(latest).padStart(6, '0') }
  }
}

export const SECRETS_SERVICE = 'secrets'
export const HOST_REGISTRY_SERVICE = 'hosts'

/** Wraps a SecretsProvider (default EnvSecrets) on the Cordis reflect surface. */
export class SecretsService extends Service {
  static readonly provide = SECRETS_SERVICE
  private readonly provider: SecretsProvider

  constructor(ctx: any, config: { provider?: SecretsProvider } = {}) {
    super(ctx, SECRETS_SERVICE)
    this.provider = config.provider ?? new EnvSecrets()
  }

  get(name: string): Promise<string | undefined> { return this.provider.get(name) }
  require(name: string): Promise<string> { return this.provider.require(name) }
}

/** Loads + validates a host registry from a file path or inline object. */
export class HostRegistryService extends Service {
  static readonly provide = HOST_REGISTRY_SERVICE
  private hosts: HostConfig[] = []

  constructor(ctx: any, config: { path?: string; inline?: HostRegistryFile } = {}) {
    super(ctx, HOST_REGISTRY_SERVICE)
    if (config.inline) {
      this.hosts = config.inline.hosts ?? []
    } else if (config.path && existsSync(config.path)) {
      this.hosts = (parseYaml(readFileSync(config.path, 'utf8'))?.hosts ?? []) as HostConfig[]
    }
  }

  list(): HostConfig[] { return this.hosts }

  resolve(name: string): HostConfig | undefined { return this.hosts.find((h) => h.name === name) }

  /** Structured validation errors for the loaded registry (empty = valid). */
  assertValid(): HostValidationError[] { return validateHostRegistry({ hosts: this.hosts }) }
}

/**
 * Resolves the service profile for the card this process runs on.
 *
 * Wraps the pure logic in `profiles.ts` and puts it on the reflect surface so the CLI,
 * inference gateway, and training gateway derive the same ceiling, engine arguments, and
 * derived `gpu_memory_utilization` from the same probe — the profile is never a constant,
 * because vLLM budgets against total VRAM and gates on free VRAM at launch.
 */
export class ProfileService extends Service {
  static readonly provide = PROFILE_SERVICE
  private readonly profiles: ProfileMap
  private readonly requested?: ProfileName
  private readonly probe: GpuProbe
  private resolved?: ProfileResolution

  constructor(ctx: any, config: { profiles?: ProfileMap; profile?: ProfileName; probe?: GpuProbe } = {}) {
    super(ctx, PROFILE_SERVICE)
    this.profiles = config.profiles ?? {}
    this.requested = config.profile
    this.probe = config.probe ?? new NvidiaSmiProbe()
  }

  /** Structured validation errors for the declared profiles (empty = valid). */
  assertValid(): ProfileValidationError[] { return validateProfiles(this.profiles) }

  /**
   * Probe the card and resolve the active profile. Cached per service instance so the
   * probe happens once per boot. Rejects with a named deficit — never a silent OOM later.
   */
  async resolve(): Promise<ProfileResolution> {
    if (this.resolved) return this.resolved
    const errors = this.assertValid()
    if (errors.length) {
      this.resolved = { ok: false, error: { code: errors[0].code, message: `${errors[0].path}: ${errors[0].message}` } }
      return this.resolved
    }
    const gpu = await this.probe.probe()
    const resolution = resolveProfile(this.profiles, this.requested, gpu)
    if (resolution.ok) {
      // A dtype the card cannot use must not boot: refuse rather than serve garbage.
      const dtype = resolution.args.engine?.kv_cache_dtype ?? 'auto'
      const constraint = kvCacheConstraint(dtype, gpu.capability)
      if (!constraint.allowed) {
        this.resolved = { ok: false, error: { code: 'forbidden_kv_cache_dtype', message: constraint.reason ?? '' } }
        return this.resolved
      }
    }
    this.resolved = resolution
    return resolution
  }

  /** Ceiling + measured memory → the utilization fraction vLLM should be given. */
  async utilization(): Promise<UtilizationResult> {
    const r = await this.resolve()
    if (!r.ok) return { ok: false, error: r.error }
    return deriveGpuMemoryUtilization(r.args.vram_ceiling_gib, r.gpu.total_gib, r.gpu.free_gib)
  }

  list(): ProfileMap { return this.profiles }
}
