/**
 * `config set` must verify the STORE it wrote, not the resolution chain (#146).
 *
 * The defect is a false failure: `SecretAccess.read()` walks `ChainSecrets([EnvSecrets, Store])`
 * (`shared/src/secret-access.ts:117`), so with `SAIP_R2_BUCKET` exported the read-back after a
 * successful write returned the *shell shadow*, compared it against the value just stored, and
 * reported `did not persist as written` with exit 1 — while `config get` one moment later showed the
 * value was in fact stored. Chain order is right for "what would the platform use?" and wrong for
 * "did my write land?", and using one instrument for both questions trains users to distrust a store
 * that is working.
 *
 * These drive the assembled binary with a real environment variable in the child's env, because no
 * injected fake can reproduce "the shell is shadowing the store" — the shadowing IS the bug.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runConfig, buildStore } from '../src/commands/config.js'
import { SecretAccess } from '@saip/shared'

const here = dirname(fileURLToPath(import.meta.url))
const distBin = join(here, '..', 'dist', 'bin.js')
const built = existsSync(distBin)

const shellShadow = 'shadowing-value-from-shell'
const storedValue = 'new-bucket-real'

function isolated(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'saip-verify-'))
  return {
    dir,
    env: {
      ...process.env,
      HOME: join(dir, 'home'),
      SAIP_CONFIG: join(dir, 'saip.yaml'),
      SAIP_ENV_FILE: join(dir, '.env'),
      SAIP_SECRETS_FILE: join(dir, 'secrets.enc.json'),
      SAIP_HOSTS_FILE: join(dir, 'hosts.yaml'),
      SAIP_SECRETS_PASSPHRASE: 'spike-passphrase',
      ...extra,
    } as NodeJS.ProcessEnv,
  }
}

describe('config set verifies what it wrote, through a shadowing shell (#146)', () => {
  it.skipIf(!built)('exits 0 and reports stored when the same name is exported in the environment', () => {
    const c = isolated({ SAIP_R2_BUCKET: shellShadow })
    const r = spawnSync(process.execPath, [distBin, 'config', 'set', 'SAIP_R2_BUCKET', '--stdin'], {
      encoding: 'utf8', env: c.env, cwd: c.dir, input: storedValue + '\n',
    })
    const out = r.stdout + r.stderr
    // The reported symptom, pinned so it cannot come back: a successful write must not fail.
    expect(out).not.toMatch(/did not persist/i)
    expect(r.status).toBe(0)
    expect(out).toMatch(new RegExp(`stored ${'SAIP_R2_BUCKET'}`))
  })

  it.skipIf(!built)('says the value is shadowed, as a note, without failing the write', () => {
    const c = isolated({ SAIP_R2_BUCKET: shellShadow })
    const r = spawnSync(process.execPath, [distBin, 'config', 'set', 'SAIP_R2_BUCKET', '--stdin'], {
      encoding: 'utf8', env: c.env, cwd: c.dir, input: storedValue + '\n',
    })
    const out = r.stdout + r.stderr
    expect(out).toMatch(/also set in your shell/)
    expect(out).toMatch(/still wins/)
    expect(out).toMatch(/unset SAIP_R2_BUCKET/)          // the actionable half
    expect(r.status).toBe(0)                             // and it is still a success
  })

  it.skipIf(!built)('does NOT mention shadowing when nothing in the environment matches', () => {
    const c = isolated()
    delete c.env.SAIP_R2_BUCKET
    const r = spawnSync(process.execPath, [distBin, 'config', 'set', 'SAIP_R2_BUCKET', '--stdin'], {
      encoding: 'utf8', env: c.env, cwd: c.dir, input: storedValue + '\n',
    })
    const out = r.stdout + r.stderr
    expect(r.status).toBe(0)
    // A note printed when there is nothing to note is its own kind of noise, and would make people
    // stop reading the notes.
    expect(out).not.toMatch(/also set in your shell/)
  })

  it.skipIf(!built)('the value really is in the store afterwards (get agrees with set)', () => {
    const c = isolated({ SAIP_R2_BUCKET: shellShadow })
    spawnSync(process.execPath, [distBin, 'config', 'set', 'SAIP_R2_BUCKET', '--stdin'], {
      encoding: 'utf8', env: c.env, cwd: c.dir, input: storedValue + '\n',
    })
    const g = spawnSync(process.execPath, [distBin, 'config', 'get', 'SAIP_R2_BUCKET', '--reveal'], {
      encoding: 'utf8', env: c.env, cwd: c.dir,
    })
    const out = g.stdout + g.stderr
    // `get` deliberately follows the CHAIN, so it shows the shell value and must label it. Resolution
    // and verification are different questions (#146) and this pins that the fix did not swap them.
    expect(out).toMatch(/from shell environment/)
    expect(out).toContain(shellShadow)
    // Directly against the store file, the stored value is there.
    const raw = readFileSync(c.env.SAIP_SECRETS_FILE!, 'utf8')
    expect(raw).not.toContain(storedValue)              // encrypted at rest — the value must not appear
    expect(raw).toMatch(/"v":\s*2|iv|tag/)              // a v2 envelope, not a plaintext file
  })
})

describe('the distinction is enforced at the seam too, not only in the binary', () => {
  it('a store-only read is available so verification cannot accidentally use the chain', async () => {
    const c = isolated({ SAIP_R2_BUCKET: shellShadow })
    const store = buildStore({ env: c.env, storePath: join(c.dir, 'store.enc.json'), prompt: async () => 'x' } as never)
    await store.set('SAIP_R2_BUCKET', storedValue)
    const access = new SecretAccess(store, c.env)
    access.declare('config set', [{ name: 'SAIP_R2_BUCKET', purpose: 'test' }])
    await access.unlock()
    // Chain read: the shadow. This is what the bug compared against the written value.
    expect(await access.read('SAIP_R2_BUCKET')).toBe(shellShadow)
    // Store read: what was written. If this method is ever removed, the compiler fails before the
    // false-failure behaviour can return.
    expect(await access.readStored('SAIP_R2_BUCKET')).toBe(storedValue)
  })

  it('a genuine persistence failure is still reported (the guard is not just a silence)', async () => {
    const c = isolated()
    const lines: string[] = []
    const res = await runConfig(buildStore({ env: c.env, storePath: join(c.dir, 's.enc.json'), prompt: async () => 'x' } as never),
      { value: 'second-value' }, ['set', 'SAIP_X'],
      // `prompt` is supplied because the store does not exist yet and the create path asks for a
      // passphrase through the injectable prompt — without it the case fails on NoTerminalError, which
      // is a test-setup fault, not the behaviour under test.
      { env: c.env, prompt: async () => 'x', access: { declare() {}, unlock: async () => ({ ok: true }), read: async () => 'other', readStored: async () => undefined } } as never)
    for (const b of res.blocks) void b
    lines.push(res.lines.join(' '))
    expect(res.code).toBe(1)
    expect(lines.join(' ')).toMatch(/did not persist/i)
  })
})
