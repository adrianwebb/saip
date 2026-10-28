import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'
import { runVerb, withHost } from '../lib/host-command.js'
import { resolveForHost } from './profiles.js'
import { uiOr } from '../ui/output.js'
import { profileBlocks } from './profiles.js'
import type { GpuInfo } from '@saip/shared'

const spec: CommandSpec = {
  name: 'awake',
  description: 'Stop training gateway and start inference gateway on a host',
  options: [
    { flag: '-b, --bucket <name>', description: 'Override R2 bucket name' },
    { flag: '--host <name>', description: 'Target host from hosts.yaml (default: SAIP_HOST or "default")' },
    { flag: '--profile <name>', description: 'Service profile to run (default: resolve from the GPU)' },
  ],
  action: async (ctx: Context, options) => {
    // Resolve the target host FIRST — before any line is printed (#150). An unknown host is a
    // mistake regardless of hardware, and announcing "Switching to AWAKE mode" above the error made
    // a request that was never valid read as an action that then failed.
    const host = withHost(ctx, options.host as string | undefined)

    uiOr(ctx).showLine('Switching to AWAKE mode...')
    if (options.bucket) uiOr(ctx).showLine(`Using bucket override: ${options.bucket}`)

    // For a local host, resolve the hardware contract BEFORE starting compose. A tier the
    // card cannot hold otherwise surfaces as a vLLM crash loop that keeps reserving VRAM —
    // measured at three restarts in as many minutes on a shared GPU.
    if (host.kind === 'local') {
      const report = await resolveForHost(options)
      if (report.exitCode !== 0) {
        // The refusal goes through the seam like every other line this command produces (#156): the
        // renderer decides the prefix, and a pipe still gets plain text. `ui.line` returns the rendered
        // string rather than writing it, because a command that cannot start must still answer on stderr
        // — the failure is not payload, and a caller separating the streams is the case it is for.
        const ui = uiOr(ctx)
        for (const b of profileBlocks(report)) console.error(ui.render(b))
        process.exitCode = report.exitCode
        return
      }
      if (report.resolution?.ok) {
        const gpu = report.gpu ?? (report.resolution as { gpu?: GpuInfo }).gpu
        uiOr(ctx).showLine(`Profile: ${report.resolution.profile}${report.resolution.auto ? ' (auto-resolved)' : ''} — ${gpu?.name}, ${gpu?.total_gib} GiB total, ${gpu?.free_gib} GiB free, cc ${gpu?.capability}`)
        if (report.utilization?.ok) uiOr(ctx).showLine(`Derived gpu_memory_utilization=${report.utilization.utilization}`)
      }
      // The engine reads this to render its arguments; SAIP_PROFILE propagates to compose.
      if (options.profile) process.env.SAIP_PROFILE = String(options.profile)
    }

    await runVerb(ctx, 'up', options.host as string | undefined, { bucket: options.bucket as string | undefined })
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) { ctx.commandRegistry!.register(spec) },
}
