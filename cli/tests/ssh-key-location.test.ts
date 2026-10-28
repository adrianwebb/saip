/**
 * The SSH key directory must follow the STORE, never `$HOME` (#159).
 *
 * #145 fixed this for the product paths and missed `materialiseKey`'s two remaining callers, which kept
 * the ambient default `sshKeyDir()` — so `saip ssh verify` and the deploy provider's identity still
 * created a temporary private-key directory under the real home whenever the store lived elsewhere. The
 * tests here are written at the level a user (and a CI runner) observes the defect: the assembled command
 * surface, plus the artifact itself, rather than a unit call that could pass while production leaks.
 *
 * The guard that matters is not "does it work" but "where does it write": every assertion is a path
 * containment check against `homedir()`, because a test run that writes key material into the
 * maintainer's home is the exact failure this repo has already paid for twice.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SecretStore, PassphraseKey, MemoryKeySource } from '@saip/shared'
import { sshKeyDir, materialiseKey, generateKeypair, managedKeyName } from '../src/lib/ssh-keys.js'
import { runSsh } from '../src/commands/ssh.js'
import { withManagedIdentity } from '../src/lib/ssh-identity.js'

const dir = () => mkdtempSync(join(tmpdir(), 'saip-keyloc-'))
const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const distBin = join(repoRoot, 'cli/dist/bin.js')
const HOME = homedir()

const HOSTS = [
  { name: 'lab', kind: 'hyperstack', role: 'inference', ssh: { host: '203.0.113.10', user: 'ubuntu' } },
] as any[]

describe('sshKeyDir follows the configured store (#159)', () => {
  it('is the store directory plus keys, when SAIP_SECRETS_FILE is relocated', () => {
    const d = dir()
    expect(sshKeyDir({ SAIP_SECRETS_FILE: join(d, 'nested', 'secrets.enc.json') } as any))
      .toBe(join(d, 'nested', 'keys'))
  })

  it('falls back under HOME only when the store itself is the default', () => {
    const d = dir()
    const via = sshKeyDir({ HOME: d } as any)
    expect(via.startsWith(d)).toBe(true)
    expect(via).toBe(join(d, '.saip', 'keys'))
  })

  it('is a pure function of the env it is given — no ambient process.env read in the assertion', () => {
    const d = dir()
    const saved = process.env.SAIP_SECRETS_FILE
    try {
      process.env.SAIP_SECRETS_FILE = join(d, 'a', 'secrets.enc.json')
      // Passing an explicit env must win over the ambient one; the default argument is what leaked.
      expect(sshKeyDir({ SAIP_SECRETS_FILE: join(d, 'b', 'secrets.enc.json') } as any))
        .toBe(join(d, 'b', 'keys'))
    } finally {
      if (saved === undefined) delete process.env.SAIP_SECRETS_FILE
      else process.env.SAIP_SECRETS_FILE = saved
    }
  })
})

describe('saip ssh verify materialises inside the store directory (#159 product leak)', () => {
  it('hands ssh a path under the temp store, never under the real home', async () => {
    const store = new SecretStore({
      path: join(dir(), 'keys', 's.enc.json'),
      keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 5))],
    })
    const kp = generateKeypair('lab')
    await store.set(managedKeyName('lab'), kp.privatePem)

    const calls: [string, string[]][] = []
    const out = await runSsh('verify', { host: 'lab' }, {
      store,
      hosts: () => HOSTS,
      runner: { run: (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: '', stderr: '' } } },
    })

    expect(out.code).toBe(0)
    const args = calls[0][1]
    const identity = args[args.indexOf('-i') + 1]
    expect(identity.startsWith(store.filePath.replace(/\/s\.enc\.json$/, '')))
      .toBe(true)                                   // beside the store, the rule #145 established
    expect(identity).not.toContain(join(HOME, '.saip'))   // and never the real home
  })
})

describe('withManagedIdentity materialises beside the store it built (#159 product leak)', () => {
  it('puts the temporary identity under the relocated store, not under $HOME', async () => {
    const d = dir()
    const storePath = join(d, 'store', 'secrets.enc.json')
    const savedFile = process.env.SAIP_SECRETS_FILE
    const savedPass = process.env.SAIP_SECRETS_PASSPHRASE
    try {
      process.env.SAIP_SECRETS_FILE = storePath
      process.env.SAIP_SECRETS_PASSPHRASE = 'spike-passphrase'
      // Seeded with the SAME source the command will use — a passphrase wrap resolved from the env —
      // otherwise this test fails on "cannot unlock" and never reaches the path assertion it exists for.
      const seed = new SecretStore({ path: storePath, keySources: [new PassphraseKey(process.env)] })
      await seed.set(managedKeyName('lab'), generateKeypair('lab').privatePem)

      let seen = ''
      await withManagedIdentity(HOSTS[0], async (path) => { seen = path; return 'ok' })

      expect(seen).not.toBe('')
      expect(seen.startsWith(join(d, 'store'))).toBe(true)
      expect(seen).not.toContain(join(HOME, '.saip'))
    } finally {
      if (savedFile === undefined) delete process.env.SAIP_SECRETS_FILE
      else process.env.SAIP_SECRETS_FILE = savedFile
      if (savedPass === undefined) delete process.env.SAIP_SECRETS_PASSPHRASE
      else process.env.SAIP_SECRETS_PASSPHRASE = savedPass
    }
  })
})

describe('materialiseKey cannot be called without saying where', () => {
  it('writes the identity inside the directory it is given', async () => {
    const d = dir()
    let seen = ''
    await materialiseKey(generateKeypair('h').privatePem, 'h', async (p) => { seen = p }, d)
    // The identity is <dir>/<tmp-session>/id_ed25519, inside the directory that was passed.
    expect(seen.startsWith(d + '/')).toBe(true)
    expect(seen.endsWith('/id_ed25519')).toBe(true)
    expect(existsSync(seen)).toBe(false)            // removed on the way out, as before
  })
})

describe('the assembled program never writes into the real ~/.saip (#159 guard)', () => {
  const built = existsSync(distBin)

  it.skipIf(!built)('ssh generate with HOME redirected writes under the temp home only', () => {
    const d = dir()
    const home = join(d, 'home')
    const realKeys = join(HOME, '.saip', 'keys')
    const before = existsSync(realKeys) ? readdirSync(realKeys).sort() : null

    const env = {
      ...process.env,
      HOME: home,
      SAIP_SECRETS_FILE: join(home, '.saip', 'secrets.enc.json'),
      SAIP_ENV_FILE: join(d, '.env'),
      SAIP_HOSTS_FILE: join(d, 'hosts.yaml'),
      SAIP_CONFIG: join(d, 'saip.yaml'),
      SAIP_SECRETS_PASSPHRASE: 'spike-passphrase',
    }
    // A host registry must exist for generate to accept --host lab.
    writeFileSync(env.SAIP_HOSTS_FILE!, 'hosts:\n  - name: lab\n    kind: hyperstack\n    role: inference\n    ssh:\n      host: 203.0.113.10\n      user: ubuntu\n')

    const r = spawnSync(process.execPath, [distBin, 'ssh', 'generate', '--host', 'lab'], {
      encoding: 'utf8', cwd: d, env,
    })
    expect(r.stdout + r.stderr).not.toBe('')
    expect(r.status).toBe(0)

    // The key directory landed under the redirected home…
    expect(existsSync(join(home, '.saip', 'keys'))).toBe(true)
    const pubs = readdirSync(join(home, '.saip', 'keys')).filter((f) => f.endsWith('.pub'))
    expect(pubs.length).toBe(1)
    // …and the machine's real ~/.saip/keys is byte-for-byte unchanged.
    const after = existsSync(realKeys) ? readdirSync(realKeys).sort() : null
    expect(after).toEqual(before)
  })
})
