import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { buildProgram } from '../src/index.js'
import { providerFor, UnregisteredProviderError } from '../src/lib/providers/index.js'

const hostsFile = fileURLToPath(new URL('../../hosts.example.yaml', import.meta.url))

describe('providerFor', () => {
  it('returns the local provider for kind=local', () => {
    expect(providerFor('local').kind).toBe('local')
  })
  it('throws UnregisteredProviderError for hyperstack (until PR K)', () => {
    expect(() => providerFor('hyperstack')).toThrow(UnregisteredProviderError)
  })
})

describe('--host targeting', () => {
  it('awake --host default runs the local provider up path without error', async () => {
    process.env.SAIP_HOSTS_FILE = hostsFile
    // Use a no-op docker via SAIP_DRY_RUN so we never touch real docker in CI/tests.
    process.env.SAIP_DRY_RUN = '1'
    const program = await buildProgram()
    await expect(program.parseAsync(['awake', '--host', 'default'], { from: 'user' })).resolves.toBeDefined()
    delete process.env.SAIP_HOSTS_FILE; delete process.env.SAIP_DRY_RUN
  })

  it('awake --host ghost fails closed listing known hosts', async () => {
    process.env.SAIP_HOSTS_FILE = hostsFile
    process.env.SAIP_DRY_RUN = '1'
    const program = await buildProgram()
    let errLine = ''
    const origErr = console.error
    console.error = (...a: unknown[]) => { errLine += a.join(' ') }
    try {
      await program.parseAsync(['awake', '--host', 'ghost'], { from: 'user' })
    } finally {
      console.error = origErr
      delete process.env.SAIP_HOSTS_FILE; delete process.env.SAIP_DRY_RUN
    }
    expect(errLine).toMatch(/unknown host "ghost"/i)
    expect(errLine).toMatch(/default/) // lists known hosts
  })
})
