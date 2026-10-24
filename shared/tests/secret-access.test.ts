/**
 * SecretAccessService (#93) — the single place secrets are reached.
 *
 * Three properties, each with a test: one unlock per command however many secrets are read; a
 * declared reason for each name, so a prompt can explain itself; and an audit record that is safe to
 * print because it never contains a value. The Cordis plugin form is exercised separately in the CLI
 * composition-root test (#76 rule), since its default construction is where wiring bugs hide.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  SecretAccess, SecretStore, MemoryKeySource, MissingSecretError, findSecret, readAudit,
  type KeySource,
} from '../src/index.js'

const dir = () => mkdtempSync(join(tmpdir(), 'saip-gw-'))
const store = (path: string, seed: number = 7) =>
  new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, seed))] })

async function seeded(names: Record<string, string>, seed = 7) {
  const path = join(dir(), 's.enc.json')
  const s = store(path, seed)
  for (const [k, v] of Object.entries(names)) await s.set(k, v)
  return { path, s }
}

describe('one unlock per command', () => {
  it('derives the key once across many reads, however many secrets were declared', async () => {
    const { path } = await seeded({ SAIP_R2_BUCKET: 'b', SAIP_R2_ACCESS_KEY_ID: 'AK', SAIP_R2_SECRET_ACCESS_KEY: 'SK' })
    const key = Buffer.alloc(32, 7)
    let derivations = 0
    class Counting implements KeySource {
      readonly id = 'passphrase' as const
      async wrapKey(): Promise<Buffer | null> { derivations++; return key }
    }
    const s = new SecretStore({ path, keySources: [new Counting()] })
    const gw = new SecretAccess(s, {})
    gw.declare('inference gateway', [
      { name: 'SAIP_R2_BUCKET', purpose: 'storage target' },
      { name: 'SAIP_R2_ACCESS_KEY_ID', purpose: 'signing requests' },
      { name: 'SAIP_R2_SECRET_ACCESS_KEY', purpose: 'signing requests' },
    ])
    expect((await gw.unlock()).ok).toBe(true)
    expect(derivations).toBe(1)
    await gw.read('SAIP_R2_BUCKET')
    await gw.read('SAIP_R2_ACCESS_KEY_ID')
    await gw.require('SAIP_R2_SECRET_ACCESS_KEY')
    expect((await gw.unlock()).ok).toBe(true)
    expect(derivations).toBe(1)
  })

  it('refuses reads when the unlock failed, and logs nothing', async () => {
    const { path } = await seeded({ SAIP_R2_BUCKET: 'b' })
    const gw = new SecretAccess(store(path, 99), {})
    gw.declare('config init', [{ name: 'SAIP_R2_BUCKET', purpose: 'storage target' }])
    const r = await gw.unlock()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cannot unlock/)
    await expect(gw.require('SAIP_R2_BUCKET')).rejects.toThrow(/has not been unlocked|cannot unlock/i)
    expect(gw.accessLog()).toEqual([])
  })

  it('calls a missing store "missing", not "wrong passphrase"', async () => {
    const gw = new SecretAccess(store(join(dir(), 'nope.enc.json')), {})
    const r = await gw.unlock()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no secret store/)
  })

  it('relock() forces a fresh derivation, so a rotated wrap is never served from cache', async () => {
    const { path } = await seeded({ A: '1' })
    const key = Buffer.alloc(32, 7)
    let calls = 0
    class Counting implements KeySource {
      readonly id = 'passphrase' as const
      async wrapKey(): Promise<Buffer | null> { calls++; return key }
    }
    const s = new SecretStore({ path, keySources: [new Counting()] })
    const gw = new SecretAccess(s, {})
    gw.declare('t', [{ name: 'A', purpose: 'p' }])
    await gw.unlock(); await gw.read('A')
    expect(calls).toBe(1)
    gw.relock()
    await gw.unlock(); await gw.read('A')
    expect(calls).toBe(2)
  })
})

describe('declarations and explanation', () => {
  it('explains what a command reads, falling back to the catalog purpose', async () => {
    const { path } = await seeded({ SAIP_R2_BUCKET: 'b' })
    const gw = new SecretAccess(store(path), {})
    gw.declare('config init', [{ name: 'SAIP_R2_BUCKET' }])
    const text = gw.explain('config init')
    expect(text).toMatch(/SAIP_R2_BUCKET/)
    expect(text).toMatch(/Object storage for adapters/)
    expect(text).toMatch(/config/)
  })

  it('lists which commands use a secret, declared or catalogued', () => {
    const gw = new SecretAccess(store(join(dir(), 'x.enc.json')), {})
    expect(gw.usersOf('SAIP_R2_BUCKET')).toEqual(expect.arrayContaining(['config init']))
    gw.declare('my tool', [{ name: 'SAIP_ODD_NAME' }])
    expect(gw.usersOf('SAIP_ODD_NAME')).toEqual(['my tool'])
  })

  it('labels uncatalogued names as inferred rather than presenting a guess as fact', () => {
    const gw = new SecretAccess(store(join(dir(), 'y.enc.json')), {})
    gw.declare('my tool', [{ name: 'SAIP_ACME_API_KEY', purpose: 'because' }])
    expect(gw.explain('my tool')).toMatch(/inferred/)
    // A catalogued name must NOT be labelled inferred.
    gw.declare('clean', [{ name: 'SAIP_R2_BUCKET', purpose: 'p' }])
    expect(gw.explain('clean')).not.toMatch(/inferred/)
  })

  it('says so when a command declares nothing', () => {
    const gw = new SecretAccess(store(join(dir(), 'z.enc.json')), {})
    expect(gw.explain('idle')).toMatch(/no secrets/)
  })
})

describe('reads and audit', () => {
  it('prefers the environment, falls back to the store, fails closed by name', async () => {
    const { path } = await seeded({ SAIP_R2_BUCKET: 'from-store' })
    const gw = new SecretAccess(store(path), { SAIP_R2_ENDPOINT: 'from-shell' })
    gw.declare('t', [{ name: 'SAIP_R2_ENDPOINT', purpose: 'p' }, { name: 'SAIP_R2_BUCKET', purpose: 'q' }])
    expect(await gw.get('SAIP_R2_ENDPOINT')).toBe('from-shell')
    await gw.unlock()
    expect(await gw.require('SAIP_R2_BUCKET')).toBe('from-store')
    await expect(gw.require('SAIP_NOT_SET_ANYWHERE')).rejects.toBeInstanceOf(MissingSecretError)
  })

  it('records name + command + purpose, never the value', async () => {
    const { path } = await seeded({ SAIP_R2_SECRET_ACCESS_KEY: 'super-secret-value-xyz' })
    const gw = new SecretAccess(store(path), {})
    gw.declare('inference gateway', [{ name: 'SAIP_R2_SECRET_ACCESS_KEY', purpose: 'signing storage requests' }])
    await gw.unlock()
    await gw.require('SAIP_R2_SECRET_ACCESS_KEY')
    const log = gw.accessLog()
    expect(log.length).toBe(1)
    expect(log[0]).toMatchObject({ command: 'inference gateway', name: 'SAIP_R2_SECRET_ACCESS_KEY', purpose: 'signing storage requests' })
    expect(log[0].sensitive).toBe(true)
    expect(log[0].declared).toBe(true)
    expect(JSON.stringify(log)).not.toContain('super-secret-value-xyz')
  })

  it('satisfies the SecretsProvider seam so callers need no second path', async () => {
    const { path } = await seeded({ SAIP_R2_BUCKET: 'b' })
    const gw = new SecretAccess(store(path), {})
    gw.declare('t', [{ name: 'SAIP_R2_BUCKET', purpose: 'q' }])
    await gw.unlock()
    expect(await gw.get('SAIP_R2_BUCKET')).toBe('b')
    expect(await gw.get('NOPE')).toBeUndefined()
  })

  it('exposes the catalog so the wizard and the gateway read one source', () => {
    const gw = new SecretAccess(store(join(dir(), 'c.enc.json')), {})
    const list = gw.catalog({}, [])
    expect(list.map((e) => e.name)).toContain('SAIP_R2_BUCKET')
    expect(findSecret('SAIP_R2_BUCKET')!.sensitive).toBe(false)
  })
})

describe('persisted access history (#93)', () => {
  it('survives into a later process and never records a value', async () => {
    const d = dir()
    const path = join(d, 's.enc.json')
    const audit = join(d, 'access.json')
    const { SecretStore: SS, MemoryKeySource: MK } = await import('../src/index.js')
    const seed = new SS({ path, keySources: [new MK('passphrase', Buffer.alloc(32, 7))] })
    await seed.set('SAIP_R2_BUCKET', 'a-real-bucket-name')

    const first = new SecretAccess(new SS({ path, keySources: [new MK('passphrase', Buffer.alloc(32, 7))] }), {}, audit)
    first.declare('config get', [{ name: 'SAIP_R2_BUCKET', purpose: 'display the configured bucket' }])
    await first.unlock()
    await first.require('SAIP_R2_BUCKET')

    // A separate instance simulates the next command, which is when the question is actually asked.
    const second = new SecretAccess(new SS({ path, keySources: [new MK('passphrase', Buffer.alloc(32, 7))] }), {}, audit)
    expect(readAudit(audit).length).toBe(1)
    expect(readAudit(audit)[0]).toMatchObject({ command: 'config get', name: 'SAIP_R2_BUCKET' })
    expect(second.accessLog()).toEqual([])
    const raw = readFileSync(audit, 'utf8')
    expect(raw).not.toContain('a-real-bucket-name')
    expect((await import('node:fs')).statSync(audit).mode & 0o777).toBe(0o600)
  })

  it('a failed audit write never blocks the read', async () => {
    const d = dir()
    const path = join(d, 's.enc.json')
    const { SecretStore: SS, MemoryKeySource: MK } = await import('../src/index.js')
    const seed = new SS({ path, keySources: [new MK('passphrase', Buffer.alloc(32, 7))] })
    await seed.set('A_KEY', 'v')
    // Unwritable path: inside a file, not a directory.
    const notADir = join(d, 'blocker')
    writeFileSync(notADir, 'x')
    const gw = new SecretAccess(new SS({ path, keySources: [new MK('passphrase', Buffer.alloc(32, 7))] }), {}, join(notADir, 'audit.json'))
    gw.declare('t', [{ name: 'A_KEY', purpose: 'p' }])
    await gw.unlock()
    expect(await gw.require('A_KEY')).toBe('v')
    expect(gw.accessLog().length).toBe(1)
  })

  it('reads a corrupt or missing audit file as empty rather than throwing', () => {
    const d = dir()
    expect(readAudit(join(d, 'nope.json'))).toEqual([])
    writeFileSync(join(d, 'bad.json'), 'not json')
    expect(readAudit(join(d, 'bad.json'))).toEqual([])
    writeFileSync(join(d, 'obj.json'), '{"a":1}')
    expect(readAudit(join(d, 'obj.json'))).toEqual([])
  })
})

/**
 * #169: the rule "one unlock per command" had only ever been tested for READS, so the wizard's
 * writes reached the store through a second path and asked for the passphrase again mid-command.
 * These are the write-side cases the gateway needs to be the only path at all.
 */
