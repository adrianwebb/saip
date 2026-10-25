import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import {
  validateHostRegistry,
  EnvSecrets,
  type HostConfig,
  sshConnectionArgs,
  sshDestination
} from '../src/hosting.js'

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

describe('ssh.port (#98)', () => {
  const withSsh = (ssh: unknown) => ({
    name: 'h', kind: 'hyperstack', role: 'both', tofu: { workspace: 'w' }, ssh,
  }) as any

  it('accepts a port in range, and a host with no port at all', () => {
    expect(validateHostRegistry({ hosts: [withSsh({ host: 'h1', user: 'u', port: 2222 })] })).toEqual([])
    expect(validateHostRegistry({ hosts: [withSsh({ host: 'h1', user: 'u' })] })).toEqual([])
    expect(validateHostRegistry({ hosts: [withSsh({ host: 'h1', user: 'u', port: 65535 })] })).toEqual([])
  })

  it('refuses a port that cannot be one, rather than passing it to ssh and letting it fail', () => {
    for (const bad of [0, -1, 65536, 22.5, '2222', null]) {
      const codes = validateHostRegistry({ hosts: [withSsh({ host: 'h1', user: 'u', port: bad })] }).map((e) => e.code)
      expect(codes, `port ${JSON.stringify(bad)} was accepted`).toContain('invalid_ssh_port')
    }
  })

  it('names the offending path so a five-host file is diagnosable', () => {
    const errs = validateHostRegistry({ hosts: [withSsh({ host: 'h1', user: 'u', port: 70000 })] })
    expect(errs[0].path).toMatch(/ssh\.port/)
    expect(errs[0].message).toMatch(/70000/)
  })
})

describe('unknown keys are refused, not ignored (#98)', () => {
  it('a key inside ssh: that SshConfig has no field for is an error', () => {
    const reg = { hosts: [{ name: 'h', kind: 'hyperstack', role: 'both', tofu: { workspace: 'w' }, ssh: { host: 'a', user: 'u', prot: 22 } }] } as any
    const errs = validateHostRegistry(reg)
    expect(errs.map((e) => e.code)).toContain('unknown_ssh_key')
    expect(errs.find((e) => e.code === 'unknown_ssh_key')!.message).toMatch(/prot/)
  })

  it('a key at the top of a host entry is an error too', () => {
    const reg = { hosts: [{ name: 'h', kind: 'local', role: 'both', sshd_dir: '/etc' }] } as any
    const errs = validateHostRegistry(reg)
    expect(errs.map((e) => e.code)).toContain('unknown_host_key')
    expect(errs.find((e) => e.code === 'unknown_host_key')!.message).toMatch(/sshd_dir/)
  })

  it('the documented example file still validates clean (guards the allowed-key list against drift)', () => {
    const text = readFileSync(new URL('../../hosts.example.yaml', import.meta.url), 'utf8')
    const reg = parseYaml(text)
    const errs = validateHostRegistry(reg)
    expect(errs, JSON.stringify(errs)).toEqual([])
  })
})

describe('one argument builder for every connection (#98)', () => {
  const host = (ssh: unknown) => ({ name: 'h', kind: 'hyperstack', role: 'both', ssh }) as any

  it('carries -p when the host declares a port', () => {
    const args = sshConnectionArgs(host({ host: '1.2.3.4', user: 'ubuntu', port: 2222 }), '/tmp/id')
    expect(args.slice(0, 4)).toEqual(['-i', '/tmp/id', '-p', '2222'])
    expect(sshDestination(host({ host: '1.2.3.4', user: 'ubuntu', port: 2222 }))).toBe('ubuntu@1.2.3.4')
  })

  it('omits -p when it does not, so the default stays ssh default', () => {
    const args = sshConnectionArgs(host({ host: '1.2.3.4', user: 'ubuntu' }), '/tmp/id')
    expect(args).not.toContain('-p')
  })

  it('keeps BatchMode and host-key policy on every path, and lets a caller add more', () => {
    const args = sshConnectionArgs(host({ host: 'h', user: 'u' }), '/tmp/id', ['-o', 'ConnectTimeout=10'])
    expect(args.join(' ')).toMatch(/BatchMode=yes/)
    expect(args.join(' ')).toMatch(/StrictHostKeyChecking=accept-new/)
    expect(args.join(' ')).toMatch(/ConnectTimeout=10/)
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
