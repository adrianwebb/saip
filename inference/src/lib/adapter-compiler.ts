/**
 * Adapter compilation planning (pure, testable).
 *
 * Resolves a composite adapter into a concrete compile plan: component versions,
 * weights, gain, and merge algorithm. The actual tensor merge is executed by a
 * swappable Python/PEFT backend; this module only decides WHAT to merge and
 * records provenance. Uses shared parseRef for reference semantics.
 */

import type { AdapterDefinition, CompositionRecord } from '@saip/shared'
import { parseRef } from '@saip/shared'

export interface VersionSource {
  /** Return the current promoted version number for an adapter name, or undefined. */
  latestVersion(name: string): number | undefined
}

export interface CompilePlan {
  /** Composite adapter name (without version). */
  name: string
  gain: number
  merge: string
  /** Resolved components with concrete versions. */
  components: Array<{ id: string; version: number; weight: number }>
  /** Base model all components must share. */
  base?: string
}

export type PlanError =
  | { code: 'not_composite'; message: string }
  | { code: 'unknown_adapter'; message: string }
  | { code: 'unresolved_version'; message: string; component: string }
  | { code: 'base_mismatch'; message: string }

export type PlanResult = { ok: true; plan: CompilePlan } | { ok: false; error: PlanError }

/** Build a lookup index of adapters by name. */
export function indexAdapters(adapters: AdapterDefinition[]): Map<string, AdapterDefinition> {
  return new Map(adapters.map((a) => [a.name, a]))
}

/**
 * Resolve a composite adapter into a compile plan. A component may pin a specific
 * version (`@000012`) or track `@latest` (resolved via the VersionSource).
 */
export function planCompile(
  name: string,
  adapters: AdapterDefinition[],
  versions: VersionSource,
): PlanResult {
  const idx = indexAdapters(adapters)
  const target = idx.get(name)
  if (!target) return { ok: false, error: { code: 'unknown_adapter', message: `adapter not found: ${name}` } }
  if (!target.composite) {
    return { ok: false, error: { code: 'not_composite', message: `${name} is not a composite adapter` } }
  }

  const resolved: Array<{ id: string; version: number; weight: number }> = []
  let base: string | undefined

  for (const comp of target.composite.components) {
    const { name: cname, version: vpin } = parseRef(comp.adapter)
    let versionNum: number | undefined

    if (vpin && vpin !== 'latest') {
      // Pinned version like "000012"
      versionNum = Number.parseInt(vpin.replace(/^@/, ''), 10)
      if (Number.isNaN(versionNum)) {
        return { ok: false, error: { code: 'unresolved_version', message: `bad version pin "${vpin}"`, component: cname } }
      }
    } else {
      versionNum = versions.latestVersion(cname)
      if (versionNum == null) {
        return { ok: false, error: { code: 'unresolved_version', message: `no promoted version for @latest component "${cname}"`, component: cname } }
      }
    }

    resolved.push({ id: cname, version: versionNum, weight: comp.weight })

    const compDef = idx.get(cname)
    const cbase = compDef?.base ?? target.base
    if (cbase) {
      if (base && base !== cbase) {
        return { ok: false, error: { code: 'base_mismatch', message: `components target different bases: ${base} vs ${cbase}` } }
      }
      base = cbase
    }
  }

  return {
    ok: true,
    plan: {
      name,
      gain: target.composite.gain ?? 1.0,
      merge: target.composite.merge ?? 'weighted_linear',
      components: resolved,
      base,
    },
  }
}

/** Convert a plan into the manifest provenance record stored in R2. */
export function planToRecord(plan: CompilePlan): CompositionRecord {
  return { gain: plan.gain, merge: plan.merge, components: plan.components }
}

/**
 * Decide whether a previously compiled artifact is stale relative to current
 * component versions + spec. Used to trigger recompilation on promotion.
 */
export function isStale(
  previous: CompositionRecord,
  current: CompilePlan,
): boolean {
  if (previous.gain !== current.gain) return true
  if (previous.merge !== current.merge) return true
  if (previous.components.length !== current.components.length) return true
  const prevById = new Map(previous.components.map((c) => [c.id, c]))
  for (const c of current.components) {
    const p = prevById.get(c.id)
    if (!p || p.version !== c.version || p.weight !== c.weight) return true
  }
  return false
}