describe('writes go through the same gateway, and share its unlock (#169)', () => {
  const key = () => Buffer.alloc(32, 61)

  it('creating a store by writing derives the key once, then reads for free', async () => {
    const d = dir()
    const path = join(d, 'fresh.enc.json')
    let derivations = 0
    let provisions = 0
    const k = key()
    class Creating implements KeySource {
      readonly id = 'passphrase' as const
      async wrapKey(): Promise<Buffer | null> { derivations++; return k }
      async provision(): Promise<{ key: Buffer; salt: Buffer | null }> { provisions++; return { key: k, salt: randomBytes(16) } }
    }
    const gw = new SecretAccess(new SecretStore({ path, keySources: [new Creating()] }), {}, join(d, 'audit.json'))
    gw.declare('config init', [
      { name: 'SAIP_R2_ACCESS_KEY_ID', purpose: 'storage credential' },
      { name: 'SAIP_R2_SECRET_ACCESS_KEY', purpose: 'storage credential' },
    ])

    // There is no pre-unlock to do here: `unlock()` refuses an absent store because there is nothing
    // to open, which is exactly why the wizard's first write is where the passphrase legitimately
    // belongs. Creating the store must therefore be the command's ONE unlock.
    await gw.write('SAIP_R2_ACCESS_KEY_ID', 'AK')
    await gw.write('SAIP_R2_SECRET_ACCESS_KEY', 'SK')

    expect(provisions).toBe(1)
    expect(derivations).toBe(0)
    expect(await gw.readStored('SAIP_R2_ACCESS_KEY_ID')).toBe('AK')
    expect(derivations).toBe(0)
    expect(gw.unlocked).toBe(true)

    // A write is an access: "why did that command touch my store" is answered by the same log, and
    // it still never contains the value.
    expect(gw.accessLog().map((r) => r.name)).toEqual(['SAIP_R2_ACCESS_KEY_ID', 'SAIP_R2_SECRET_ACCESS_KEY'])
    expect(readFileSync(join(d, 'audit.json'), 'utf8')).not.toContain('AK')
  })

  it('writing to an existing store unlocks once through the gateway, not once per operation', async () => {
    const d = dir()
    const path = join(d, 's.enc.json')
    await new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', key())] }).set('EXISTING', 'v')
    let derivations = 0
    const k = key()
    class Counting implements KeySource {
      readonly id = 'passphrase' as const
      async wrapKey(): Promise<Buffer | null> { derivations++; return k }
    }
    const gw = new SecretAccess(new SecretStore({ path, keySources: [new Counting()] }), {}, join(d, 'audit.json'))
    gw.declare('config init', [{ name: 'NEW_ONE', purpose: 'p' }])
    await gw.write('NEW_ONE', 'x')
    await gw.write('ANOTHER', 'y')
    expect(await gw.readStored('EXISTING')).toBe('v')
    expect(derivations).toBe(1)
  })

  it('a store that cannot be opened is not written to — nothing half-written, loudly refused', async () => {
    const d = dir()
    const path = join(d, 's.enc.json')
    await new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', key())] }).set('A', 'v')
    const before = readFileSync(path)
    const gw = new SecretAccess(new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', null)] }), {}, join(d, 'audit.json'))
    await expect(gw.write('A', 'overwrite')).rejects.toThrow(/unlock|passphrase/i)
    expect(readFileSync(path)).toEqual(before)
  })
})
