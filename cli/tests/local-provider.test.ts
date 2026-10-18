import { describe, it, expect } from 'vitest'
import type { HostConfig } from '@saip/shared'
import { LocalDeploymentProvider, composeArgs, type Runner } from '../src/lib/providers/local.js'

const inferenceHost: HostConfig = { name: 'local-inf', kind: 'local', role: 'inference', compose_dir: '/repo' }
const bothHost: HostConfig = { name: 'default', kind: 'local', role: 'both', compose_dir: '.' }

class FakeRunner implements Runner {
  public calls: string[][] = []
  run(cmd: string, args: string[]): string { this.calls.push([cmd, ...args]); return '' }
  capture(cmd: string, args: string[]): string { this.calls.push([cmd, ...args]); return 'NAME STATUS\ndefault_inference-api Up 5 minutes\n' }
}

describe('composeArgs (pure)', () => {
  it('selects the inference stack for an inference-role host', () => {
    const [tuple] = composeArgs(inferenceHost, 'up')
    expect(tuple[1]).toContain('/repo/inference/docker-compose.yml')
  })
  it('for a both host, up starts inference and down stops both', () => {
    // up on `both` → inference stack only; down → both stacks
    const up = composeArgs(bothHost, 'up')
    expect(up).toHaveLength(1)
    expect(up[0][1].join(' ')).toContain('inference/docker-compose.yml')
    const down = composeArgs(bothHost, 'down')
    expect(down).toHaveLength(2)
    expect(down.map((t) => t[1].join(' ')).join(' ')).toContain('training/docker-compose.yml')
  })
})

describe('LocalDeploymentProvider', () => {
  it('up issues docker compose up -d for the resolved stack', async () => {
    const r = new FakeRunner()
    await new LocalDeploymentProvider(r).up(inferenceHost)
    expect(r.calls[0]).toEqual(['docker', 'compose', '-f', '/repo/inference/docker-compose.yml', 'up', '-d'])
  })

  it('down issues compose down', async () => {
    const r = new FakeRunner()
    await new LocalDeploymentProvider(r).down(inferenceHost)
    expect(r.calls.some((c) => c.includes('down'))).toBe(true)
  })

  it('status reports reachable when compose lists running services', async () => {
    const st = await new LocalDeploymentProvider(new FakeRunner()).status(inferenceHost)
    expect(st.reachable).toBe(true)
  })
})
