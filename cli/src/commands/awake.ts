import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'
import { runVerb } from '../lib/host-command.js'

const spec: CommandSpec = {
  name: 'awake',
  description: 'Stop training gateway and start inference gateway on a host',
  options: [
    { flag: '-b, --bucket <name>', description: 'Override R2 bucket name' },
    { flag: '--host <name>', description: 'Target host from hosts.yaml (default: SAIP_HOST or "default")' },
  ],
  action: async (ctx: Context, options) => {
    console.log(`[saip] Switching to AWAKE mode...`)
    if (options.bucket) console.log(`[saip] Using bucket override: ${options.bucket}`)
    await runVerb(ctx, 'up', options.host as string | undefined, { bucket: options.bucket as string | undefined })
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) { ctx.commandRegistry!.register(spec) },
}
