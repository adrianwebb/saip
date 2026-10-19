/**
 * Host resolution for CLI commands. Resolves the active target host from an
 * explicit --host flag, SAIP_HOST env, or 'default', against the loaded Host
 * Registry — failing closed (listing known hosts) on an unknown name so a typo
 * never silently runs against local.
 */

import type { HostConfig } from '@saip/shared'

export class UnknownHostError extends Error {
  constructor(public readonly requested: string, public readonly known: string[]) {
    super(`unknown host "${requested}". Known hosts: ${known.join(', ') || '(none)'}`)
    this.name = 'UnknownHostError'
  }
}

export function resolveTargetHost(hosts: HostConfig[], requested?: string): HostConfig {
  const name = requested ?? process.env.SAIP_HOST ?? 'default'
  const found = hosts.find((h) => h.name === name)
  if (!found) throw new UnknownHostError(name, hosts.map((h) => h.name))
  return found
}
