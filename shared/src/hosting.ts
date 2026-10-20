/**
 * Hosting foundations: host registry types + validation, and the injectable
 * SecretsProvider / DeploymentProvider / MonitoringProvider seams consumed by
 * the CLI and both gateways. Pure types + validators here; Cordis service
 * wrappers live in services.ts so every package shares identical semantics.
 *
 * Security rule enforced by validateHostRegistry: committed config references
 * secrets by NAME only — values resolve at runtime via a SecretsProvider.
 */

export type HostKind = 'local' | 'hyperstack'
export type HostRole = 'inference' | 'training' | 'both'

export interface SshConfig {
  host: string
  user: string
  /** Name of the secret holding the private key — never the key itself. */
  key_secret?: string
}

export interface TofuConfig {
  workspace: string
  vars?: Record<string, string>
}

export interface HostConfig {
  name: string
  kind: HostKind
  role: HostRole
  gpu_node?: string
  compose_dir?: string
  ssh?: SshConfig
  tofu?: TofuConfig
  /** Map of reference-name → SECRET NAME (value resolved from SecretsProvider). */
  secrets?: Record<string, string>
}

export interface HostRegistryFile {
  hosts: HostConfig[]
}

export interface HostValidationError {
  path: string
  code: ValidationCode
  message: string
}

export type ValidationCode =
  | 'duplicate_host'
  | 'invalid_kind'
  | 'missing_role'
  | 'host_unreachable_config'
  | 'role_coverage'
  | 'invalid_secret_ref'

const KINDS: HostKind[] = ['local', 'hyperstack']
const ROLES: HostRole[] = ['inference', 'training', 'both']

/** Validate a host registry. Returns structured errors (empty array = valid). */
export function validateHostRegistry(reg: HostRegistryFile): HostValidationError[] {
  const errors: HostValidationError[] = []
  const hosts = reg?.hosts ?? []
  const seen = new Set<string>()
  let coversInference = false
  let coversTraining = false

  hosts.forEach((h, i) => {
    const p = `hosts[${i}]${h.name ? ` (${h.name})` : ''}`
    if (!h.name) {
      errors.push({ path: p, code: 'missing_role', message: 'host missing name' })
    } else if (seen.has(h.name)) {
      errors.push({ path: `${p}.name`, code: 'duplicate_host', message: `duplicate host name: ${h.name}` })
    } else {
      seen.add(h.name)
    }

    if (!KINDS.includes(h.kind)) {
      errors.push({ path: `${p}.kind`, code: 'invalid_kind', message: `invalid kind: ${h.kind}` })
    }
    if (!ROLES.includes(h.role)) {
      errors.push({ path: `${p}.role`, code: 'missing_role', message: 'role must be inference|training|both' })
    } else {
      if (h.role === 'inference' || h.role === 'both') coversInference = true
      if (h.role === 'training' || h.role === 'both') coversTraining = true
    }

    // A hyperstack host must declare how to reach/drive it.
    if (h.kind === 'hyperstack' && !h.tofu?.workspace && !h.ssh) {
      errors.push({ path: p, code: 'host_unreachable_config', message: 'hyperstack host needs tofu.workspace or ssh' })
    }

    // Secret refs must be non-empty strings (names, not values).
    for (const [refName, secretName] of Object.entries(h.secrets ?? {})) {
      if (typeof secretName !== 'string' || secretName.trim() === '') {
        errors.push({ path: `${p}.secrets.${refName}`, code: 'invalid_secret_ref', message: 'secret ref must name a secret (non-empty)' })
      }
    }
  })

  if (hosts.length && (!coversInference || !coversTraining)) {
    errors.push({
      path: 'hosts',
      code: 'role_coverage',
      message: `registry must cover both inference and training roles (missing: ${[!coversInference && 'inference', !coversTraining && 'training'].filter(Boolean).join(', ')})`,
    })
  }

  return errors
}

// ─── Secrets seam ─────────────────────────────────────────────

export class MissingSecretError extends Error {
  constructor(public readonly name_: string) {
    super(`missing secret: ${name_} (not resolvable from the configured SecretsProvider)`)
    this.name = 'MissingSecretError'
  }
}

export interface SecretsProvider {
  get(name: string): Promise<string | undefined>
  require(name: string): Promise<string>
}

/** Default provider: reads process.env. Swap for Vault/cloud SM behind the same interface. */
export class EnvSecrets implements SecretsProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async get(name: string): Promise<string | undefined> {
    return this.env[name]
  }
  async require(name: string): Promise<string> {
    const v = this.env[name]
    if (v === undefined || v === '') throw new MissingSecretError(name)
    return v
  }
}

// ─── Deployment provider seam ─────────────────────────────────

export interface HostStatus {
  reachable: boolean
  mode?: 'awake' | 'asleep' | 'down' | 'unknown'
  adapters?: string[]
  detail?: string
}

export interface UpDownOpts {
  bucket?: string
  dryRun?: boolean
  /** Force a specific stack for a both-role host (awake=inference, sleep=training). */
  stack?: 'inference' | 'training'
}

export interface DeployResult {
  planned: boolean
  applied: boolean
  detail?: string
}

export interface DeploymentProvider {
  readonly kind: HostKind
  up(host: HostConfig, opts?: UpDownOpts): Promise<void>
  down(host: HostConfig, opts?: UpDownOpts): Promise<void>
  status(host: HostConfig): Promise<HostStatus>
  deploy?(src: HostConfig, dst: HostConfig, params: Record<string, string>): Promise<DeployResult>
}

// ─── Monitoring seam (minimal here; expanded in PR I) ─────────

export interface Metric {
  name: string
  type: 'counter' | 'gauge' | 'histogram'
  value: number
  tags?: Record<string, string>
}
