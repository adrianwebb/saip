/**
 * Service profiles — the hardware contract for a SAIP deployment.
 *
 * A profile declares the minimum card a tier assumes, the ceiling the vLLM process will
 * not exceed, and the engine arguments that follow. This module is pure: no filesystem,
 * no GPU, no Docker. Probing lives behind the `GpuProbe` seam and the Cordis wrapper in
 * `services.ts`, so the CLI, inference gateway, and training gateway resolve identical
 * answers from identical inputs — the same discipline `validateHostRegistry` applies to
 * `hosts.yaml`.
 *
 * Why this exists rather than a config constant: vLLM computes its budget as
 * `ceil(total_memory × gpu_memory_utilization)` and aborts if free memory at launch is
 * below that product. A utilization fraction is therefore meaningless without knowing the
 * card, and on a desktop-shared GPU the *free* figure moves under you. Deriving it is the
 * only way a tier can hold its ceiling.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProfileName = string

/** Storage-dtype names vLLM accepts for `--kv-cache-dtype`. */
export type KvCacheDtype =
  | 'auto'
  | 'float16'
  | 'bfloat16'
  | 'fp8'
  | 'fp8_e4m3'
  | 'fp8_e5m2'
  | 'int8_per_token_head'

export interface EngineArgs {
  max_model_len?: number
  kv_cache_dtype?: KvCacheDtype
  enforce_eager?: boolean
  enable_lora?: boolean
  max_loras?: number
  max_lora_rank?: number
  language_model_only?: boolean
  /**
   * Concurrent decode sequence ceiling. On hybrid gated-deltanet models every sequence
   * reserves one fixed-size Mamba cache block (48 MiB here) regardless of its length, and
   * when CUDA graphs are enabled vLLM refuses to start if the default 256 exceeds the
   * blocks the memory budget can hold:
   *
   *   ValueError: max_num_seqs (256) exceeds available Mamba cache blocks (236)
   *
   * Measured on the 12 GB tier at 65,536-token context. Set below the available blocks so
   * the engine boots; it also caps practical concurrency, which is what costs memory here.
   */
  max_num_seqs?: number
}

export interface TrainingArgs {
  precision?: 'bf16' | 'fp16'
  sequence_len?: number
  gradient_checkpointing?: boolean
  optimizer?: string
}

export interface ServiceProfile {
  description?: string
  /** Total VRAM a card must have to run this tier. */
  min_vram_gib: number
  /** Minimum NVIDIA compute capability, e.g. 7.5 / 8.0 / 8.9. */
  min_capability: number
  /** Hard budget for the vLLM process. Never a constant across cards — see below. */
  vram_ceiling_gib: number
  engine: EngineArgs
  training?: TrainingArgs
}

export type ProfileMap = Record<ProfileName, ServiceProfile>

export interface GpuInfo {
  name: string
  total_gib: number
  free_gib: number
  /** Compute capability as a decimal, e.g. 8.6 for an RTX 3080 Laptop. */
  capability: number
}

export type ProfileErrorCode =
  | 'no_profiles'
  | 'missing_tier_field'
  | 'invalid_ceiling'
  | 'ceiling_exceeds_tier'
  | 'invalid_max_model_len'
  | 'invalid_max_num_seqs'
  | 'training_capability_unsupported'
  | 'unknown_profile'
  | 'insufficient_vram'
  | 'insufficient_capability'
  | 'no_satisfiable_profile'
  | 'insufficient_free_vram'
  | 'forbidden_kv_cache_dtype'

export interface ProfileValidationError {
  path: string
  code: ProfileErrorCode
  message: string
}

// ─── GPU probe seam ─────────────────────────────────────────────────────────

/**
 * Reads the device facts a profile needs. An interface so every package can resolve
 * profiles deterministically in tests and against real silicon in production — the same
 * seam discipline as `StorageProvider` and `VllmBackend`.
 */
export interface GpuProbe {
  probe(): Promise<GpuInfo>
}

/** Deterministic stand-in for CI and unit tests. No GPU required. */
export class FakeGpuProbe implements GpuProbe {
  constructor(private readonly info: GpuInfo) {}
  async probe(): Promise<GpuInfo> {
    return this.info
  }
}

