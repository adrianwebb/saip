import type { Context } from 'cordis'
import { existsSync } from 'node:fs'
import { resolveConfigFile } from '@saip/shared'
import { loadYamlConfig } from '@saip/shared'
import type { CommandSpec } from '../lib/command-registry.js'
import { probeHost } from '../lib/host-command.js'
import { resolveForHost } from './profiles.js'

/**
 * Read saip.yaml through the shared loader so `${VAR}` tokens interpolate here exactly as they
 * do in the gateways — a status line that shows a literal `${SAIP_R2_BUCKET}` while the server
 * resolved it would be worse than showing nothing. Unreadable or unconfigured stays non-fatal:
 * status is read-only and must still report what it can.
 */
function loadConfig(path?: string): any | undefined {
  const r = resolveConfigFile('saip.yaml', { explicit: path, envVar: 'SAIP_CONFIG' })
  path = r.path
  try {
    if (!path || !existsSync(path)) return undefined
    return loadYamlConfig(path)
  } catch {
    return undefined
  }
}

/**
 * The bucket line, or the way to set it. Never `TODO (…)`: an unset bucket is a fact about the
 * configuration, and the useful half of that fact is which file to edit (#114).
 */
function bucketLine(cfg: any): string {
  const b = cfg?.storage?.r2?.bucket
  // An unresolved `${TOKEN}` is worse than unset — it means the config names a variable that the
  // interpolation did not fill, so the operator would paste a literal `${…}` into a provider console.
  if (typeof b === 'string' && b.trim() !== '') {
    return /\$\{[^}]*\}/.test(b) ? `unresolved — ${b} (the variable it names is not set)` : b
  }
  return 'not set — storage.r2.bucket in saip.yaml, or run `saip config init`'
}

/** Uptime as reported, or why there is nothing to report. */
function uptimeLine(probe: Awaited<ReturnType<typeof probeHost>>): string {
  if (probe.status?.uptime) return `${probe.status.uptime} (${probe.host?.name} stack)`
  if (probe.status && probe.status.mode === 'awake') return 'not reported by the host runtime'
  if (probe.status) return 'not reported — the stack is not awake'
  return `not reported — ${probe.unavailable ?? 'the host could not be asked'}`
}

const spec: CommandSpec = {
  name: 'status',
  description: 'Show current runtime state and vital statistics',
  options: [
    { flag: '--host <name>', description: 'Target host from hosts.yaml (default: SAIP_HOST or "default")' },
    { flag: '--json', description: 'Output JSON records for scripts and agents (bypasses the terminal renderer)' },
  ],
  action: async (ctx: Context, options) => {
    const cfg = loadConfig()

    // Rendered through the `ui` seam (#113): the command builds content, the renderer decides
    // presentation, and `console.log` is no longer the formatting layer. The TODO values themselves are
    // #114's job, not this migration's — moving them is the point here.
    const ui = (ctx as any).ui
    // `--json` selects a renderer rather than adding a second output path in this command (#113): the
    // rows below are the same blocks either way, so the machine target cannot drift from what a human
    // was told. Decoration is skipped when structured, because a rule is not a record.
    if (options.json) ui.useRenderer('jsonl')
    if (!ui.structured) {
      ui.showLine('Platform Status')
      ui.show({ kind: 'rule', width: 21 })
    }

    // One probe, one rendering. The provider used to print its own status line through a helper, which
    // is how `Mode` could be a `TODO` here while a real mode was already being printed above it (#114).
    const rows: { label: string; value: string }[] = []
    const probe = await probeHost(ctx, options.host as string | undefined)
    if (probe.host) {
      const label = `${probe.host.name} (${probe.host.kind})`
      rows.push({ label: 'Host', value: probe.status?.reachable ? `${label}: reachable` : `${label}: ${probe.unavailable ?? `unreachable${probe.status?.detail ? ` — ${probe.status.detail}` : ''}`}` })
      // Mode is whatever the provider actually reported. `unknown` is allowed, but never bare: the
      // reason travels with it, because "unknown" alone is a placeholder that happens to be shorter.
      const mode = probe.status?.mode ?? 'unknown'
      const why = probe.unavailable ?? probe.status?.detail ?? (probe.status ? 'no state reported by the provider' : 'the host could not be asked')
      rows.push({ label: 'Mode', value: mode === 'unknown' ? `unknown — ${why}` : mode })
      // Uptime only exists while something is awake; the absence names which question was unanswered.
      rows.push({ label: 'Uptime', value: uptimeLine(probe) })
    } else {
      rows.push({ label: 'Host', value: `not resolved — ${probe.unavailable ?? 'no target host'}` })
      rows.push({ label: 'Mode', value: 'unknown — no host to ask (see saip status --host, or hosts.yaml)' })
      rows.push({ label: 'Uptime', value: 'not reported — no host to ask' })
    }

    // Adapter summary via the SHARED registry service — identical semantics to
    // inference/training; no duplicated resolution in the CLI.
    const adapters: any[] = cfg?.adapters ?? []
    const registry = (ctx as any).adapterRegistry
    if (registry && adapters.length) {
      const validation = registry.validate({ adapters, users: cfg?.users ?? [] })
      const composites = adapters.filter((a) => !!a.composite).length
      rows.push({ label: 'Adapters', value: `${adapters.length} defined (${composites} composite), registry ${validation.valid ? 'valid' : `INVALID (${validation.errors.length} errors)`}` })
    } else if (adapters.length === 0) {
      // `0 defined` is a measurement. The old `TODO` made an empty registry look like a broken read.
      rows.push({ label: 'Adapters', value: '0 defined — none in saip.yaml' })
    } else {
      rows.push({ label: 'Adapters', value: `${adapters.length} defined (registry not validated: no registry service in this context)` })
    }

    // GPU + active profile. Reported, never fatal: `status` answers 0 even with no GPU,
    // because its job is to describe state, unlike `saip profiles` which gates on it.
    try {
      const report = await resolveForHost({})
      if (report.resolution?.ok) {
        const gpu = (report.resolution as any).gpu as { name: string; total_gib: number; free_gib: number; capability: number }
        rows.push({ label: 'GPU', value: `${gpu.name} — ${gpu.total_gib} GiB total, ${gpu.free_gib} GiB free, cc ${gpu.capability}` })
        rows.push({ label: 'Profile', value: `${report.resolution.profile} (${report.resolution.auto ? 'auto-resolved' : 'explicit'}), ceiling ${report.resolution.args.vram_ceiling_gib} GiB` })
        if (report.utilization?.ok) {
          rows.push({ label: '', value: `gpu_memory_utilization=${report.utilization.utilization} (derived), context ${report.resolution.args.engine?.max_model_len ?? '?'} tokens` })
        } else if (report.text.match(/insufficient_free_vram/)) {
          rows.push({ label: '', value: `NOT STARTABLE: ${report.text.replace(/^insufficient_free_vram: /, '')}` })
        }
      } else {
        rows.push({ label: 'GPU', value: report.text })
      }
    } catch (e: any) {
      rows.push({ label: 'GPU', value: `unreadable — ${e?.message ?? e}` })
    }

    rows.push({ label: 'Bucket', value: bucketLine(cfg) })
    ui.show({ kind: 'keyValues', rows })
  },
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context) {
    ctx.commandRegistry!.register(spec)
  },
}
