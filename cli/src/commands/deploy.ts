import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'
import { withHost } from '../lib/host-command.js'
import { providerFor } from '../lib/providers/index.js'
import { parseParams, renderDeployPlan } from '../lib/deploy.js'

const spec: CommandSpec = {
  name: 'deploy',
  description: 'Deploy a parameterized copy of a stack to another host',
  options: [
    { flag: '--target <name>', description: 'Destination host from hosts.yaml (required)' },
    { flag: '--source <name>', description: 'Source host (default: "default")' },
    { flag: '--dry-run', description: 'Print the plan without applying (default-safe)' },
    { flag: '-p, --param <kv...>', description: 'Parameter as key=value, or key=secret:NAME to reference a stored secret (repeatable)' },
    { flag: '--reveal-params', description: 'Print parameter values in the plan (they are masked by default)' },
  ],
  action: async (ctx: Context, options) => {
    const targetName = options.target as string | undefined
    if (!targetName) { console.error('[saip] deploy requires --target <host>'); process.exitCode = 1; return }

    // Resolve source + target through the shared registry (fail-closed on unknown).
    const source = withHost(ctx, (options.source as string | undefined) ?? 'default')
    const target = withHost(ctx, targetName)
    const params = parseParams(options.param as string[] | undefined)

    const plan = renderDeployPlan(source, target, params, { revealParams: !!options.revealParams })
    console.log(`[saip] ${plan.detail}`)

    if (options.dryRun) { console.log('[saip] dry-run: nothing applied'); return }

    const provider = providerFor(target.kind)
    if (!provider.deploy) {
      console.error(`[saip] deployment provider "${target.kind}" cannot apply deploys (not implemented)`); process.exitCode = 1; return
    }
    const result = await provider.deploy(source, target, params)
    console.log(`[saip] deploy ${result.applied ? 'applied' : 'planned'}${result.detail ? ` — ${result.detail}` : ''}`)
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) { ctx.commandRegistry!.register(spec) },
}
