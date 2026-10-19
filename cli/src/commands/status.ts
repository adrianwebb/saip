import type { Context } from 'cordis'
import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { CommandSpec } from '../lib/command-registry.js'
import { runVerb } from '../lib/host-command.js'

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

    console.log(`GPU:        TODO (utilization, VRAM)`)
    console.log(`Bucket:     ${cfg?.storage?.r2?.bucket ?? 'TODO (R2 bucket name)'}`)
    console.log(`Uptime:     TODO`)
    // Future: vLLM loaded-adapter query, nvidia-smi stats
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) {
    ctx.commandRegistry!.register(spec)
  },
}
