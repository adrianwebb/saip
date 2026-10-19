/**
 * `saip profiles` — report the hardware contract for this machine.
 *
 * Answers "will this run here" without pulling an image or loading weights: probe the GPU,
 * resolve the tier, derive the utilization, render the engine arguments. The report takes an
 * injected `GpuProbe`, so resolution is testable on a machine with no GPU at all — CI never
 * needs one.
 *
 * It calls the same `@saip/shared` functions both gateways use. That is the point: the CLI
 * cannot claim a tier fits that the server then fails to boot.
 */
import type { Context } from 'cordis'
import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
  validateProfiles,
  resolveProfile,
  deriveGpuMemoryUtilization,
  kvCacheConstraint,
  renderVllmArgs,
  NvidiaSmiProbe,
  type GpuInfo,
  type GpuProbe,
  type ProfileMap,
  type ProfileResolution,
  type UtilizationResult,
} from '@saip/shared'
import type { CommandSpec } from '../lib/command-registry.js'

export interface TierRow {
  name: string
  fits: boolean
  /** Why it does not fit, when it does not. */
  why?: string
}

export interface ProfileReport {
  /** 0 resolved · 1 configuration error · 2 no profile fits / GPU unreadable */
  exitCode: number
  text: string
  tiers: TierRow[]
  resolution?: ProfileResolution
  utilization?: UtilizationResult
  engineArgs?: string
}

export interface ReportInput {
  profiles: ProfileMap
  probe: GpuProbe
  /** Treat this tier as explicitly selected, the way `--profile` does. */
  require?: string
  model?: string
  json?: boolean
}

function tierRows(profiles: ProfileMap, gpu: GpuInfo): TierRow[] {
  return Object.entries(profiles).map(([name, p]) => {
    const reasons: string[] = []
    if (gpu.total_gib < p.min_vram_gib) reasons.push(`needs ${p.min_vram_gib} GiB VRAM, card has ${gpu.total_gib} GiB`)
    if (gpu.capability < p.min_capability) reasons.push(`needs compute capability ${p.min_capability}, card has ${gpu.capability}`)
    return { name, fits: reasons.length === 0, why: reasons.length ? reasons.join('; ') : undefined }
  })
}

/** Probe, resolve, and render. Never throws: every failure becomes a report + exit code. */
export async function profileReport(input: ReportInput): Promise<ProfileReport> {
  const { profiles, probe, require: requested, model, json } = input

  // Validate here too rather than trusting the caller: this is the exported primitive, and
  // an unusable tier declaration should read as a configuration error, not a crash.
  const errors = validateProfiles(profiles)
  if (errors.length) {
    return { exitCode: 1, text: `invalid profiles:\n${errors.map((e) => `  ${e.code} @ ${e.path}: ${e.message}`).join('\n')}`, tiers: [] }
  }

  let gpu: GpuInfo
  try {
    gpu = await probe.probe()
  } catch (err) {
    return { exitCode: 2, text: `gpu_unavailable: ${(err as Error).message}`, tiers: [] }
  }

  const tiers = tierRows(profiles, gpu)
  const fail = (code: string, message: string): ProfileReport => ({ exitCode: 2, text: `${code}: ${message}`, tiers })

  const resolution = resolveProfile(profiles, requested, gpu)
  if (!resolution.ok) return fail(resolution.error.code, resolution.error.message)

  const args = resolution.args
  const constraint = kvCacheConstraint(args.engine?.kv_cache_dtype ?? 'auto', gpu.capability)
  if (!constraint.allowed) return fail('forbidden_kv_cache_dtype', constraint.reason ?? '')

  const util = deriveGpuMemoryUtilization(args.vram_ceiling_gib, gpu.total_gib, gpu.free_gib)
  if (!util.ok) return fail(util.error.code, util.error.message)

  let engineArgs: string | undefined
  if (model) {
    try {
      engineArgs = renderVllmArgs(args, {
        model,
        servedNames: ['saip-instruct', 'saip-systemone'],
        utilization: util.utilization,
        capability: gpu.capability,
      }).join(' ')
    } catch (err) {
      return fail('forbidden_kv_cache_dtype', (err as Error).message)
    }
  }

  if (json) {
    return {
      exitCode: 0,
      tiers,
      resolution,
      utilization: util,
      engineArgs,
      text: JSON.stringify({ gpu, resolved: resolution.profile, auto: resolution.auto, utilization: util.utilization, ceiling_gib: args.vram_ceiling_gib, tiers, engineArgs }, null, 2),
    }
  }

  const width = Math.max(...tiers.map((t) => t.name.length), 7)
  const lines = [
    `[saip] GPU: ${gpu.name} — ${gpu.total_gib} GiB total, ${gpu.free_gib} GiB free, cc ${gpu.capability}`,
    '',
    `  ${'profile'.padEnd(width)}   min VRAM  min cc   ceiling  fits`,
    ...tiers.map((t) => {
      const p = profiles[t.name]
      const fit = t.fits ? 'yes' : `no — ${t.why}`
      return `  ${t.name.padEnd(width)}  ${`${p.min_vram_gib} GiB`.padStart(8)}  ${String(p.min_capability).padStart(6)}  ${`${p.vram_ceiling_gib} GiB`.padStart(8)}  ${fit}`
    }),
    '',
    `[saip] Resolved: ${resolution.profile} (${resolution.auto ? 'auto' : 'explicit'})`,
    `[saip] Derived --gpu-memory-utilization=${util.utilization} (${args.vram_ceiling_gib} GiB ceiling / ${gpu.total_gib} GiB total)`,
  ]
  if (engineArgs) lines.push(`[saip] Engine: ${engineArgs}`)
  return { exitCode: 0, text: lines.join('\n'), tiers, resolution, utilization: util, engineArgs }
}

