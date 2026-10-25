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
import { existsSync } from 'node:fs'
import { loadYamlConfig, resolveConfigFile } from '@saip/shared'
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
import { uiOr } from '../ui/output.js'
import { blankBlock, columnsBlock, kvBlock, lineBlock, noteBlock, type Block, type KvRow } from '../ui/blocks.js'

export interface TierRow {
  name: string
  fits: boolean
  /** Why it does not fit, when it does not. */
  why?: string
  /**
   * The declared numbers, as data. The table used to be padded into a string here, which meant the
   * only way to render it at all was to reproduce that padding — so `--json` had nothing to emit and
   * the command became its own renderer (#156).
   */
  min_vram_gib: number
  min_capability: number
  vram_ceiling_gib: number
}

/**
 * What the resolver returns: facts, no sentences (#156).
 *
 * `profileReport` used to end in a `text` field holding the finished transcript — `[saip] ` prefixes,
 * aligned columns, a joined engine-argument string — and `profiles` printed it with `console.log` while
 * `--json` re-parsed that same field. That is why this command was the one whose machine output had no
 * `kind`: the presentation was built before anyone knew whether a human, a log or an agent was reading.
 * Presentation is `profileBlocks`' job now, and `ctx.ui` decides how those blocks look.
 */
export interface ProfileReport {
  /** 0 resolved · 1 configuration error · 2 no profile fits / GPU unreadable */
  exitCode: number
  /** Named failure. `status` pattern-matched the old prose for this; it reads the field now. */
  error?: { code: string; message: string }
  /** Every declaration error, when the `profiles:` block itself is invalid. */
  validation?: { code: string; path: string; message: string }[]
  gpu?: GpuInfo
  tiers: TierRow[]
  resolution?: ProfileResolution
  utilization?: UtilizationResult
  /** argv, not a joined command line: joining is a presentation decision and belongs to the renderer. */
  engineArgs?: string[]
}

export interface ReportInput {
  profiles: ProfileMap
  probe: GpuProbe
  /** Treat this tier as explicitly selected, the way `--profile` does. */
  require?: string
  model?: string
}

function tierRows(profiles: ProfileMap, gpu: GpuInfo): TierRow[] {
  return Object.entries(profiles).map(([name, p]) => {
    const reasons: string[] = []
    if (gpu.total_gib < p.min_vram_gib) reasons.push(`needs ${p.min_vram_gib} GiB VRAM, card has ${gpu.total_gib} GiB`)
    if (gpu.capability < p.min_capability) reasons.push(`needs compute capability ${p.min_capability}, card has ${gpu.capability}`)
    return {
      name, fits: reasons.length === 0, why: reasons.length ? reasons.join('; ') : undefined,
      min_vram_gib: p.min_vram_gib, min_capability: p.min_capability, vram_ceiling_gib: p.vram_ceiling_gib,
    }
  })
}

/** Probe and resolve. Never throws: every failure becomes a report + exit code. */
export async function profileReport(input: ReportInput): Promise<ProfileReport> {
  const { profiles, probe, require: requested, model } = input

  // Validate here too rather than trusting the caller: this is the exported primitive, and
  // an unusable tier declaration should read as a configuration error, not a crash.
  const errors = validateProfiles(profiles)
  if (errors.length) {
    const first = errors[0]
    return {
      exitCode: 1,
      // The whole list is carried, not just the first: a renderer must be able to show all of them and
      // an agent must be able to count them. `text` used to be the only place they appeared.
      error: {
        code: first.code,
        message: errors.length === 1
          ? `${first.path}: ${first.message}`
          : `${first.path}: ${first.message} (+${errors.length - 1} more)`,
      },
      validation: errors.map((e) => ({ code: e.code, path: e.path, message: e.message })),
      tiers: [],
    }
  }

  let gpu: GpuInfo
  try {
    gpu = await probe.probe()
  } catch (err) {
    return { exitCode: 2, error: { code: 'gpu_unavailable', message: (err as Error).message }, tiers: [] }
  }

  const tiers = tierRows(profiles, gpu)
  const fail = (code: string, message: string): ProfileReport => ({ exitCode: 2, error: { code, message }, tiers, gpu })

  const resolution = resolveProfile(profiles, requested, gpu)
  if (!resolution.ok) return fail(resolution.error.code, resolution.error.message)

  const args = resolution.args
  const constraint = kvCacheConstraint(args.engine?.kv_cache_dtype ?? 'auto', gpu.capability)
  if (!constraint.allowed) return fail('forbidden_kv_cache_dtype', constraint.reason ?? '')

  const util = deriveGpuMemoryUtilization(args.vram_ceiling_gib, gpu.total_gib, gpu.free_gib)
  if (!util.ok) return fail(util.error.code, util.error.message)

  let engineArgs: string[] | undefined
  if (model) {
    try {
      engineArgs = renderVllmArgs(args, {
        model,
        servedNames: ['saip-instruct', 'saip-systemone'],
        utilization: util.utilization,
        capability: gpu.capability,
      })
    } catch (err) {
      return fail('forbidden_kv_cache_dtype', (err as Error).message)
    }
  }

  return { exitCode: 0, gpu, tiers, resolution, utilization: util, engineArgs }
}

