import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'
import { runVerb, withHost } from '../lib/host-command.js'
import { uiOr } from '../ui/output.js'

const spec: CommandSpec = {
  name: 'sleep',
  description: 'Stop inference gateway and start training gateway on a host',
  options: [
    { flag: '-b, --bucket <name>', description: 'Override R2 bucket name' },
    { flag: '--host <name>', description: 'Target host from hosts.yaml (default: SAIP_HOST or "default")' },
  ],
  action: async (ctx: Context, options) => {
    // Host before announcement (#150) — see down.ts for the reason.
    withHost(ctx, options.host as string | undefined)
    uiOr(ctx).showLine('Switching to SLEEP mode...')
    if (options.bucket) uiOr(ctx).showLine(`Using bucket override: ${options.bucket}`)
    // Sleep = stop inference, start training. On a both-role host this is the
    // inverse of awake; provider.up with stack:'training' selects the training file.
    await runVerb(ctx, 'up', options.host as string | undefined, { bucket: options.bucket as string | undefined, stack: 'training' })
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) { ctx.commandRegistry!.register(spec) },
}
