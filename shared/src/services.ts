/**
 * @saip/shared Cordis services.
 *
 * Cross-cutting capabilities exposed as injectable Services so the CLI,
 * inference gateway, and training gateway consume identical implementations.
 * The pure logic lives in adapter-registry.ts; these classes are thin wrappers
 * that put it on the Cordis reflect surface under a stable name.
 */

import { Service } from 'cordis'
import type { AdapterDefinition } from './types.js'
import {
  validateRegistry,
  parseRef,
  type RegistryInput,
  type ValidationResult,
} from './adapter-registry.js'

/** Namespaced service key used across all SAIP packages. */
export const ADAPTER_REGISTRY_SERVICE = 'adapterRegistry'

/**
 * Provides registry validation and resolution helpers to any Cordis context.
 * Inject with `ctx.plugin(AdapterRegistryService)` then access via `ctx.adapterRegistry`.
 */
export class AdapterRegistryService extends Service {
  static readonly provide = ADAPTER_REGISTRY_SERVICE

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
