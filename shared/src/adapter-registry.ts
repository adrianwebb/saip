/**
 * Adapter registry validation and resolution.
 *
 * Pure functions (no runtime deps) so the CLI, inference gateway, and training
 * gateway all agree on what a valid registry is. The Cordis service wrapper
 * lives in services.ts; this module is the single source of truth for the rules
 * documented at reference/adapter-definitions.md#validation-contract.
 */

import type { AdapterDefinition, CompositeComponent } from './types.js'

export interface ValidationError {
  /** JSON-ish path to the offending field, e.g. "adapters[2].composite.components[1]" */
  path: string
  code: ValidationErrorCode
  message: string
}

export type ValidationErrorCode =
  | 'leaf_or_composite'
  | 'missing_linkage'
  | 'missing_project'
  | 'unknown_component'
  | 'self_reference'
  | 'cycle'
  | 'invalid_weight'
  | 'too_few_components'
  | 'unknown_adapter_ref'

export interface RegistryInput {
  adapters?: AdapterDefinition[]
  users?: Array<{ id: string; adapters: { inference?: string; training?: string } }>
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

/** Split a `name@version` adapter reference into its parts. Version may be absent. */
export function parseRef(ref: string): { name: string; version?: string } {
  const at = ref.indexOf('@')
  if (at === -1) return { name: ref }
  return { name: ref.slice(0, at), version: ref.slice(at + 1) }
}

/**
 * Validate an adapter registry against the documented contract.
 * Returns structured errors rather than throwing, so callers can render them.
 */
export function validateRegistry(input: RegistryInput): ValidationResult {
  const errors: ValidationError[] = []
  const adapters = input.adapters ?? []
  const names = new Set<string>()

  // First pass: collect names, detect duplicates
  adapters.forEach((a, i) => {
    if (!a.name) {
      errors.push({ path: `adapters[${i}]`, code: 'leaf_or_composite', message: 'adapter entry missing name' })
      return
    }
    if (names.has(a.name)) {
      errors.push({ path: `adapters[${i}].name`, code: 'leaf_or_composite', message: `duplicate adapter name: ${a.name}` })
    }
    names.add(a.name)
  })

  adapters.forEach((a, i) => {
    const hasTraining = !!a.training
    const hasComposite = !!a.composite

    // exactly one of training / composite
    if (hasTraining === hasComposite) {
      errors.push({
        path: `adapters[${i}] (${a.name})`,
        code: 'leaf_or_composite',
        message: 'an adapter must define exactly one of `training` or `composite`',
      })
    }

    // leaf linkage completeness
    if (hasTraining) {
      const t = a.training!
      if (!t.strategy || !Array.isArray(t.data_scopes) || t.data_scopes.length === 0) {
        errors.push({
          path: `adapters[${i}].training (${a.name})`,
          code: 'missing_linkage',
          message: 'leaf adapters require training.strategy and non-empty training.data_scopes',
        })
      }
    }

    // project scope requires project field
    if (a.scope === 'project' && !a.project) {
      errors.push({
        path: `adapters[${i}] (${a.name})`,
        code: 'missing_project',
        message: "scope 'project' requires a project field",
      })
    }

    // composite structure
    if (hasComposite) {
      const comps: CompositeComponent[] = a.composite!.components ?? []
      if (comps.length < 2) {
        errors.push({
          path: `adapters[${i}].composite (${a.name})`,
          code: 'too_few_components',
          message: 'a composite must reference at least two components',
        })
      }
      comps.forEach((c, j) => {
        const { name: compName } = parseRef(c.adapter)
        if (!names.has(compName)) {
          errors.push({
            path: `adapters[${i}].composite.components[${j}] (${a.name})`,
            code: 'unknown_component',
            message: `component references unknown adapter: ${c.adapter}`,
          })
        }
        if (compName === a.name) {
          errors.push({
            path: `adapters[${i}].composite.components[${j}] (${a.name})`,
            code: 'self_reference',
            message: 'a composite cannot reference itself',
          })
        }
        if (!Number.isFinite(c.weight) || c.weight < 0) {
          errors.push({
            path: `adapters[${i}].composite.components[${j}] (${a.name})`,
            code: 'invalid_weight',
            message: `component weight must be finite and >= 0 (got ${c.weight})`,
          })
        }
      })
    }
  })

  // cycle detection over composite → component edges (only among known nodes)
  const compositeEdges = new Map<string, string[]>()
  for (const a of adapters) {
    if (a.composite) {
      compositeEdges.set(a.name, (a.composite.components ?? []).map((c) => parseRef(c.adapter).name))
    }
  }
  findCycles(compositeEdges).forEach((cyclePath) => {
    errors.push({
      path: `adapters (${cyclePath.join(' → ')})`,
      code: 'cycle',
      message: `composite reference cycle detected: ${cyclePath.join(' → ')}`,
    })
  })

  // user references resolve to existing adapters
  ;(input.users ?? []).forEach((u, i) => {
    for (const role of ['inference', 'training'] as const) {
      const ref = u.adapters[role]
      if (!ref) continue
      const { name } = parseRef(ref)
      if (!names.has(name)) {
        errors.push({
          path: `users[${i}] (${u.id}).adapters.${role}`,
          code: 'unknown_adapter_ref',
          message: `references unknown adapter: ${ref}`,
        })
      }
    }
  })

  return { valid: errors.length === 0, errors }
}

/** Iterative DFS detecting any cycle in a directed adjacency map. Returns cycles as node paths. */
function findCycles(edges: Map<string, string[]>): string[][] {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const cycles: string[][] = []
  for (const n of edges.keys()) color.set(n, WHITE)

  const dfs = (start: string) => {
    const stack: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }]
    while (stack.length) {
      const frame = stack[stack.length - 1]
      const c = color.get(frame.node) ?? WHITE
      if (c === WHITE) color.set(frame.node, GRAY)
      const neighbors = (edges.get(frame.node) ?? []).filter((n) => edges.has(n))
      let advanced = false
      for (const nb of neighbors) {
        const nc = color.get(nb) ?? WHITE
        if (nc === GRAY) {
          // found a back-edge → cycle
          const idx = frame.path.indexOf(nb)
          cycles.push([...frame.path.slice(idx === -1 ? 0 : idx), nb])
          continue
        }
        if (nc === WHITE) {
          stack.push({ node: nb, path: [...frame.path, nb] })
          advanced = true
          break
        }
      }
      if (!advanced) {
        color.set(frame.node, BLACK)
        stack.pop()
      }
    }
  }

  for (const n of edges.keys()) {
    if ((color.get(n) ?? WHITE) === WHITE) dfs(n)
  }
  return cycles
}
