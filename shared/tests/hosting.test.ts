import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { validateHostRegistry, EnvSecrets, type HostConfig } from '../src/hosting.js'

const local = (name = 'default', role: HostConfig['role'] = 'both'): HostConfig => ({ name, kind: 'local', role, compose_dir: '.' })
const hs = (name: string, role: HostConfig['role'], over: Partial<HostConfig> = {}): HostConfig => ({
  name, kind: 'hyperstack', role, ssh: { host: 'h', user: 'ubuntu', key_secret: 'K' }, ...over,
})

describe('validateHostRegistry', () => {
  it('accepts a valid local+hyperstack registry covering inference & training', () => {
    const r = validateHostRegistry({ hosts: [local('local-inference', 'inference'), hs('cloud-training', 'training')] })
    expect(r).toEqual([])
  })

  it('flags duplicate host names', () => {
    expect(validateHostRegistry({ hosts: [local('a'), local('a')] }).map((e) => e.code)).toContain('duplicate_host')
  })

  it('flags invalid kind', () => {
    expect(validateHostRegistry({ hosts: [{ name: 'x', kind: 'aws' as any, role: 'both' }] }).map((e) => e.code)).toContain('invalid_kind')
  })

  it('requires role', () => {
    expect(validateHostRegistry({ hosts: [{ name: 'x', kind: 'local' } as any] }).map((e) => e.code)).toContain('missing_role')
  })

  it('hyperstack requires tofu.workspace OR ssh', () => {
    const bad: any = { name: 'h', kind: 'hyperstack', role: 'both' }
    expect(validateHostRegistry({ hosts: [bad] }).map((e) => e.code)).toContain('host_unreachable_config')
  })

  it('requires the file to cover both inference and training roles overall', () => {
    const r = validateHostRegistry({ hosts: [local('only-inf', 'inference')] })
    expect(r.map((e) => e.code)).toContain('role_coverage')
  })

  it('secret refs must be non-empty strings', () => {
    const r = validateHostRegistry({ hosts: [hs('h', 'both', { secrets: { api_key: '' } })] })
    expect(r.map((e) => e.code)).toContain('invalid_secret_ref')
  })

  it('parses the committed hosts.example.yaml cleanly', () => {
    const path = fileURLToPath(new URL('../../hosts.example.yaml', import.meta.url))
    const reg = YAML.parse(readFileSync(path, 'utf8'))
    // example has one active local `both` host → covers inference + training
    expect(validateHostRegistry(reg)).toEqual([])
  })
})

describe('EnvSecrets (SecretsProvider)', () => {
  it('get returns undefined for unset vars', async () => {
    expect(await new EnvSecrets().get('SAIP_DEFINITELY_UNSET_XYZ')).toBeUndefined()
  })
  it('require resolves a set var and throws MissingSecretError otherwise', async () => {
    process.env.SAIP_TEST_SECRET = 'shhh'
    try {
      expect(await new EnvSecrets().require('SAIP_TEST_SECRET')).toBe('shhh')
    } finally { delete process.env.SAIP_TEST_SECRET }
    await expect(new EnvSecrets().require('SAIP_MISSING_ABC')).rejects.toThrow(/SAIP_MISSING_ABC/)
  })
})
