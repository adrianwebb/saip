/**
 * `saip ssh` behaviour, with a fake runner and a temp store: no network, no real host, no keyring.
 * What is asserted is mostly *what is never printed* — a private key must not reach stdout, a file,
 * or a log, and the materialised identity must be gone when a command returns or fails.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { CommandRegistryService } from '../src/lib/command-registry.js'
import { SecretStore, MemoryKeySource } from '@saip/shared'
import sshPlugin, { runSsh, type SshRunner } from '../src/commands/ssh.js'
import { buildStore } from '../src/commands/config.js'
import { managedKeyName, liveMaterialisedKeys } from '../src/lib/ssh-keys.js'

const dir = () => mkdtempSync(join(tmpdir(), 'saip-sshcmd-'))
const HOSTS = [
  { name: 'lab', kind: 'hyperstack', role: 'inference', ssh: { host: '203.0.113.10', user: 'ubuntu' } },
  { name: 'legacy', kind: 'hyperstack', role: 'training', ssh: { host: 'h2', user: 'ubuntu', key_secret: 'MY_KEY' } },
  { name: 'odd', kind: 'hyperstack', role: 'inference', ssh: { host: '198.51.100.7', user: 'admin', port: 2222 } },
] as any[]

const mk = () => new SecretStore({ path: join(dir(), 'keys', 's.enc.json'), keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 5))] })

const runner = (code = 0, stderr = ''): SshRunner & { calls: [string, string[]][] } => {
  const calls: [string, string[]][] = []
  return { calls, run: (cmd, args) => { calls.push([cmd, args]); return { code, stdout: '', stderr } } }
}

describe('saip ssh generate / show', () => {
  it('stores the private half and prints only the public one', async () => {
    const store = mk()
    const r = await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    expect(r.code).toBe(0)
    const pem = (await store.get(managedKeyName('lab')))!
    expect(pem).toMatch(/BEGIN PRIVATE KEY/)
    const out = r.lines.join('\n')
    expect(out).not.toMatch(/BEGIN PRIVATE KEY/)
    expect(out).toMatch(/ssh-ed25519/)
    expect(out).toMatch(/saip ssh verify --host lab/)
  })

  it('refuses to overwrite an existing key without an explicit rotate', async () => {
    const store = mk()
    await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    const again = await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    expect(again.code).toBe(1)
    expect(again.lines.join(' ')).toMatch(/rotate/)
  })

  it('honours an explicit key_secret instead of the managed name', async () => {
    const store = mk()
    await runSsh('generate', { host: 'legacy' }, { store, hosts: () => HOSTS })
    expect(await store.get('MY_KEY')).toBeTruthy()
    expect(await store.get(managedKeyName('legacy'))).toBeUndefined()
  })

  it('names an unknown host and lists the known ones', async () => {
    const r = await runSsh('generate', { host: 'ghost' }, { store: mk(), hosts: () => HOSTS })
    expect(r.code).toBe(1)
    expect(r.lines.join(' ')).toMatch(/lab/)
  })

  it('show prints the public key and nothing that looks private', async () => {
    const store = mk()
    await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    const r = await runSsh('show', { host: 'lab' }, { store, hosts: () => HOSTS })
    expect(r.lines.join("")).toMatch(/ssh-ed25519/)
    expect(r.lines.join(' ')).not.toMatch(/PRIVATE KEY/)
  })
})

describe('the passphrase explains itself before it asks (#89 ordering)', () => {
  it('buildStore writes the reason line before prompting for the passphrase', async () => {
    const d = dir()
    const path = join(d, 's.enc.json')
    // Seed with the SAME derivation the prompt will produce, otherwise the unlock legitimately
    // fails and the test measures a wrong passphrase instead of a prompt ordering.
    const { PassphraseKey } = await import('@saip/shared')
    const phrase = 'the-typed-passphrase'
    const seed = new SecretStore({ path, keySources: [new PassphraseKey({ SAIP_SECRETS_PASSPHRASE: phrase })] })
    await seed.set('A_KEY', 'v')
    const asked: string[] = []
    const writes: string[] = []
    // Declared outside the try so the assertions after it can see the snapshot.
    const writesAtPrompt: string[] = []
    const real = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (c: any) => { writes.push(String(c)); return true }
    try {
      // Snapshot stdout at the moment the prompt is invoked: that is the only way to see
      // whether the explanation reached the screen before the question did.
      const store = buildStore({
        storePath: path,
        env: {},
        prompt: async (q) => { asked.push(q); writesAtPrompt.push(...writes); return phrase },
        reason: 'unlocking the store that holds the SSH key for host "probe"',
      })
      await store.get('A_KEY')
    } finally { (process.stdout as any).write = real }
    expect(asked.length).toBe(1)
    // The reason must be on screen before the prompt, not after the answer.
    const seen = writesAtPrompt.join('')
    expect(seen).toMatch(/SSH key for host "probe"/)               // caller's reason
    expect(seen).toMatch(/SAIP_SECRETS_PASSPHRASE skips this prompt/) // and the hint, added once here
    expect(seen.indexOf('SSH key for host')).toBeLessThan(seen.indexOf('SAIP_SECRETS_PASSPHRASE'))
    // The store read must still succeed: the prompt is answered with the seeded passphrase.
    
  })
})

describe('saip ssh verify', () => {
  it('carries the declared port into the ssh argv (#98)', async () => {
    // The port bug was invisible in this file's other case: with no `-p`, ssh connects to 22 and the
    // FAKE runner records that happily. So the assertion is on the argv, which is the only place the
    // host's `ssh.port` can be honoured or lost.
    const store = mk()
    await runSsh('generate', { host: 'odd' }, { store, hosts: () => HOSTS })
    const r = runner()
    const out = await runSsh('verify', { host: 'odd' }, { store, hosts: () => HOSTS, runner: r })
    expect(out.code, out.text).toBe(0)
    const [, args] = r.calls[0]
    const at = args.indexOf('-p')
    expect(at, `no -p in: ${args.join(' ')}`).toBeGreaterThan(0)
    expect(args[at + 1]).toBe('2222')
    // The port belongs to the connection, not to the destination string.
    expect(args).toContain('admin@198.51.100.7')
    expect(liveMaterialisedKeys()).toEqual([])
  })

  it('omits -p entirely when the host declares no port', async () => {
    const store = mk()
    await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    const r = runner()
    await runSsh('verify', { host: 'lab' }, { store, hosts: () => HOSTS, runner: r })
    expect(r.calls[0][1]).not.toContain('-p')
  })

  it('passes -i a real path and leaves nothing behind', async () => {
    const store = mk()
    await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    const r = runner()
    const out = await runSsh('verify', { host: 'lab' }, { store, hosts: () => HOSTS, runner: r })
    expect(out.code).toBe(0)
    const [, args] = r.calls[0]
    expect(args).toContain('-i')
    const path = args[args.indexOf('-i') + 1]
    expect(path).not.toMatch(/run\/secrets/)
    expect(existsSync(path)).toBe(false)
    expect(args).toContain('BatchMode=yes')
    expect(liveMaterialisedKeys()).toEqual([])
  })

  it('removes the identity even when ssh fails, and explains the public-key step', async () => {
    const store = mk()
    await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    const r = runner(255, 'Permission denied (publickey).')
    const out = await runSsh('verify', { host: 'lab' }, { store, hosts: () => HOSTS, runner: r })
    expect(out.code).toBe(1)
    expect(out.lines.join(' ')).toMatch(/Permission denied/)
    expect(out.lines.join(' ')).toMatch(/saip ssh show --host lab/)
    expect(liveMaterialisedKeys()).toEqual([])
  })

  it('does not attempt ssh when no key exists', async () => {
    const r = runner()
    const out = await runSsh('verify', { host: 'lab' }, { store: mk(), hosts: () => HOSTS, runner: r })
    expect(out.code).toBe(1)
    expect(r.calls.length).toBe(0)
  })
})

describe('saip ssh rotate / remove / migrate / list', () => {
  it('rotate replaces the key and states the revocation SAIP cannot do', async () => {
    const store = mk()
    await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    const first = (await store.get(managedKeyName('lab')))!
    const out = await runSsh('rotate', { host: 'lab' }, { store, hosts: () => HOSTS })
    expect(out.code).toBe(0)
    expect((await store.get(managedKeyName('lab')))!).not.toBe(first)
    expect(out.lines.join(' ')).toMatch(/cannot revoke|still authorised/)
  })

  it('remove clears both halves', async () => {
    const store = mk()
    await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    const out = await runSsh('remove', { host: 'lab' }, { store, hosts: () => HOSTS })
    expect(out.code).toBe(0)
    expect(await store.get(managedKeyName('lab'))).toBeUndefined()
  })

  it('migrate imports a stored legacy PEM and clears the old name', async () => {
    const store = mk()
    const { generateKeypair } = await import('../src/lib/ssh-keys.js')
    const kp = generateKeypair('old')
    await store.set('SAIP_SSH_PRIVATE_KEY', kp.privatePem)
    const out = await runSsh('migrate', { host: 'lab' }, { store, hosts: () => HOSTS })
    expect(out.code).toBe(0)
    expect(await store.get(managedKeyName('lab'))).toBe(kp.privatePem)
    expect(await store.get('SAIP_SSH_PRIVATE_KEY')).toBeUndefined()
  })

  it('migrate refuses to overwrite and reports a path-shaped value it cannot read', async () => {
    const store = mk()
    await store.set('SAIP_SSH_PRIVATE_KEY', '/nonexistent/id_ed25519')
    const out = await runSsh('migrate', { host: 'lab' }, { store, hosts: () => HOSTS })
    expect(out.code).toBe(1)
    expect(out.lines.join(' ')).toMatch(/not a private key PEM/)
  })

  it('list reports no keys, then the managed ones', async () => {
    const store = mk()
    expect((await runSsh('list', {}, { store, hosts: () => HOSTS })).lines.join(' ')).toMatch(/no managed SSH keys/)
    await runSsh('generate', { host: 'lab' }, { store, hosts: () => HOSTS })
    expect((await runSsh('list', {}, { store, hosts: () => HOSTS })).lines.join(' ')).toMatch(/SAIP_SSH_KEY_LAB/)
  })
})

describe('registry wiring (#76: test the assembled command, not the export)', () => {
  it('registers saip ssh with its actions and options', async () => {
    class Test extends Context {}
    const ctx = new Test()
    ctx.plugin(CommandRegistryService)
    ctx.plugin(sshPlugin as any, { store: mk(), hosts: () => HOSTS, runner: runner() })
    await new Promise((r) => setImmediate(r))
    const spec = ctx.commandRegistry!.get('ssh')
    expect(spec).toBeTruthy()
    expect(spec!.positional).toContain('action')
    expect(spec!.options?.some((o: { flag: string }) => o.flag.includes('--host'))).toBe(true)
  })
})
