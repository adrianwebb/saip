/**
 * Local deployment provider — drives Docker Compose stacks on the machine SAIP
 * runs on. The MVP baseline host kind. All docker interaction goes through an
 * injectable Runner so behavior is unit-testable without invoking docker.
 */

import { execFileSync } from 'node:child_process'
import type { DeploymentProvider, HostConfig, HostStatus, UpDownOpts } from '@saip/shared'

export interface Runner {
  run(cmd: string, args: string[]): string
  capture(cmd: string, args: string[]): string
}

const defaultRunner: Runner = {
  run: (cmd, args) => { execFileSync(cmd, args, { stdio: 'pipe' }); return '' },
  capture: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }),
}

/** Which compose files a verb touches for a host, by role. Returns file paths. */
function stackFiles(host: HostConfig, verb: 'up' | 'down' | 'status'): string[] {
  const dir = host.compose_dir ?? '.'
  const inf = `${dir}/inference/docker-compose.yml`
  const trn = `${dir}/training/docker-compose.yml`
  if (host.role === 'inference') return [inf]
  if (host.role === 'training') return [trn]
  // both: awake(up)=inference only; down=all; status=inference (the serving side)
  if (verb === 'up') return [inf]
  if (verb === 'down') return [trn, inf]
  return [inf]
}

/** Pure: build `docker compose -f <file> <verb> [-d]` arg tuples per stack file. */
export function composeArgs(host: HostConfig, verb: 'up' | 'down' | 'ps'): [string, string[]][] {
  const files = stackFiles(host, verb === 'ps' ? 'status' : verb)
  return files.map((f) => {
    const args = ['compose', '-f', f, verb]
    if (verb === 'up') args.push('-d')
    return ['docker', args] as [string, string[]]
  })
}

export class LocalDeploymentProvider implements DeploymentProvider {
  readonly kind = 'local' as const
  constructor(private readonly runner: Runner = defaultRunner) {}

  async up(host: HostConfig, _opts?: UpDownOpts): Promise<void> {
    for (const [cmd, args] of composeArgs(host, 'up')) this.runner.run(cmd, args)
  }

  async down(host: HostConfig, _opts?: UpDownOpts): Promise<void> {
    for (const [cmd, args] of composeArgs(host, 'down')) this.runner.run(cmd, args)
  }

  async status(host: HostConfig): Promise<HostStatus> {
    try {
      let out = ''
      for (const [cmd, args] of composeArgs(host, 'ps')) out += this.runner.capture(cmd, [...args, '--format', '{{.Name}} {{.State}}'])
      const running = /Up|running/i.test(out)
      return { reachable: true, mode: running ? 'awake' : 'down', detail: out.trim() || undefined }
    } catch (e: any) {
      return { reachable: false, mode: 'down', detail: e?.message }
    }
  }
}
