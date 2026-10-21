import { describe, it, expect } from 'vitest'
import type { HostConfig } from '@saip/shared'
import { HyperstackDeploymentProvider, sshComposeArgs, InfraNotAuthorizedError } from '../src/lib/providers/hyperstack.js'

const host: HostConfig = {
  name: 'cloud-inference', kind: 'hyperstack', role: 'inference',
  ssh: { host: '1.2.3.4', user: 'ubuntu', key_secret: 'SAIP_SSH_PRIVATE_KEY' },
  tofu: { workspace: 'infra/tofu/hyperstack' },
}

class FakeRunner {
  runCalls: string[][] = []
  captureCalls: string[][] = []
  run(cmd: string, args: string[]): string { this.runCalls.push([cmd, ...args]); return '' }
  capture(cmd: string, args: string[]): string { this.captureCalls.push([cmd, ...args]); return 'Up' }
}

describe('sshComposeArgs (pure)', () => {
  it('builds a remote docker compose invocation over ssh', () => {
    const [cmd, args] = sshComposeArgs(host, 'up', '/tmp/id')[0]
    expect(cmd).toBe('ssh')
    expect(args.join(' ')).toMatch(/ubuntu@1\.2\.3\.4/)
    expect(args.join(' ')).toMatch(/docker compose -f \S*inference\/docker-compose\.yml up -d/)
  })
})

describe('HyperstackDeploymentProvider', () => {
  it('up drives compose over ssh via the injected runner', async () => {
    const r = new FakeRunner()
    // An identity resolver is now required: a keyless remote ssh is the silent-auth-failure
    // shape #83 shipped with, so the provider refuses instead (see ssh-keys.test.ts).
    await new HyperstackDeploymentProvider(r as any, async (_h: any, fn: any) => fn('/tmp/id')).up(host)
    expect(r.runCalls.length).toBeGreaterThan(0)
    expect(r.runCalls[0][0]).toBe('ssh')
  })

  it('deploy throws InfraNotAuthorizedError unless SAIP_ALLOW_INFRA=true', async () => {
    delete process.env.SAIP_ALLOW_INFRA
    const p = new HyperstackDeploymentProvider(new FakeRunner() as any)
    await expect(p.deploy!(host, host, {})).rejects.toBeInstanceOf(InfraNotAuthorizedError)
  })

  it('deploy runs tofu when SAIP_ALLOW_INFRA=true', async () => {
    process.env.SAIP_ALLOW_INFRA = 'true'
    const r = new FakeRunner()
    const res = await new HyperstackDeploymentProvider(r as any, async (_h: any, fn: any) => fn('/tmp/id')).deploy!(host, host, { region: 'CANADA-1' })
    delete process.env.SAIP_ALLOW_INFRA
    expect(res.applied).toBe(true)
    expect(r.runCalls.some((c) => c.includes('tofu'))).toBe(true)
  })
})
