/**
 * Deployment provider registry. Maps a HostKind to its provider implementation.
 * `local` is real; `hyperstack` is gated (provisioning requires SAIP_ALLOW_INFRA).
 * Unknown kinds throw rather than silently misbehaving or inventing credentials.
 */

import type { DeploymentProvider, HostKind } from '@saip/shared'
import { LocalDeploymentProvider } from './local.js'
import { HyperstackDeploymentProvider } from './hyperstack.js'
import { withManagedIdentity } from '../ssh-identity.js'

export class UnregisteredProviderError extends Error {
  constructor(public readonly kind: string) {
    super(`no deployment provider registered for kind "${kind}"`)
    this.name = 'UnregisteredProviderError'
  }
}

// Hyperstack is given the identity scope at construction — the single point where a host becomes a
// usable SSH identity (#89). Passing it here rather than per command is what keeps `saip awake` and
// `saip deploy` from diverging into one that authenticates and one that does not.
const REGISTRY: Partial<Record<HostKind, () => DeploymentProvider>> = {
  local: () => new LocalDeploymentProvider(),
  hyperstack: () => new HyperstackDeploymentProvider(undefined, withManagedIdentity),
}

export function providerFor(kind: HostKind): DeploymentProvider {
  const make = REGISTRY[kind]
  if (!make) throw new UnregisteredProviderError(kind)
  return make()
}
