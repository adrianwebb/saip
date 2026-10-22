import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'
import { withHost } from '../lib/host-command.js'
import { providerFor } from '../lib/providers/index.js'
import { parseParams, renderDeployPlan } from '../lib/deploy.js'
import { uiOr } from '../ui/output.js'

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

    // Resolve source + target through the shared registry, fail-closed, and say WHICH side failed
    // (#117): `deploy --target box2` with no `default` host used to report `unknown host "default"`,
    // blaming the implicit source while pointing at nothing the user could act on. `deploy` does not
    // read --host or SAIP_HOST for these two, so the fix names the flag that does.
    const source = withHost(ctx, (options.source as string | undefined) ?? 'default',
      { role: 'source', fix: 'set --source <name>' })
    const target = withHost(ctx, targetName, { role: 'target', fix: 'set --target <name>' })
    const params = parseParams(options.param as string[] | undefined)

    const plan = renderDeployPlan(source, target, params, { revealParams: !!options.revealParams })
    uiOr(ctx).showLine(String(plan.detail))

    if (options.dryRun) { uiOr(ctx).showLine('dry-run: nothing applied'); return }

    const provider = providerFor(target.kind)
    if (!provider.deploy) {
      console.error(`[saip] deployment provider "${target.kind}" cannot apply deploys (not implemented)`); process.exitCode = 1; return
    }
    const result = await provider.deploy(source, target, params)
    uiOr(ctx).showLine(`deploy ${result.applied ? 'applied' : 'planned'}${result.detail ? ` — ${result.detail}` : ''}`)
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) { ctx.commandRegistry!.register(spec) },
}
