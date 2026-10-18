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

/** Pure: build `ssh user@host "docker compose -f <file> <verb> [-d]"`. */
export function sshComposeArgs(host: HostConfig, verb: 'up' | 'down'): [string, string[]][] {
  const target = `${host.ssh?.user ?? 'ubuntu'}@${host.ssh?.host}`
  const file = stackFile(host)
  const remote = `cd ${file.replace(/\/[^/]+$/, '')} && docker compose -f ${file} ${verb}${verb === 'up' ? ' -d' : ''}`
  return [['ssh', [...(host.ssh?.key_secret ? ['-i', `/run/secrets/${host.ssh.key_secret}`] : []), '-o', 'StrictHostKeyChecking=accept-new', target, remote]]]
}

export class HyperstackDeploymentProvider implements DeploymentProvider {
  readonly kind = 'hyperstack' as const
  constructor(private readonly runner: Runner = defaultRunner) {}

  async up(host: HostConfig, _opts?: UpDownOpts): Promise<void> {
    for (const [cmd, args] of sshComposeArgs(host, 'up')) this.runner.run(cmd, args)
  }
  async down(host: HostConfig, _opts?: UpDownOpts): Promise<void> {
    for (const [cmd, args] of sshComposeArgs(host, 'down')) this.runner.run(cmd, args)
  }
  async status(host: HostConfig): Promise<HostStatus> {
    try {
      const out = this.runner.capture('ssh', ['-o', 'StrictHostKeyChecking=accept-new', `${host.ssh?.user}@${host.ssh?.host}`, `docker compose -f ${stackFile(host)} ps --format '{{.State}}'`])
      return { reachable: true, mode: /Up|running/i.test(out) ? 'awake' : 'down', detail: out.trim() || undefined }
    } catch (e: any) {
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