/**
 * The command's presentation, as data the seam can render (#156).
 *
 * Exported separately from the report so the *facts* stay renderable by anything — `awake` prints two
 * lines of them, `status` folds them into a key/value row, an agent reads JSONL — and none of them has
 * to re-parse a sentence to get a number back.
 */
export function profileBlocks(report: ProfileReport): Block[] {
  const blocks: Block[] = []
  const gpu = report.gpu
  const rows: KvRow[] = []
  if (gpu) {
    rows.push({ label: 'GPU', value: `${gpu.name} — ${gpu.total_gib} GiB total, ${gpu.free_gib} GiB free, cc ${gpu.capability}` })
  }
  if (report.tiers.length) {
    // The `fits` column is yes/no ONLY, and the reasons go underneath as their own lines. A cell
    // carrying `no — needs 12 GiB VRAM, card has 6 GiB; needs compute capability 8…` is 70+ characters
    // wide, and a right-aligned column that wide puts a canyon between every header and its value —
    // visible in the real bytes the first time this table was rendered by the seam. The old
    // hand-built string had the same shape and nobody saw it, because the tiers always fitted on the
    // machine it was written on.
    blocks.push(columnsBlock(
      ['profile', 'min VRAM', 'min cc', 'ceiling', 'fits'],
      report.tiers.map((t) => [t.name, `${t.min_vram_gib} GiB`, String(t.min_capability), `${t.vram_ceiling_gib} GiB`, t.fits ? 'yes' : 'no']),
    ))
    for (const t of report.tiers) {
      if (!t.fits && t.why) blocks.push(noteBlock(`${t.name}: ${t.why}`))
    }
  }
  if (report.exitCode !== 0) {
    const err = report.error
    // Every validation error, not just the one the message string happens to mention: `invalid
    // profiles:` used to interpolate a counted list into prose, which a machine reader could not use.
    for (const v of report.validation ?? []) {
      blocks.push(lineBlock(`${v.code} @ ${v.path}: ${v.message}`, 'error'))
    }
    blocks.push(lineBlock(err ? `${err.code}: ${err.message}` : 'no profile resolved', 'error'))
    return blocks
  }

  const resolution = report.resolution
  const util = report.utilization
  if (resolution?.ok) {
    const ceiling = resolution.args.vram_ceiling_gib
    rows.push({
      label: 'Profile',
      value: `${resolution.profile} (${resolution.auto ? 'auto' : 'explicit'})`,
      hint: `ceiling ${ceiling} GiB`,
    })
    if (util?.ok && gpu) {
      rows.push({
        label: 'Utilization',
        value: String(util.utilization),
        hint: `--gpu-memory-utilization, from ${ceiling} GiB ceiling / ${gpu.total_gib} GiB total`,
      })
    }
    if (report.engineArgs?.length) {
      rows.push({ label: 'Engine', value: report.engineArgs.join(' ') })
    }
  }
  if (rows.length) {
    if (blocks.length) blocks.push(blankBlock())   // the table and the facts are different answers; they read as one block without this
    blocks.push(kvBlock(rows))
  }
  return blocks
}

