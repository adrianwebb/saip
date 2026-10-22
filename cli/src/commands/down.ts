import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'
import { runVerb, withHost } from '../lib/host-command.js'
import { uiOr } from '../ui/output.js'

const spec: CommandSpec = {
  name: 'down',
  description: 'Shut down all SAIP services on a host',
  options: [{ flag: '--host <name>', description: 'Target host from hosts.yaml (default: SAIP_HOST or "default")' }],
  action: async (ctx: Context, options) => {
    // Resolve FIRST, then announce (#150). The order used to be announcement-then-host, so a typo
    // printed `Shutting down all services...` above an error and read as an action that failed
    // rather than a request that was never valid. `withHost` throws before a word is said; the
    // second resolution inside runVerb is idempotent and keeps that call site unchanged.
    withHost(ctx, options.host as string | undefined)
    uiOr(ctx).showLine('Shutting down all services on a host...')
    await runVerb(ctx, 'down', options.host as string | undefined)
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) { ctx.commandRegistry!.register(spec) },
}
