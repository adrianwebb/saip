import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'
import { runVerb } from '../lib/host-command.js'

const spec: CommandSpec = {
  name: 'sleep',
  description: 'Stop inference gateway and start training gateway on a host',
  options: [
    { flag: '-b, --bucket <name>', description: 'Override R2 bucket name' },
    { flag: '--host <name>', description: 'Target host from hosts.yaml (default: SAIP_HOST or "default")' },
  ],
  action: async (ctx: Context, options) => {
    console.log(`[saip] Switching to SLEEP mode...`)
    if (options.bucket) console.log(`[saip] Using bucket override: ${options.bucket}`)
    // Sleep = stop inference, start training. On a both-role host this is the
    // inverse of awake; provider.up with stack:'training' selects the training file.
    await runVerb(ctx, 'up', options.host as string | undefined, { bucket: options.bucket as string | undefined, stack: 'training' })
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) { ctx.commandRegistry!.register(spec) },
}