/** Read the profiles block out of saip.yaml. */
export function loadProfiles(path = process.env.SAIP_CONFIG ?? 'saip.yaml'): { profiles?: ProfileMap; profile?: string; model?: string; error?: string } {
  if (!existsSync(path)) return { error: `no configuration file at ${path}` }
  try {
    const doc = parseYaml(readFileSync(path, 'utf8'))
    return { profiles: doc?.profiles, profile: doc?.profile, model: doc?.model?.base }
  } catch (err) {
    return { error: `cannot parse ${path}: ${(err as Error).message}` }
  }
}

/** Shared by the command and `awake`, so both describe the same resolution. */
export async function resolveForHost(options: Record<string, unknown> = {}, deps: { profiles?: ProfileMap; probe?: GpuProbe; model?: string; profile?: string } = {}): Promise<ProfileReport> {
  let profiles = deps.profiles
  let model = deps.model
  let requested = (options.profile as string | undefined) ?? deps.profile
  if (!profiles) {
    const loaded = loadProfiles()
    if (loaded.error) return { exitCode: 1, text: `[saip] ${loaded.error}`, tiers: [] }
    profiles = loaded.profiles
    model ??= loaded.model
    requested ??= loaded.profile
    if (!profiles || !Object.keys(profiles).length) {
      return { exitCode: 1, text: '[saip] no `profiles:` block in saip.yaml — declare at least one tier', tiers: [] }
    }
  }
  const errors = validateProfiles(profiles)
  if (errors.length) {
    return { exitCode: 1, text: `[saip] invalid profiles:\n${errors.map((e) => `  ${e.code} @ ${e.path}: ${e.message}`).join('\n')}`, tiers: [] }
  }
  return profileReport({ profiles, probe: deps.probe ?? new NvidiaSmiProbe(), require: requested, model, json: !!options.json })
}

const spec: CommandSpec = {
  name: 'profiles',
  description: 'Show hardware service profiles and which one resolves for this GPU',
  options: [
    { flag: '--profile <name>', description: 'Resolve as if this tier were selected' },
    { flag: '--json', description: 'Output as JSON for scripting' },
  ],
  action: async () => { /* replaced at registration */ },
}

// `ctx.commandRegistry` is declared in ../lib/command-registry.js — do not redeclare it here.

export interface ProfilesPluginConfig {
  profiles?: ProfileMap
  probe?: GpuProbe
  model?: string
  profile?: string
}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context, config: ProfilesPluginConfig = {}) {
    ctx.commandRegistry!.register({
      ...spec,
      action: async (c: Context, options: Record<string, unknown>) => {
        const report = await resolveForHost(options, config)
        console.log(report.text)
        process.exitCode = report.exitCode
      },
    })
  },
}
