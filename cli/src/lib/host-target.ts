/**
 * Host resolution for CLI commands. Resolves the active target host from an
 * explicit --host flag, SAIP_HOST env, or 'default', against the loaded Host
 * Registry — failing closed (listing known hosts) on an unknown name so a typo
 * never silently runs against local.
 */

import type { HostConfig } from '@saip/shared'

/** How many host names one error message may list before it stops being a suggestion. */
const MAX_LISTED_HOSTS = 8

/**
 * Render the known-host list readably.
 *
 * The full inventory is worse than useless on a 40-host registry: the actionable sentence
 * (`set --source <name>`) is buried under names nobody typed. Eight is enough to spot a typo, and
 * `+N more` says the list was truncated rather than that the host count is eight.
 */
export function listHosts(known: string[]): string {
  if (known.length === 0) return '(none)'            // a missing file, not a wrong name
  if (known.length <= MAX_LISTED_HOSTS) return known.join(', ')
  return `${known.slice(0, MAX_LISTED_HOSTS).join(', ')} +${known.length - MAX_LISTED_HOSTS} more`
}

export interface HostRole {
  /**
   * Which side of a two-host command failed. `deploy` resolves a source AND a target, and only the
   * source is implicit — so an error that says `unknown host "default"` after the user typed
   * `--target box2` blames the flag they just got right (#117).
   */
  role?: 'source' | 'target'
  /**
   * The flag (and env) that can supply this host. Defaulted by call site, because the honest answer
   * depends on the command: `deploy` never reads `--host`.
   */
  fix?: string
}

export class UnknownHostError extends Error {
  constructor(
    public readonly requested: string,
    public readonly known: string[],
    hint: HostRole = {},
  ) {
    // Every part of this sentence earns its place: what was looked for, which role it filled, how to
    // change it, and what else exists. `hint.role` is set by a caller that knows it, never guessed here.
    const role = hint.role ? ` deploy ${hint.role} host` : ' host'
    const fix = hint.fix ?? 'set --host <name> or SAIP_HOST'
    super(`unknown${role} "${requested}" — ${fix}. Known hosts: ${listHosts(known)}`)
    this.name = 'UnknownHostError'
  }
}

export function resolveTargetHost(hosts: HostConfig[], requested?: string, hint: HostRole = {}): HostConfig {
  const name = requested ?? process.env.SAIP_HOST ?? 'default'
  const found = hosts.find((h) => h.name === name)
  // `--source`/`--target` are typed explicitly, so SAIP_HOST is not a valid suggestion for them;
  // naming the wrong flag is the defect this is fixing, so the hint is passed through untouched.
  if (!found) throw new UnknownHostError(name, hosts.map((h) => h.name), hint)
  return found
}
