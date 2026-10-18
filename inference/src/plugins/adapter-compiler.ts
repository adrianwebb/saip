/**
 * adapter-compiler — inference gateway Cordis plugin.
 *
 * Provides composite adapter compilation planning and staleness detection to the
 * gateway context (`ctx.adapterCompiler`). Depends on the shared AdapterRegistryService
 * for registry semantics. Actual tensor merge execution is delegated to a swappable
 * backend (Python/PEFT) injected at construction; this plugin owns resolution, plan
 * math, provenance, and staleness only.
 */

import { Service } from 'cordis'
import type { AdapterDefinition, CompositionRecord } from '@saip/shared'
import { ADAPTER_REGISTRY_SERVICE } from '@saip/shared/services'
import {
  planCompile,
  planToRecord,
  isStale,
  type CompilePlan,
  type PlanResult,
  type VersionSource,
} from '../lib/adapter-compiler.js'

export interface CompilerBackend {
  /** Execute the weighted merge for a plan and return the produced artifact id. */
  merge(plan: CompilePlan): Promise<{ artifactId: string }>
}

export interface AdapterCompilerConfig {
  adapters?: AdapterDefinition[]
  versions?: VersionSource
  backend?: CompilerBackend
}

declare module 'cordis' {
  interface Context {
    adapterCompiler?: AdapterCompilerService
  }
}

export class AdapterCompilerService extends Service {
  static readonly provide = 'adapterCompiler'

  private adapters: AdapterDefinition[]
  private versions: VersionSource
  private backend?: CompilerBackend

  constructor(ctx: any, config: AdapterCompilerConfig = {}) {
    super(ctx, 'adapterCompiler')
    this.adapters = config.adapters ?? []
    this.versions = config.versions ?? { latestVersion: () => undefined }
    this.backend = config.backend
  }

  setRegistry(adapters: AdapterDefinition[]) {
    this.adapters = adapters
  }

  setVersionSource(versions: VersionSource) {
    this.versions = versions
  }

  setBackend(backend: CompilerBackend) {
    this.backend = backend
  }

  /** Resolve a composite into a compile plan (no side effects). */
  plan(name: string): PlanResult {
    return planCompile(name, this.adapters, this.versions)
  }

  /** Provenance record for a plan. */
  recordFor(plan: CompilePlan): CompositionRecord {
    return planToRecord(plan)
  }

  /** Whether a prior compiled artifact needs recompiling given current state. */
  stale(previous: CompositionRecord, name: string): boolean {
    const result = planCompile(name, this.adapters, this.versions)
    if (!result.ok) return true
    return isStale(previous, result.plan)
  }

  /**
   * Full compile: plan then execute via the injected backend. Throws if no
   * backend is configured or planning fails — callers decide how to surface it.
   */
  async compile(name: string): Promise<{ plan: CompilePlan; artifactId: string }> {
    const result = planCompile(name, this.adapters, this.versions)
    if (!result.ok) throw new Error(`compile failed: ${result.error.code}: ${result.error.message}`)
    if (!this.backend) throw new Error('no compiler backend configured')
    const { artifactId } = await this.backend.merge(result.plan)
    return { plan: result.plan, artifactId }
  }
}
