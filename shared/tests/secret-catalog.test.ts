/**
 * The secret catalog (#93): declared facts about each secret, in one place, so the wizard's
 * guidance and the runtime's access policy cannot disagree.
 *
 * The rule this file exists to enforce is that `sensitive` is a DECLARED property. Deriving it
 * from a name pattern is a guess, and the first guess was wrong: `SAIP_UI_ADMIN` is a password and
 * did not match until ADMIN was added by hand — see #87. Any test that recomputes sensitivity from
 * the name would pass even if the declaration were deleted, so these read the field.
 */
import { describe, it, expect } from 'vitest'
import { SECRET_CATALOG, RETIRED_SECRETS, catalogFor, findSecret, sensitivityOf, type SecretEntry } from '../src/index.js'

const names = SECRET_CATALOG.map((e) => e.name)

describe('SecretCatalog shape', () => {
  it('has unique names and explicit booleans on every entry', () => {
    expect(new Set(names).size).toBe(names.length)
    for (const e of SECRET_CATALOG) {
      expect(typeof e.sensitive).toBe('boolean')
      expect(typeof e.required).toBe('boolean')
      expect(e.purpose.length).toBeGreaterThan(20)
      expect(e.how.length).toBeGreaterThan(10)
      expect(Array.isArray(e.usedBy)).toBe(true)
      expect(e.usedBy.length).toBeGreaterThan(0)
      expect(e.providerUrl || e.docsUrl).toBeTruthy()
    }
  })

  it('declares exactly which entries are sensitive, rather than inferring any of them', () => {
    const sensitive = SECRET_CATALOG.filter((e) => e.sensitive).map((e) => e.name).sort()
    const plain = SECRET_CATALOG.filter((e) => !e.sensitive).map((e) => e.name).sort()
    expect(sensitive).toEqual([
      'SAIP_HF_TOKEN', 'SAIP_HYPERSTACK_API_KEY', 'SAIP_R2_ACCESS_KEY_ID',
      'SAIP_R2_SECRET_ACCESS_KEY', 'SAIP_SSH_PRIVATE_KEY',
    ])
    expect(plain).toEqual(['SAIP_HYPERSTACK_ENVIRONMENT', 'SAIP_R2_BUCKET', 'SAIP_R2_ENDPOINT'])
  })

  it('keeps the ordinary settings non-sensitive so they can be displayed and edited', () => {
    for (const n of ['SAIP_R2_BUCKET', 'SAIP_R2_ENDPOINT', 'SAIP_HYPERSTACK_ENVIRONMENT']) {
      const e = findSecret(n)!
      expect(e.sensitive).toBe(false)
      // A value you cannot see is a value you cannot correct; these three are the ones a user
      // most often needs to eyeball for a typo.
      expect(e.purpose).toMatch(/storage|endpoint|environment/i)
    }
  })

  it('states the SSH key is not yet enforced where it is declared, not in prose elsewhere', () => {
    const ssh = findSecret('SAIP_SSH_PRIVATE_KEY')!
    expect(ssh.scope).toMatch(/not yet|does not yet|no route/i)
    // SAIP_UI_ADMIN used to be asserted here as catalogued-with-a-caveat. It is now retired
    // entirely (#90); the surviving caveat case is the SSH key above.
    expect(findSecret('SAIP_UI_ADMIN')).toBeUndefined()
  })

  it('lists required-ness so the wizard knows what it may skip', () => {
    const required = SECRET_CATALOG.filter((e) => e.required).map((e) => e.name)
    expect(required).toEqual(expect.arrayContaining(['SAIP_R2_BUCKET', 'SAIP_R2_ENDPOINT', 'SAIP_R2_ACCESS_KEY_ID', 'SAIP_R2_SECRET_ACCESS_KEY']))
    expect(required).not.toContain('SAIP_HF_TOKEN')
    expect(required).not.toContain('SAIP_SSH_PRIVATE_KEY')
  })
})