/**
 * Read the profiles block out of saip.yaml through the shared loader. Interpolation failures
 * surface as the report's own configuration error (exit 1) rather than a stack trace, so a
 * missing variable names itself instead of looking like a broken profile.
 */
export function loadProfiles(path?: string): { profiles?: ProfileMap; profile?: string; model?: string; error?: string; loadedFrom?: string } {
  // Explicit path wins; otherwise search upward from cwd so an installed CLI works from any
  // directory. loadedFrom is reported so a global install cannot silently read another
  // project's configuration.
  const resolved = resolveConfigFile('saip.yaml', { explicit: path, envVar: 'SAIP_CONFIG' })
  if (resolved.error) return { error: resolved.error }
  const at = resolved.path
  if (!at || !existsSync(at)) return { error: 'no saip.yaml found (set SAIP_CONFIG or run from a project directory)' }
  path = at
  try {
    const doc: any = loadYamlConfig(path!)
    return { profiles: doc.profiles, profile: doc.profile, model: doc.model?.base, loadedFrom: path }
  } catch (err) {
    return { error: `cannot load ${path}: ${(err as Error).message}` }
  }
}

/** Shared by the command and `awake`, so both describe the same resolution. */
export async function resolveForHost(options: Record<string, unknown> = {}, deps: { profiles?: ProfileMap; probe?: GpuProbe; model?: string; profile?: string } = {}): Promise<ProfileReport> {
  let profiles = deps.profiles
  let model = deps.model
  let requested = (options.profile as string | undefined) ?? deps.profile
  // Config-level refusals are named the same way a resolution failure is: a code and a message. The
  // old shape was a `[saip] `-prefixed sentence, which is why `status` had to regex-match it (#156).
  const refuse = (code: string, message: string): ProfileReport => ({ exitCode: 1, error: { code, message }, tiers: [] })
  if (!profiles) {
    const loaded = loadProfiles()
    if (loaded.error) return refuse('config_unreadable', loaded.error)
    profiles = loaded.profiles
    model ??= loaded.model
    requested ??= loaded.profile
    if (!profiles || !Object.keys(profiles).length) {
      return refuse('no_profiles_block', 'no `profiles:` block in saip.yaml — declare at least one tier')
    }
  }
  const errors = validateProfiles(profiles)
  if (errors.length) {
    return {
      exitCode: 1,
      error: { code: errors[0].code, message: `${errors[0].path}: ${errors[0].message}` },
      validation: errors.map((e) => ({ code: e.code, path: e.path, message: e.message })),
      tiers: [],
    }
  }
  return profileReport({ profiles, probe: deps.probe ?? new NvidiaSmiProbe(), require: requested, model })
}

const spec: CommandSpec = {
  name: 'profiles',
  description: 'Show hardware service profiles and which one resolves for this GPU',
  options: [
    { flag: '--profile <name>', description: 'Resolve as if this tier were selected' },
    // No `--json` entry here: the dispatcher declares it for every command, and the seam activates the
    // JSONL renderer. A command declaring its own copy is how the machine flag ended up pointing at
    // hand-built prose (#156).
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
        // Which file produced this answer. With a globally installed CLI and several
        // checkouts on one machine, a silent wrong-config read is the dangerous case.
        if (!config.profiles) {
          const from = resolveConfigFile('saip.yaml', { envVar: 'SAIP_CONFIG' }).path
          // Provenance is diagnostics, not payload. The shipped defect: this line landed on stdout
          // immediately before the JSON body of `profiles --json`, making the stream unparseable while
          // the JSON itself was fine (#113). stderr in both modes.
          if (from) console.error(`[saip] config: ${from}`)
        }
        // One content path for human, log and machine (#156): the blocks are built once and `ctx.ui`
        // renders them — an Ink frame on a terminal, plain labelled lines in a pipe, JSONL records when
        // the dispatcher has already activated the `jsonl` renderer for `--json`. Piped output is free of
        // box-drawing because the RENDERER chose that, which is the property #110 could not previously
        // claim for this command.
        uiOr(c).showAll(profileBlocks(report))
        process.exitCode = report.exitCode
      },
    })
  },
}
