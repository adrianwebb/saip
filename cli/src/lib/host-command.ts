/**
 * Shared command helpers for host-targeted operations. Keeps awake/sleep/down/
 * status thin: resolve the target host (fail-closed), pick its deployment
 * provider by kind, and invoke the verb.
 */

import type { Context } from 'cordis'
import type { HostConfig } from '@saip/shared'
import type { HostStatus } from '@saip/shared'
import { resolveTargetHost } from './host-target.js'
import { providerFor } from './providers/index.js'
import { uiOr } from '../ui/output.js'

export function withHost(ctx: Context, requested: string | undefined): HostConfig {
  const hosts = (ctx as any).hosts?.list() ?? []
  return resolveTargetHost(hosts, requested)
}

/**
 * What the caller asked about and what the host answered — kept separate so a command can *render*
 * the answer instead of a helper printing it on the caller's behalf.
 *
 * `unavailable` is set when the target could not even be resolved (no `hosts.yaml`, unknown name):
 * the reason is carried out rather than thrown, because `saip status` must still report the rest of
 * the platform (#114). `awake`/`down` verbs keep throwing through {@link runVerb}.
 */
export interface HostProbe {
  host?: HostConfig
  status?: HostStatus
  /** Why nothing was learned, when the host could not be resolved or the provider was unreachable. */
  unavailable?: string
}

/**
 * Ask a host's deployment provider for its state and RETURN it.
 *
 * This function exists because `runVerb` used to print the status line itself. That made two
 * formatting paths for one fact — the helper's `showLine` and `status`'s own rows — which is how
 * `Mode` could stay a `TODO` in the report while a real `mode` was already being printed above it
 * (#114, #113's "one place decides presentation" rule). A probe returns data; only the command renders.
 */
export async function probeHost(ctx: Context, requestedHost?: string): Promise<HostProbe> {
  let host: HostConfig
  try {
    host = withHost(ctx, requestedHost)
  } catch (e: any) {
    return { unavailable: e?.message ?? String(e) }
  }
  try {
    return { host, status: await providerFor(host.kind).status(host) }
  } catch (e: any) {
    return { host, unavailable: e?.message ?? String(e) }
  }
}

export async function runVerb(
  ctx: Context,
  verb: 'up' | 'down' | 'status',
  requestedHost?: string,
  opts?: { bucket?: string; stack?: 'inference' | 'training' },
): Promise<void> {
  const host = withHost(ctx, requestedHost)
  const provider = providerFor(host.kind)
  if (verb === 'up') await provider.up(host, opts)
  else if (verb === 'down') await provider.down(host, opts)
  else {
    // The verb still reports to the operator when it is what they asked for (`awake`/`sleep`/`down`
    // call their own status), but it no longer *formats* anything for `saip status` — that command
    // owns its rendering, which is the whole point of the seam (#113). `probeHost` is the data path.
    const st = await provider.status(host)
    uiOr(ctx).showLine(`${host.name} (${host.kind}): reachable=${st.reachable} mode=${st.mode ?? '?'}${st.detail ? ` — ${st.detail}` : ''}`)
  }
}
