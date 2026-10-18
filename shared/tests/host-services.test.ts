import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { fileURLToPath } from 'node:url'
import { HostRegistryService, SecretsService } from '../src/services.js'
import { EnvSecrets } from '../src/hosting.js'

const exampleHosts = fileURLToPath(new URL('../../hosts.example.yaml', import.meta.url))

describe('SecretsService + HostRegistryService (Cordis)', () => {
  it('exposes secrets.require and hosts.resolve/validate on the context', async () => {
    const ctx = new Context() as any
    await ctx.plugin(SecretsService, { provider: new EnvSecrets() })
    await ctx.plugin(HostRegistryService, { path: exampleHosts })

    expect(typeof ctx.secrets?.require).toBe('function')
    expect(ctx.hosts?.resolve('default').kind).toBe('local')
    expect(ctx.hosts?.list().map((h: any) => h.name)).toContain('default')
    expect(ctx.hosts.assertValid()).toEqual([]) // example file is valid
  })

  it('secrets.require rejects for an unset secret name', async () => {
    const ctx = new Context() as any
    await ctx.plugin(SecretsService, { provider: new EnvSecrets({} as any) })
    await expect(ctx.secrets.require('NOPE_XYZ')).rejects.toThrow(/NOPE_XYZ/)
  })

  it('hosts.load surfaces validation errors for a bad registry', async () => {
    const ctx = new Context() as any
    await ctx.plugin(HostRegistryService, { inline: { hosts: [{ name: 'dup', kind: 'local', role: 'inference' }, { name: 'dup', kind: 'local', role: 'training' }] } })
    // duplicate names → error; but roles cover inference+training so no role_coverage
    const errs = ctx.hosts.assertValid().map((e: any) => e.code)
    expect(errs).toContain('duplicate_host')
  })
})
