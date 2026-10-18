import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'

const spec: CommandSpec = {
  name: 'down',
  description: 'Shut down all SAIP services',
  action: (_ctx) => {
    console.log(`[saip] Shutting down all services...`)
    console.log(`[saip] TODO: docker compose down for both services`)
    // Future: compose down inference + training, report confirmation
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) {
    ctx.commandRegistry!.register(spec)
  },
}