describe('catalogFor: per-deployment view built from the user config', () => {
  const config = {
    storage: { r2: { token_env: 'SAIP_HF_TOKEN' } },
    security: {
      api_tokens: [{ id: 'alice', name: 'Alice', token_secret: 'SAIP_TOKEN_ALICE' }],
      ui: { admin_secret: 'SAIP_UI_ADMIN' },
    },
  }

  it('always includes the core storage secrets', () => {
    const list = catalogFor({ config: {}, hosts: [] })
    for (const n of ['SAIP_R2_BUCKET', 'SAIP_R2_ENDPOINT', 'SAIP_R2_ACCESS_KEY_ID', 'SAIP_R2_SECRET_ACCESS_KEY']) {
      expect(list.map((e) => e.name)).toContain(n)
    }
  })

  it('adds an entry for a token secret named in config, sensitive by declaration and NOT flagged inferred', () => {
    const list = catalogFor({ config, hosts: [] })
    const alice = list.find((e) => e.name === 'SAIP_TOKEN_ALICE')!
    expect(alice).toBeTruthy()
    expect(alice.sensitive).toBe(true)
    // One flag, not two: `inferred` marks a guess. "declared" is merely its absence, and a second
    // boolean would be free to contradict the first.
    expect(alice.inferred).toBeFalsy()
    expect(alice.purpose).toMatch(/Alice/)
  })

  it('sensitivityOf reports declared versus inferred rather than pretending both are facts', () => {
    expect(sensitivityOf('SAIP_R2_BUCKET')).toEqual({ sensitive: false, declared: true })
    // Retired but still known: the value stays masked because we know it is a credential (#90).
    expect(sensitivityOf('SAIP_UI_ADMIN')).toEqual({ sensitive: true, declared: true })
    // A name the catalog has never seen, that LOOKS like a credential: the heuristic applies,
    // and `declared: false` is what stops the UI presenting a guess as a fact.
    const odd = sensitivityOf('SAIP_ACME_API_KEY')
    expect(odd).toEqual({ sensitive: true, declared: false })
    // And a name that looks ordinary is not treated as a secret either way.
    expect(sensitivityOf('SAIP_ACME_REGION')).toEqual({ sensitive: false, declared: false })
  })

  it('never repeats a name, whatever the config says', () => {
    const cfg = { ...config, storage: { r2: { token_env: 'SAIP_HF_TOKEN' } } }
    const list = catalogFor({ config: cfg, hosts: [{ name: 'hs', kind: 'hyperstack' }] })
    const out = list.map((e) => e.name)
    expect(new Set(out).size).toBe(out.length)
  })

  it('exposes usedBy so a command can say what reads a secret and why', () => {
    const e = findSecret('SAIP_R2_ACCESS_KEY_ID')!
    expect(e.usedBy).toEqual(expect.arrayContaining(['config init']))
    expect(e.usedBy.every((c) => typeof c === 'string')).toBe(true)
  })

  it('accepts a per-entry sensitivity override for names outside the catalog, marked as inferred', () => {
    const extra: SecretEntry = {
      name: 'MY_ODD_NAME', sensitive: true, required: false, purpose: 'x'.repeat(25), how: 'y'.repeat(15),
      usedBy: ['config init'], docsUrl: 'https://example.invalid', inferred: true,
    }
    const list = catalogFor({ config: {}, hosts: [], extra: [extra] })
    const e = list.find((x) => x.name === 'MY_ODD_NAME')!
    expect(e.sensitive).toBe(true)
    expect(e.inferred).toBe(true)
    expect(findSecret('MY_ODD_NAME')).toBeUndefined()
  })
})

describe('retired secrets (#90)', () => {
  it('SAIP_UI_ADMIN is no longer catalogued or asked about', () => {
    expect(findSecret('SAIP_UI_ADMIN')).toBeUndefined()
    expect(SECRET_CATALOG.map((e) => e.name)).not.toContain('SAIP_UI_ADMIN')
    const list = catalogFor({ config: { security: { ui: { admin_secret: 'SAIP_UI_ADMIN' } } }, hosts: [] })
    expect(list.map((e) => e.name)).not.toContain('SAIP_UI_ADMIN')
  })

  it('names it as retired, with the reason, so tooling can say why it stopped asking', () => {
    const retired = RETIRED_SECRETS.find((r) => r.name === 'SAIP_UI_ADMIN')
    expect(retired).toBeTruthy()
    expect(retired!.reason).toMatch(/no UI route|never constructed|no route/i)
    expect(retired!.since).toMatch(/#90/)
  })

  it('still classifies a leftover stored value as sensitive', () => {
    // Retired does not mean harmless: the value is still a password sitting in the store.
    expect(sensitivityOf('SAIP_UI_ADMIN').sensitive).toBe(true)
  })
})
