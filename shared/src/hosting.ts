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
  /**
   * TCP port, 1–65535; omitted means 22, and the omission is deliberate so `sshConnectionArgs()` adds
   * no `-p` rather than pinning a value that overrides an ssh config `Port` the user set elsewhere.
   *
   * It is a FIELD and not a `host:port` string because ssh's colon syntax means different things in
   * option position than in `scp`/`rsync` destination position, and #98 was exactly the cost of each
   * call site splitting a string its own way: the port parsed, validated, and vanished.
   */
  port?: number
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
  | 'invalid_ssh_port'
  | 'unknown_host_key'
  | 'unknown_ssh_key'

/** Keys `HostConfig` has a field for. Anything else in a host entry is refused (#98). */
const HOST_KEYS = ['name', 'kind', 'role', 'gpu_node', 'compose_dir', 'ssh', 'tofu', 'secrets']
const SSH_KEYS = ['host', 'user', 'key_secret', 'port']

/**
 * The argv every SAIP→host connection shares (#98).
 *
 * There were three ssh call sites — `sshComposeArgs`, the hyperstack `status()` probe, and
 * `saip ssh verify` — each assembling `-i … -o BatchMode=yes …` by hand, which is why a port field
 * added to the type would have reached one of them and not the others. One builder, three callers:
 * `extra` is for the site-specific options (verify's `ConnectTimeout`), and the destination and the
 * remote command stay with the caller, because their position relative to the options differs.
 */
export function sshConnectionArgs(host: HostConfig, identityPath: string, extra: readonly string[] = []): string[] {
  const args = ['-i', identityPath]
  const port = host.ssh?.port
  if (port !== undefined) args.push('-p', String(port))
  return [...args, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', ...extra]
}

/** `user@host` for the connection. The port never goes here — that is `-p`'s job. */
export function sshDestination(host: HostConfig): string {
  return `${host.ssh?.user ?? 'ubuntu'}@${host.ssh?.host}`
}

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

    // Unknown keys are refused, not ignored (#98). `ssh: { …, port: 2222 }` used to parse, validate,
    // and drop the port on the floor; the user then saw `connection refused` on a port they never
    // wrote down. "Accepted but ignored" is the general failure mode, so a key with no field behind it
    // is an error naming the key and the allowed set.
    const unknownHost = Object.keys(h).filter((k) => !HOST_KEYS.includes(k))
    for (const k of unknownHost) {
      errors.push({ path: `${p}.${k}`, code: 'unknown_host_key', message: `unknown key "${k}" for a host entry (allowed: ${HOST_KEYS.join(', ')})` })
    }
    if (h.ssh) {
      const sshPath = `${p}.ssh`
      const unknownSsh = Object.keys(h.ssh).filter((k) => !SSH_KEYS.includes(k))
      for (const k of unknownSsh) {
        errors.push({ path: `${sshPath}.${k}`, code: 'unknown_ssh_key', message: `unknown key "${k}" under ssh: (allowed: ${SSH_KEYS.join(', ')})` })
      }
      const port = h.ssh.port
      if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
        errors.push({
          path: `${sshPath}.port`, code: 'invalid_ssh_port',
          message: `ssh.port must be an integer 1-65535, got ${JSON.stringify(port)}`,
        })
      }
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
  /**
   * How long the stack has been running, as the host's own runtime reports it — e.g. `9 hours`.
   *
   * Optional by contract, not by laziness: a host that is not awake has no uptime, and a provider
   * that cannot see one must leave this undefined so the CLI can say *why* rather than invent a
   * value. `saip status` renders the absence in words (#114) — the placeholder this replaced was a
   * bare `TODO`, which read as a measurement of zero.
   */
  uptime?: string
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
