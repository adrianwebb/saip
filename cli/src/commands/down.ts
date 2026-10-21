import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'
import { runVerb } from '../lib/host-command.js'
import { uiOr } from '../ui/output.js'

const spec: CommandSpec = {
  name: 'down',
  description: 'Shut down all SAIP services on a host',
  options: [{ flag: '--host <name>', description: 'Target host from hosts.yaml (default: SAIP_HOST or "default")' }],
  action: async (ctx: Context, options) => {
    uiOr(ctx).showLine('Shutting down all services...')
    await runVerb(ctx, 'down', options.host as string | undefined)
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) { ctx.commandRegistry!.register(spec) },
}