/**
 * Real probe backed by `nvidia-smi`.
 *
 * Compute capability is read from the CSV `compute_cap` field rather than derived from the
 * device name, because the name lies: this class was built against a card reporting
 * "NVIDIA GeForce RTX 3080 Laptop GPU" whose lspci string reads "8GB/16GB" — and the only
 * way to know which one you have is to ask.
 *
 * Memory here is what the driver reports (16384 MiB on that card = 16.0 GiB), which is a
 * few percent above what CUDA itself hands out (torch reports 15.58 GiB usable). The
 * ceiling arithmetic runs against the driver figure and the headroom term absorbs the
 * difference; a card that cannot actually hold the ceiling fails the free-memory gate.
 */
export class NvidiaSmiProbe implements GpuProbe {
  constructor(private readonly exec: (cmd: string, args: string[]) => Promise<string> = defaultExec) {}

  async probe(): Promise<GpuInfo> {
    let out: string
    try {
      // `-i` selects the device. There is no `--idx` option; passing one makes nvidia-smi
      // exit non-zero with "Option --idx=0 is not recognized".
      out = await this.exec('nvidia-smi', [
        '--query-gpu=name,memory.total,memory.free,compute_cap',
        '--format=csv,noheader,nounits',
        '-i',
        '0',
      ])
    } catch (err) {
      throw new GpuProbeError(
        `nvidia-smi failed — is an NVIDIA driver and the GPU visible to this process? ` +
        `(${(err as Error).message.split('\n')[0]})`,
      )
    }
    const [name, totalMiB, freeMiB, cap] = out.trim().split(',').map((s) => s.trim())
    const gib = (miB: number) => Number((miB / 1024).toFixed(2))
    const total = Number.parseFloat(totalMiB)
    const capability = Number.parseFloat(cap)
    if (!Number.isFinite(total) || !Number.isFinite(capability)) {
      throw new GpuProbeError(`could not parse nvidia-smi output: ${JSON.stringify(out.trim().slice(0, 120))}`)
    }
    return {
      name: name ?? 'unknown GPU',
      total_gib: gib(total),
      free_gib: gib(Number.parseFloat(freeMiB)),
      capability,
    }
  }
}

/** The GPU could not be read at all — distinct from "read it, and it is too small". */
export class GpuProbeError extends Error {
  readonly code = 'gpu_unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'GpuProbeError'
  }
}

async function defaultExec(cmd: string, args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  return promisify(execFile)(cmd, args).then(({ stdout }) => stdout)
}

// ─── Capability floors ──────────────────────────────────────────────────────

/**
 * Native FP8 (`fp8e4nv`) requires SM89+; below that vLLM's Triton attention backend
 * raises. `int8_per_token_head` is the dangerous case: on SM80/86 it passes validation,
 * logs a success message, reports a LARGER cache, and then produces corrupted output with
 * no error — the same failure family as the known e5m2-on-Triton mis-storage bug. Measured
 * directly on an RTX 3080 Laptop (see docs/reference/hardware-profiles.mdx).
 */
export const KV_CACHE_MIN_CAPABILITY: Record<string, number> = {
  bfloat16: 8.0,
  fp8: 8.9,
  fp8_e4m3: 8.9,
  fp8_e5m2: 8.9,
  int8_per_token_head: 8.9,
}

export interface KvCacheConstraint {
  allowed: boolean
  dtype: string
  capability: number
  /** Human-readable refusal, naming the 8.9 floor. Undefined when allowed. */
  reason?: string
}

