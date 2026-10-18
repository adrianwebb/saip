import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'

const spec: CommandSpec = {
  name: 'sleep',
  description: 'Stop inference gateway and start training gateway',
  options: [{ flag: '-b, --bucket <name>', description: 'Override R2 bucket name' }],
  action: (_ctx, options) => {
    console.log(`[saip] Switching to SLEEP mode...`)
    console.log(`[saip] TODO: Stop inference compose, start training compose`)
    if (options.bucket) console.log(`[saip] Using bucket override: ${options.bucket}`)
    // Future: validate saip.yaml + load env → compose down inference → up training → status
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) {
    ctx.commandRegistry!.register(spec)
  },
}
