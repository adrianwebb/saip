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

describe('LocalDeploymentProvider.status — an unreadable host is not a down host (#114)', () => {
  it('reports unknown, with the reason, when compose ps fails', async () => {
    const failing: Runner = {
      run: () => '',
      capture: () => { throw new Error('compose file "inference/docker-compose.yml" is invalid: no such file') },
    }
    const st = await new LocalDeploymentProvider(failing).status(inferenceHost)
    expect(st.reachable).toBe(false)
    // The defect this pins: `mode: 'down'` presented a failed read as a measurement of state.
    expect(st.mode).toBe('unknown')
    expect(st.detail).toMatch(/invalid/)
  })

  it('reports uptime from the Status field when the stack is running', async () => {
    const st = await new LocalDeploymentProvider(new FakeRunner()).status(inferenceHost)
    expect(st.mode).toBe('awake')
    expect(st.uptime).toBe('5 minutes')          // FakeRunner returns `… Up 5 minutes`
  })

  it('reports no uptime when the stack is not awake', async () => {
    const stopped: Runner = { run: () => '', capture: () => 'saip-inference-api exited (0) 2 minutes ago\n' }
    const st = await new LocalDeploymentProvider(stopped).status(inferenceHost)
    expect(st.mode).toBe('down')
    expect(st.uptime).toBeUndefined()
  })

  it('parses the health suffix out of a real docker Status line', async () => {
    // Verified shape: `dsh-treedx-local-treedx-api-1 running Up 9 hours (healthy)` on docker 29.9.1.
    const real: Runner = { run: () => '', capture: () => 'x-api-1 running Up 9 hours (healthy)\n' }
    const st = await new LocalDeploymentProvider(real).status(inferenceHost)
    expect(st.uptime).toBe('9 hours')            // health is a separate question, not part of duration
  })
})
