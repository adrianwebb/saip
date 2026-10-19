import type { Context } from 'cordis'
import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { CommandSpec } from '../lib/command-registry.js'
import { runVerb } from '../lib/host-command.js'
import { resolveForHost } from './profiles.js'

/** Minimal saip.yaml reader (path overridable for tests). */
function loadConfig(path = process.env.SAIP_CONFIG ?? 'saip.yaml'): any | undefined {
  try {
    if (!existsSync(path)) return undefined
    return parseYaml(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const spec: CommandSpec = {
  name: 'status',
  description: 'Show current runtime state and vital statistics',
  options: [{ flag: '--host <name>', description: 'Target host from hosts.yaml (default: SAIP_HOST or "default")' }],
  action: async (ctx: Context, options) => {
    const cfg = loadConfig()

    console.log(`[saip] Platform Status`)
    console.log(`─────────────────────`)

    // Host reachability via the target's deployment provider.
    try { await runVerb(ctx, 'status', options.host as string | undefined) }
    catch (e: any) { console.log(`Host:       ${e.message}`) }
    console.log(`Mode:       TODO (awake / asleep / down)`)

    // Adapter summary via the SHARED registry service — identical semantics to
    // inference/training; no duplicated resolution in the CLI.
    const adapters: any[] = cfg?.adapters ?? []
    const registry = (ctx as any).adapterRegistry
    if (registry && adapters.length) {
      const validation = registry.validate({ adapters, users: cfg?.users ?? [] })
      const composites = adapters.filter((a) => !!a.composite).length
      console.log(`Adapters:   ${adapters.length} defined (${composites} composite), registry ${validation.valid ? 'valid' : `INVALID (${validation.errors.length} errors)`}`)
    } else {
      console.log(`Adapters:   ${adapters.length || 'TODO'} (count and names)`)
    }

    // GPU + active profile. Reported, never fatal: `status` answers 0 even with no GPU,
    // because its job is to describe state, unlike `saip profiles` which gates on it.
    try {
      const report = await resolveForHost({})
      if (report.resolution?.ok) {
        const gpu = (report.resolution as any).gpu as { name: string; total_gib: number; free_gib: number; capability: number }
        console.log(`GPU:        ${gpu.name} — ${gpu.total_gib} GiB total, ${gpu.free_gib} GiB free, cc ${gpu.capability}`)
        console.log(`Profile:    ${report.resolution.profile} (${report.resolution.auto ? 'auto-resolved' : 'explicit'}), ceiling ${report.resolution.args.vram_ceiling_gib} GiB`)
        if (report.utilization?.ok) {
          console.log(`            gpu_memory_utilization=${report.utilization.utilization} (derived), context ${report.resolution.args.engine?.max_model_len ?? '?'} tokens`)
        } else if (report.text.match(/insufficient_free_vram/)) {
          console.log(`            NOT STARTABLE: ${report.text.replace(/^insufficient_free_vram: /, '')}`)
        }
      } else {
        console.log(`GPU:        ${report.text}`)
      }
    } catch (e: any) {
      console.log(`GPU:        unreadable — ${e?.message ?? e}`)
    }

    console.log(`Bucket:     ${cfg?.storage?.r2?.bucket ?? 'TODO (R2 bucket name)'}`)
    console.log(`Uptime:     TODO`)
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) {
    ctx.commandRegistry!.register(spec)
  },
}
