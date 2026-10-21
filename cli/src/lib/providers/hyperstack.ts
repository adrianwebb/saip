/**
 * Hyperstack deployment provider (gated). Drives Docker Compose over SSH for
 * up/down/status on a remote GPU VM, and provisions the 2-GPU environment via
 * OpenTofu — but ONLY when explicitly opted in with SAIP_ALLOW_INFRA=true,
 * because the NexGenCloud/hyperstack Terraform provider is alpha and applying
 * creates billable resources. All external commands go through an injectable
 * runner so this is unit-testable without ssh/tofu/docker.
 */

import { execFileSync } from 'node:child_process'
import type { DeploymentProvider, HostConfig, HostStatus, UpDownOpts, DeployResult } from '@saip/shared'

export interface Runner {
  run(cmd: string, args: string[]): string
  capture(cmd: string, args: string[]): string
}

const defaultRunner: Runner = {
  run: (cmd, args) => { execFileSync(cmd, args, { stdio: 'pipe' }); return '' },
  capture: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }),
}

export class InfraNotAuthorizedError extends Error {
  constructor() {
    super('refusing to run infrastructure provisioning: set SAIP_ALLOW_INFRA=true to opt in (the Hyperstack Terraform provider is alpha and apply creates billable resources)')
    this.name = 'InfraNotAuthorizedError'
  }
}

function stackFile(host: HostConfig): string {
  const dir = '/opt/saip' // repo layout on the remote host
  const stack = host.role === 'training' ? 'training' : 'inference'
  return `${dir}/${stack}/docker-compose.yml`
}

/**
 * Pure: build `ssh user@host "docker compose -f <file> <verb> [-d]"`.
 *
 * `identityPath` is a real file, materialised by the caller (#89). The previous version built
 * `-i /run/secrets/<key_secret>` from the secret's NAME — a path nothing ever created — so remote
 * SSH could not authenticate no matter what the user stored (#83). There is no fallback to that
 * shape: if a host declares a key and the caller supplies no identity, that is a wiring bug and it
 * fails loudly rather than starting an ssh that will be rejected.
 */
export function sshComposeArgs(host: HostConfig, verb: 'up' | 'down', identityPath?: string): [string, string[]][] {
  const target = `${host.ssh?.user ?? 'ubuntu'}@${host.ssh?.host}`
  const file = stackFile(host)
  const remote = `cd ${file.replace(/\/[^/]+$/, '')} && docker compose -f ${file} ${verb}${verb === 'up' ? ' -d' : ''}`
  // Every call here is an ssh to a remote host, so an identity is always required. Not passing
  // one is the silent-auth-failure shape #83 shipped with; it is now a named error instead.
  if (!identityPath) throw new SshIdentityMissingError(host.name)
  const identity = ['-i', identityPath]
  return [['ssh', [...identity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', target, remote]]]
}

/** Thrown when a remote command is attempted without a resolved SSH identity. */
export class SshIdentityMissingError extends Error {
  readonly name = 'SshIdentityMissingError'
  constructor(host: string) {
    super(`no SSH identity resolved for host "${host}". Create one with: saip ssh generate --host ${host}`)
  }
}

/**
 * Runs `fn` with a usable identity file, and removes it afterwards.
 *
 * Shaped as a scope function rather than `host => path` deliberately: a resolver that hands back a
 * path has no way to promise its cleanup, so the private key file would outlive the command — the
 * exact risk that makes this whole feature dangerous. The caller owns the file's lifetime.
 */
export type SshIdentityScope = <T>(host: HostConfig, fn: (path: string) => Promise<T>) => Promise<T>

export class HyperstackDeploymentProvider implements DeploymentProvider {
  readonly kind = 'hyperstack' as const
  constructor(private readonly runner: Runner = defaultRunner, private readonly withKey?: SshIdentityScope) {}

  private async withIdentity<T>(host: HostConfig, fn: (path: string) => Promise<T>): Promise<T> {
    // Without a scope function there is no way to guarantee cleanup, so the command is refused
    // rather than run keyless or with a file nobody promised to delete.
    if (!this.withKey) throw new SshIdentityMissingError(host.name)
    return this.withKey(host, fn)
  }

  async up(host: HostConfig, _opts?: UpDownOpts): Promise<void> {
    await this.withIdentity(host, async (identity) => {
      for (const [cmd, args] of sshComposeArgs(host, 'up', identity)) this.runner.run(cmd, args)
    })
  }
  async down(host: HostConfig, _opts?: UpDownOpts): Promise<void> {
    await this.withIdentity(host, async (identity) => {
      for (const [cmd, args] of sshComposeArgs(host, 'down', identity)) this.runner.run(cmd, args)
    })
  }
  async status(host: HostConfig): Promise<HostStatus> {
    // Same identity path as up/down. Before this, status did its own keyless ssh and reported a
    // perfectly healthy host as `down` — a failed authentication dressed up as a state.
    try {
      return await this.withIdentity(host, async (identity) => {
        const out = this.runner.capture('ssh', ['-i', identity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
          `${host.ssh?.user ?? 'ubuntu'}@${host.ssh?.host}`, `docker compose -f ${stackFile(host)} ps --format '{{.State}}'`])
        return { reachable: true, mode: /Up|running/i.test(out) ? 'awake' : 'down', detail: out.trim() || undefined }
      })
    } catch (e: any) {
      // An unresolvable identity is not "the host is down"; saying so is the difference between a
      // user running `saip ssh generate` and a user debugging a network that is fine.
      if (e?.name === 'SshIdentityMissingError') return { reachable: false, mode: 'unknown', detail: e.message }
      return { reachable: false, mode: 'down', detail: e?.message }
    }
  }

  /** Provision/refresh infra via OpenTofu — gated behind SAIP_ALLOW_INFRA. */
  async deploy(_src: HostConfig, dst: HostConfig, params: Record<string, string>): Promise<DeployResult> {
    if (process.env.SAIP_ALLOW_INFRA !== 'true') throw new InfraNotAuthorizedError()
    const ws = dst.tofu?.workspace ?? 'infra/tofu/hyperstack'
    const varArgs = Object.entries(params).flatMap(([k, v]) => ['-var', `${k}=${v}`])
    this.runner.run('tofu', ['-chdir=' + ws, 'init'])
    this.runner.run('tofu', ['-chdir=' + ws, 'apply', '-auto-approve', ...varArgs])
    return { planned: true, applied: true, detail: `tofu apply in ${ws}` }
  }
}
