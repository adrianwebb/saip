import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'

const spec: CommandSpec = {
  name: 'awake',
  description: 'Stop training gateway and start inference gateway',
  options: [{ flag: '-b, --bucket <name>', description: 'Override R2 bucket name' }],
  action: (_ctx, options) => {
    console.log(`[saip] Switching to AWAKE mode...`)
    console.log(`[saip] TODO: Stop training compose, start inference compose`)
    if (options.bucket) console.log(`[saip] Using bucket override: ${options.bucket}`)
    // Future: validate saip.yaml + load env → compose down training → up inference → vLLM health → status
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) {
    ctx.commandRegistry!.register(spec)
  },
}
