/**
 * Deploy planning for `saip deploy`. Pure functions that build a deploy plan
 * from a source host, target host, and parameters. Applying a plan requires the
 * target's DeploymentProvider to implement deploy(); planning itself never has
 * side effects, so --dry-run is safe against any host kind.
 */

import type { HostConfig, DeployResult } from '@saip/shared'

export function parseParams(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of list ?? []) {
    const eq = item.indexOf('=')
    if (eq <= 0) continue // skip malformed entries lacking key=
    out[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return out
}

/** Build a human-readable plan describing what deploying would do. */
export function renderDeployPlan(source: HostConfig, target: HostConfig, params: Record<string, string>): DeployResult {
  const paramStr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ')
  const detail =
    `deploy plan: ${source.name} (${source.kind}) → ${target.name} (${target.kind})` +
    (paramStr ? ` · params: ${paramStr}` : '')
  return { planned: true, applied: false, detail }
}