/** Can this card safely store its KV cache in `dtype`? */
export function kvCacheConstraint(dtype: string, capability: number): KvCacheConstraint {
  const base = { dtype, capability }
  // Anything not listed (auto, float16) is safe everywhere vLLM runs.
  const floor = KV_CACHE_MIN_CAPABILITY[dtype]
  if (floor === undefined) return { ...base, allowed: true }
  if (capability >= floor) return { ...base, allowed: true }
  return {
    ...base,
    allowed: false,
    reason:
      `kv_cache_dtype "${dtype}" requires compute capability ${floor}+; this card reports ` +
      `${capability}. Below ${floor} the flag is accepted by vLLM but produces corrupted ` +
      `output with no error. Use "auto" (16-bit) instead.`,
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Validate a profile map. Returns structured errors; empty array means valid. */
export function validateProfiles(profiles: ProfileMap): ProfileValidationError[] {
  const errors: ProfileValidationError[] = []
  const names = Object.keys(profiles ?? {})
  if (names.length === 0) {
    return [{ path: 'profiles', code: 'no_profiles', message: 'no service profiles declared' }]
  }

  for (const name of names) {
    const p = `profiles.${name}`
    const prof = profiles[name]
    if (!prof || typeof prof !== 'object') {
      errors.push({ path: p, code: 'missing_tier_field', message: 'profile is not an object' })
      continue
    }
    for (const field of ['min_vram_gib', 'min_capability', 'vram_ceiling_gib'] as const) {
      if (typeof prof[field] !== 'number') {
        errors.push({ path: `${p}.${field}`, code: 'missing_tier_field', message: `${field} is required and must be a number` })
      }
    }
    if (!prof.engine || typeof prof.engine !== 'object') {
      errors.push({ path: `${p}.engine`, code: 'missing_tier_field', message: 'engine args are required' })
    }

    const ceiling = prof.vram_ceiling_gib
    if (typeof ceiling === 'number' && !(ceiling > 0)) {
      errors.push({ path: `${p}.vram_ceiling_gib`, code: 'invalid_ceiling', message: 'ceiling must be greater than zero' })
    }
    // A ceiling above the tier's own minimum VRAM can never be honored on a card that
    // merely meets the minimum — the tier would be self-contradictory.
    if (typeof ceiling === 'number' && typeof prof.min_vram_gib === 'number' && ceiling > prof.min_vram_gib) {
      errors.push({
        path: `${p}.vram_ceiling_gib`,
        code: 'ceiling_exceeds_tier',
        message: `ceiling ${ceiling} GiB exceeds the tier minimum of ${prof.min_vram_gib} GiB — a card meeting only the minimum can never satisfy it`,
      })
    }

    const mml = prof.engine?.max_model_len
    if (mml !== undefined && (!Number.isInteger(mml) || mml < 1024)) {
      errors.push({ path: `${p}.engine.max_model_len`, code: 'invalid_max_model_len', message: `max_model_len must be an integer >= 1024 (got ${mml})` })
    }

    const mns = prof.engine?.max_num_seqs
    if (mns !== undefined && (!Number.isInteger(mns) || mns < 1)) {
      errors.push({ path: `${p}.engine.max_num_seqs`, code: 'invalid_max_num_seqs', message: `max_num_seqs must be a positive integer (got ${mns})` })
    }

    // bf16 training requires Ampere (compute capability 8.0); transformers refuses below it.
    if (prof.training?.precision === 'bf16' && typeof prof.min_capability === 'number' && prof.min_capability < 8.0) {
      errors.push({
        path: `${p}.training.precision`,
        code: 'training_capability_unsupported',
        message: `bf16 training requires compute capability >= 8.0, but the tier allows ${prof.min_capability}`,
      })
    }
  }
  return errors
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export type ProfileResolution =
  | { ok: true; profile: ProfileName; args: ServiceProfile; gpu: GpuInfo; auto: boolean }
  | { ok: false; error: { code: ProfileErrorCode; message: string } }

/**
 * Choose the profile for this card.
 *
 * An explicit selection is honored, but never overruled into an OOM: if the card cannot
 * satisfy it, resolution fails naming the deficit. With no selection, the highest tier the
 * card satisfies wins; if none fits, this fails closed rather than letting the engine die
 * minutes later.
 */
export function resolveProfile(
  profiles: ProfileMap,
  requested: ProfileName | undefined,
  gpu: GpuInfo,
): ProfileResolution {
  const names = Object.keys(profiles ?? {})
  const fail = (code: ProfileErrorCode, message: string): ProfileResolution => ({ ok: false, error: { code, message } })

  if (requested !== undefined && requested !== '') {
    const args = profiles[requested]
    if (!args) {
      return fail('unknown_profile', `profile "${requested}" is not declared (known: ${names.join(', ') || 'none'})`)
    }
    if (gpu.total_gib < args.min_vram_gib) {
      return fail('insufficient_vram', `profile "${requested}" needs ${args.min_vram_gib} GiB VRAM; this card has ${gpu.total_gib} GiB total`)
    }
    if (gpu.capability < args.min_capability) {
      return fail('insufficient_capability', `profile "${requested}" needs compute capability ${args.min_capability}; this card reports ${gpu.capability}`)
    }
    return { ok: true, profile: requested, args, gpu, auto: false }
  }

  // Auto: highest minimum-VRAM tier the card satisfies. Ties break by capability floor.
  const candidates = names
    .map((name) => ({ name, args: profiles[name] }))
    .filter(({ args }) => gpu.total_gib >= args.min_vram_gib && gpu.capability >= args.min_capability)
    .sort((a, b) => b.args.min_vram_gib - a.args.min_vram_gib || b.args.min_capability - a.args.min_capability)

  const pick = candidates[0]
  if (!pick) {
    const need = names.map((n) => `${n}(>=${profiles[n].min_vram_gib} GiB, cc ${profiles[n].min_capability})`).join(', ')
    return fail('no_satisfiable_profile', `no service profile fits: card is ${gpu.total_gib} GiB / compute capability ${gpu.capability}; declared tiers are ${need}`)
  }
  return { ok: true, profile: pick.name, args: pick.args, gpu, auto: true }
}

/**
 * Slack left for the compositor/browser on a shared GPU. vLLM's budget is checked against
 * *free* memory at launch, and a desktop session comfortably sits in this band — measured
 * at ~2.2 GiB on a GNOME laptop with a browser open, so this is a floor, not the typical
 * figure; the free-memory check below is what actually protects us.
 */
export const SHARED_GPU_HEADROOM_GIB = 0.5

export type UtilizationResult =
  | { ok: true; utilization: number; budget_gib: number }
  | { ok: false; error: { code: ProfileErrorCode; message: string } }

/**
 * Derive `--gpu-memory-utilization` from a profile ceiling and the observed card.
 *
 * vLLM: `requested = ceil(total × util)` and aborts when `free < requested`. So the
 * fraction is `ceiling / total` — and it is only startable when free memory covers the
 * ceiling plus headroom.
 */
export function deriveGpuMemoryUtilization(
  ceiling_gib: number,
  total_gib: number,
  free_gib: number,
  headroom_gib: number = SHARED_GPU_HEADROOM_GIB,
): UtilizationResult {
  if (!(total_gib > 0)) {
    return { ok: false, error: { code: 'insufficient_free_vram', message: 'total GPU memory could not be determined' } }
  }
  const available = free_gib - headroom_gib
  if (available < ceiling_gib) {
    return {
      ok: false,
      error: {
        code: 'insufficient_free_vram',
        message:
          `profile ceiling is ${ceiling_gib} GiB but only ${free_gib} GiB is free ` +
          `(needs ${ceiling_gib} GiB + ${headroom_gib} GiB headroom on a ${total_gib} GiB card). ` +
          `Close other GPU users, or select a smaller profile.`,
      },
    }
  }
  return { ok: true, utilization: Math.min(1, Number((ceiling_gib / total_gib).toFixed(4))), budget_gib: ceiling_gib }
}

// ─── Argv rendering ─────────────────────────────────────────────────────────

export interface RenderOptions {
  model: string
  /** Aliases served by ONE variadic flag. Order is preserved. */
  servedNames: string[]
  utilization: number
  capability: number
  host?: string
  port?: number
}

/**
 * Render the vLLM argv for a profile.
 *
 * Throws on a KV-cache dtype this card cannot use: rendering it would boot a server that
 * answers requests with garbage, which is worse than not booting.
 */
export function renderVllmArgs(profile: ServiceProfile, opts: RenderOptions): string[] {
  const e = profile.engine ?? {}
  const dtype = e.kv_cache_dtype ?? 'auto'
  const constraint = kvCacheConstraint(dtype, opts.capability)
  if (!constraint.allowed) throw new Error(constraint.reason)

  const argv: string[] = ['--model', opts.model]

  // Variadic, NOT append: repeating the flag keeps only the last alias, and a
  // comma-joined value yields one alias literally named "a,b" — both make the rest 404.
  if (opts.servedNames.length) argv.push('--served-model-name', ...opts.servedNames)

  if (e.max_model_len !== undefined) argv.push('--max-model-len', String(e.max_model_len))
  // "auto" is vLLM's own default; saying nothing keeps the flag surface honest.
  if (dtype !== 'auto') argv.push('--kv-cache-dtype', dtype)
  argv.push('--gpu-memory-utilization', opts.utilization.toFixed(4))
  if (e.language_model_only) argv.push('--language-model-only')
  if (e.max_num_seqs !== undefined) argv.push('--max-num-seqs', String(e.max_num_seqs))
  if (e.enforce_eager) argv.push('--enforce-eager')
  if (e.enable_lora) {
    argv.push('--enable-lora')
    if (e.max_loras !== undefined) argv.push('--max-loras', String(e.max_loras))
    if (e.max_lora_rank !== undefined) argv.push('--max-lora-rank', String(e.max_lora_rank))
  }
  argv.push('--host', opts.host ?? '0.0.0.0', '--port', String(opts.port ?? 8000))
  return argv
}
