/**
 * Learning job linkage resolution (pure, testable).
 *
 * Implements the documented adapter → strategy → data-scope inheritance for
 * POST /v1/learning/jobs: resolve the target adapter from the registry, inherit
 * its declared training linkage unless the request overrides it, and reject
 * composites/unknown adapters with the correct status codes.
 */

import type { AdapterDefinition } from '@saip/shared'

export interface JobRequest {
  adapter?: string
  strategy?: string
  data_ids?: string[]
  params?: Record<string, unknown>
}

export interface ResolvedJob {
  adapter: string
  strategy: string
  data_scopes: string[]
  data_ids?: string[]
  params: Record<string, unknown>
  /** Which fields were inherited from the registry vs explicitly provided. */
  inherited: { strategy: boolean; data_scopes: boolean }
}

export type ResolveError =
  | { status: 404; code: 'adapter_not_found'; message: string }
  | { status: 422; code: 'composite_not_trainable'; message: string }
  | { status: 422; code: 'no_linkage'; message: string }
  | { status: 422; code: 'unknown_strategy'; message: string }

export type ResolveResult =
  | { ok: true; job: ResolvedJob }
  | { ok: false; error: ResolveError }

export interface ResolveContext {
  adapters: AdapterDefinition[]
  /** Caller's default training adapter (from users[].adapters.training). */
  defaultAdapter?: string
  /** Strategy plugin names registered in this gateway. */
  registeredStrategies: string[]
}

/**
 * Resolve a learning-job request against the adapter registry.
 * Precedence: explicit request field > adapter declaration > error.
 */
export function resolveJobLinkage(
  req: JobRequest,
  ctx: ResolveContext,
): ResolveResult {
  const adapterName = req.adapter ?? ctx.defaultAdapter
  if (!adapterName) {
    return { ok: false, error: { status: 404, code: 'adapter_not_found', message: 'no adapter specified and no default training adapter' } }
  }

  const adapter = ctx.adapters.find((a) => a.name === adapterName)
  if (!adapter) {
    return { ok: false, error: { status: 404, code: 'adapter_not_found', message: `adapter not found: ${adapterName}` } }
  }

  // Composites are derived, never trained directly.
  if (adapter.composite || adapter.trainable === false) {
    return { ok: false, error: { status: 422, code: 'composite_not_trainable', message: `${adapterName} is a composite and cannot be trained directly; train its components` } }
  }

  // Leaf must declare linkage (unless the request supplies everything).
  const linkage = adapter.training
  const strategy = req.strategy ?? linkage?.strategy
  if (!strategy) {
    return { ok: false, error: { status: 422, code: 'no_linkage', message: `${adapterName} has no training.strategy and none was provided` } }
  }
  if (!ctx.registeredStrategies.includes(strategy)) {
    return { ok: false, error: { status: 422, code: 'unknown_strategy', message: `strategy not registered: ${strategy}` } }
  }

  const data_scopes = linkage?.data_scopes ?? []
  const params = { ...(linkage?.params ?? {}), ...(req.params ?? {}) }

  return {
    ok: true,
    job: {
      adapter: adapterName,
      strategy,
      data_scopes,
      data_ids: req.data_ids,
      params,
      inherited: {
        strategy: !req.strategy,
        data_scopes: true, // data scopes always come from the adapter declaration
      },
    },
  }
}
