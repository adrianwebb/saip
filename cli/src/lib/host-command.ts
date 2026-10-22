/**
 * Shared command helpers for host-targeted operations. Keeps awake/sleep/down/
 * status thin: resolve the target host (fail-closed), pick its deployment
 * provider by kind, and invoke the verb.
 */

import type { Context } from 'cordis'
import type { HostConfig } from '@saip/shared'
import type { HostStatus } from '@saip/shared'
import { resolveTargetHost, type HostRole } from './host-target.js'
import { providerFor } from './providers/index.js'

/**
 * Resolve the host a command was pointed at, with the wording that belongs to THAT command (#117).
 *
 * `deploy` calls this twice — once for the implicit source, once for the explicit target — and the
 * reader needs to know which one failed, because only one of them was something they typed. Single-host
 * commands pass no hint and get the `--host`/`SAIP_HOST` sentence.
 */
export function withHost(ctx: Context, requested: string | undefined, hint?: HostRole): HostConfig {
  const hosts = (ctx as any).hosts?.list() ?? []
  return resolveTargetHost(hosts, requested, hint)
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

/**
 * Run a state-changing verb. It changes state and stays silent about presentation.
 *
 * The `status` verb was removed here (#114): it used to `showLine` a host summary, which made it a
 * second formatting path for the same fact `saip status` renders — the direct cause of a report that
 * printed a real mode above `Mode: TODO`. Reading state is {@link probeHost}'s job; presenting it
 * belongs to the command. Any future caller that wants to print must go through the `ui` seam.
 */
export async function runVerb(
  ctx: Context,
  verb: 'up' | 'down',
  requestedHost?: string,
  opts?: { bucket?: string; stack?: 'inference' | 'training' },
): Promise<void> {
  const host = withHost(ctx, requestedHost)
  const provider = providerFor(host.kind)
  if (verb === 'up') await provider.up(host, opts)
  else await provider.down(host, opts)
}
