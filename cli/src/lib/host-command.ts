/**
 * Shared command helpers for host-targeted operations. Keeps awake/sleep/down/
 * status thin: resolve the target host (fail-closed), pick its deployment
 * provider by kind, and invoke the verb.
 */

import type { Context } from 'cordis'
import type { HostConfig } from '@saip/shared'
import { resolveTargetHost } from './host-target.js'
import { providerFor } from './providers/index.js'

export function withHost(ctx: Context, requested: string | undefined): HostConfig {
  const hosts = (ctx as any).hosts?.list() ?? []
  return resolveTargetHost(hosts, requested)
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
    const st = await provider.status(host)
    console.log(`[saip] ${host.name} (${host.kind}): reachable=${st.reachable} mode=${st.mode ?? '?'}${st.detail ? ` — ${st.detail}` : ''}`)
  }
}
