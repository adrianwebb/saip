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
  run: (cmd, args) => { if (process.env.SAIP_DRY_RUN === '1') { console.log(`[dry-run] ${cmd} ${args.join(' ')}`); return '' } execFileSync(cmd, args, { stdio: 'pipe' }); return '' },
  capture: (cmd, args) => { if (process.env.SAIP_DRY_RUN === '1') return ''; return execFileSync(cmd, args, { encoding: 'utf8' }) },
}

/** Which compose files a verb touches for a host, by role. Returns file paths. */
function stackFiles(host: HostConfig, verb: 'up' | 'down' | 'status', stack?: 'inference' | 'training'): string[] {
  const dir = host.compose_dir ?? '.'
  const inf = `${dir}/inference/docker-compose.yml`
  const trn = `${dir}/training/docker-compose.yml`
  if (host.role === 'inference') return [inf]
  if (host.role === 'training') return [trn]
  // both: explicit stack wins; else awake(up)=inference, down=all, status=inference
  if (verb === 'up') return [stack === 'training' ? trn : inf]
  if (verb === 'down') return [trn, inf]
  return [inf]
}

/** Pure: build `docker compose -f <file> <verb> [-d]` arg tuples per stack file. */
export function composeArgs(host: HostConfig, verb: 'up' | 'down' | 'ps', stack?: 'inference' | 'training'): [string, string[]][] {
  const files = stackFiles(host, verb === 'ps' ? 'status' : verb, stack)
  return files.map((f) => {
    const args = ['compose', '-f', f, verb]
    if (verb === 'up') args.push('-d')
    return ['docker', args] as [string, string[]]
  })
}

/**
 * The duration out of a docker `Status` field: `Up 9 hours (healthy)` → `9 hours`.
 *
 * Everything the runtime says after `Up` is kept minus the health parenthetical, because health is a
 * separate question from elapsed time and `status` has no line for it. Returns undefined when no
 * `Up` is present — an asleep or down stack has no uptime to report, and saying so beats `0s`.
 */
export function uptimeOf(statusText: string): string | undefined {
  const m = statusText.match(/\bUp\s+([^\n]+?)(?:\s\([^)]*\))?\s*$/im)
  return m?.[1]?.trim() || undefined
}

export class LocalDeploymentProvider implements DeploymentProvider {
  readonly kind = 'local' as const
  constructor(private readonly runner: Runner = defaultRunner) {}

  async up(host: HostConfig, opts?: UpDownOpts): Promise<void> {
    for (const [cmd, args] of composeArgs(host, 'up', opts?.stack)) this.runner.run(cmd, args)
  }

  async down(host: HostConfig, _opts?: UpDownOpts): Promise<void> {
    for (const [cmd, args] of composeArgs(host, 'down')) this.runner.run(cmd, args)
  }

  async status(host: HostConfig): Promise<HostStatus> {
    try {
      let out = ''
      // `.Status` is requested alongside `.State` because it is the only field carrying the running
      // duration ("Up 9 hours (healthy)"). Verified against docker 29.9.1 on a live container rather
      // than assumed: `docker compose ps --format '{{.Name}} {{.State}} {{.Status}}'` printed
      // `…-api-1 running Up 9 hours (healthy)`. (`docker ps --format '{{.Name}}'` alone FAILS on this
      // docker version — the compose subcommand is what supports these keys.)
      for (const [cmd, args] of composeArgs(host, 'ps')) out += this.runner.capture(cmd, [...args, '--format', '{{.Name}} {{.State}} {{.Status}}'])
      const running = /\bUp\b|running/i.test(out)
      return {
        reachable: true,
        mode: running ? 'awake' : 'down',
        uptime: running ? uptimeOf(out) : undefined,
        detail: out.trim() || undefined,
      }
    } catch (e: any) {
      // A failed `docker compose ps` is not "the stack is down" — it is "we could not ask". The
      // hyperstack provider already refuses this conflation for the same reason (#89): reporting a
      // permission or missing-file failure as `down` sends the operator to `saip down`/`awake` while
      // the real problem is that the daemon or the compose file is unreadable. `unknown` plus the
      // reason is the honest answer, and `saip status` prints that reason (#114).
      return { reachable: false, mode: 'unknown', detail: e?.message }
    }
  }
}
