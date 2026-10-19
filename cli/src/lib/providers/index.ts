/**
 * Deployment provider registry. Maps a HostKind to its provider implementation.
 * `local` is real; `hyperstack` is gated (provisioning requires SAIP_ALLOW_INFRA).
 * Unknown kinds throw rather than silently misbehaving or inventing credentials.
 */

import type { DeploymentProvider, HostKind } from '@saip/shared'
import { LocalDeploymentProvider } from './local.js'
import { HyperstackDeploymentProvider } from './hyperstack.js'

export class UnregisteredProviderError extends Error {
  constructor(public readonly kind: string) {
    super(`no deployment provider registered for kind "${kind}"`)
    this.name = 'UnregisteredProviderError'
  }
}

const REGISTRY: Partial<Record<HostKind, () => DeploymentProvider>> = {
  local: () => new LocalDeploymentProvider(),
  hyperstack: () => new HyperstackDeploymentProvider(),
}

export function providerFor(kind: HostKind): DeploymentProvider {
  const make = REGISTRY[kind]
  if (!make) throw new UnregisteredProviderError(kind)
  return make()
}
