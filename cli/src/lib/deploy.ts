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
/**
 * `secret:NAME` marks a reference to a secret rather than its value. Names are not secrets —
 * printing them masked would make the plan unreadable without protecting anything.
 */
const isRef = (v: string): boolean => v.startsWith('secret:')

/**
 * The plan is a log surface: it is printed, pasted into issues, and captured by CI. Values are
 * masked by default because anything passed as a process argument is already visible in `ps` and
 * shell history, and a plan that echoes it widens the exposure. `revealParams` exists for
 * non-secret parameters, and is opt-in rather than default so "safe by accident" holds.
 */
export function renderDeployPlan(
  source: HostConfig,
  target: HostConfig,
  params: Record<string, string>,
  opts: { revealParams?: boolean } = {},
): DeployResult {
  const paramStr = Object.entries(params)
    .map(([k, v]) => `${k}=${isRef(v) || opts.revealParams ? v : '\u2022\u2022\u2022\u2022'}`)
    .join(', ')
  const detail =
    `deploy plan: ${source.name} (${source.kind}) → ${target.name} (${target.kind})` +
    (paramStr ? ` · params: ${paramStr}` : '')
  return { planned: true, applied: false, detail }
}
