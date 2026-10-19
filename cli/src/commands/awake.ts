import type { Context } from 'cordis'
import type { CommandSpec } from '../lib/command-registry.js'
import { runVerb, withHost } from '../lib/host-command.js'
import { resolveForHost } from './profiles.js'

const spec: CommandSpec = {
  name: 'awake',
  description: 'Stop training gateway and start inference gateway on a host',
  options: [
    { flag: '-b, --bucket <name>', description: 'Override R2 bucket name' },
    { flag: '--host <name>', description: 'Target host from hosts.yaml (default: SAIP_HOST or "default")' },
    { flag: '--profile <name>', description: 'Service profile to run (default: resolve from the GPU)' },
  ],
  action: async (ctx: Context, options) => {
    console.log(`[saip] Switching to AWAKE mode...`)
    if (options.bucket) console.log(`[saip] Using bucket override: ${options.bucket}`)

    // Resolve the target host FIRST: an unknown host is a mistake regardless of hardware,
    // and probing this machine's GPU to validate a remote host would be meaningless.
    const host = withHost(ctx, options.host as string | undefined)

    // For a local host, resolve the hardware contract BEFORE starting compose. A tier the
    // card cannot hold otherwise surfaces as a vLLM crash loop that keeps reserving VRAM —
    // measured at three restarts in as many minutes on a shared GPU.
    if (host.kind === 'local') {
      const report = await resolveForHost(options)
      if (report.exitCode !== 0) {
        console.error(`[saip] ${report.text}`)
        process.exitCode = report.exitCode
        return
      }
      if (report.resolution?.ok) {
        const gpu = (report.resolution as any).gpu
        console.log(`[saip] Profile: ${report.resolution.profile}${report.resolution.auto ? ' (auto-resolved)' : ''} — ${gpu?.name}, ${gpu?.total_gib} GiB total, ${gpu?.free_gib} GiB free, cc ${gpu?.capability}`)
        if (report.utilization?.ok) console.log(`[saip] Derived gpu_memory_utilization=${report.utilization.utilization}`)
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
