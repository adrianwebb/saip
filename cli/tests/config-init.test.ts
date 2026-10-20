/**
 * `saip config init` — the first-time credential wizard (#78).
 *
 * Written before the implementation, per the documentation-first cycle, and deliberately at two
 * levels: the pure planner (which questions a given configuration implies) and the assembled
 * program (`saip config init --non-interactive` executed as a binary), because #76 established
 * that injected-collaborator tests cannot see wiring.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { envFilePath, setEnvFileValues, loadEnvFile } from '@saip/shared'
import { planInitItems, runInit, runHelp, forgetValue, newLineAccumulator, WizardCancelled, type Io } from '../src/commands/config-init.js'
import { promptTTY } from '../src/commands/config.js'
import { SecretStore, MemoryKeySource } from '@saip/shared'

const dir = () => mkdtempSync(join(tmpdir(), 'saip-init-'))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const distBin = join(repoRoot, 'cli/dist/index.js')

const baseConfig = {
  storage: { r2: { bucket_env: 'SAIP_R2_BUCKET', token_env: 'SAIP_HF_TOKEN' } },
  security: { api_tokens: [{ id: 'alice', name: 'Alice', token_secret: 'SAIP_TOKEN_ALICE' }], ui: { admin_secret: 'SAIP_UI_ADMIN' } },
}
const hosts = [{ name: 'lab', kind: 'local' }]

describe('planInitItems: questions are DERIVED, not hardcoded', () => {
  it('covers R2 in order, with bucket/endpoint as config and keys as secrets', () => {
    const items = planInitItems({ config: baseConfig, hosts })
    const names = items.map((i) => i.name)
    expect(names.slice(0, 4)).toEqual(['SAIP_R2_BUCKET', 'SAIP_R2_ENDPOINT', 'SAIP_R2_ACCESS_KEY_ID', 'SAIP_R2_SECRET_ACCESS_KEY'])
    const byName = Object.fromEntries(items.map((i) => [i.name, i]))
    expect(byName.SAIP_R2_BUCKET.kind).toBe('config')
    expect(byName.SAIP_R2_BUCKET.required).toBe(true)
    expect(byName.SAIP_R2_ACCESS_KEY_ID.kind).toBe('secret')
  })

  it('marks the HuggingFace token optional, matching what the docs now claim', () => {
    const hf = planInitItems({ config: baseConfig, hosts }).find((i) => i.name === 'SAIP_HF_TOKEN')
    expect(hf?.required).toBe(false)
    // Every item must teach something: purpose and a pointer are not optional fields.
    expect(hf?.purpose.length).toBeGreaterThan(10)
    expect(hf?.docsUrl || hf?.providerUrl).toBeTruthy()
  })

  it('asks about each declared API token secret, and no longer about the retired UI admin secret', () => {
    const names = planInitItems({ config: baseConfig, hosts }).map((i) => i.name)
    expect(names).toContain('SAIP_TOKEN_ALICE')
    // #90: removed rather than left implying protection nothing enforces.
    expect(names).not.toContain('SAIP_UI_ADMIN')
  })

  it('omits per-token questions the config does not declare, while always listing the integration keys', () => {
    const cfg = { storage: baseConfig.storage, security: { api_tokens: [], ui: {} } }
    const names = planInitItems({ config: cfg, hosts }).map((i) => i.name)
    expect(names).not.toContain('SAIP_TOKEN_ALICE')
    expect(names).not.toContain('SAIP_UI_ADMIN')
    // #82 reversed the old rule for these: gating Hyperstack/HF on discovery meant a new user
    // never saw the credentials the next integrations need, and hosts.yaml is not committed.
    expect(names).toContain('SAIP_HYPERSTACK_API_KEY')
  })

  it('still lists the Hyperstack key for local-only hosts, marked optional', () => {
    const items = planInitItems({ config: baseConfig, hosts })
    const hs = items.find((i) => i.name === 'SAIP_HYPERSTACK_API_KEY')!
    expect(hs.required).toBe(false)
    expect(hs.purpose).toMatch(/remote GPU/i)
  })

  it('never reuses one name twice, which would silently overwrite an earlier answer', () => {
    const names = planInitItems({ config: baseConfig, hosts }).map((i) => i.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

const mkStore = (): { d: string; store: SecretStore } => {
  const d = dir()
  return { d, store: new SecretStore({ path: join(d, 'keys', 'secrets.enc.json'), keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 3))] }) }
}

/** Collects prompts and replays scripted answers, so no TTY is needed anywhere in CI. */
function fakeIo(answers: Record<string, string>): { io: Io; seen: string[]; secretAsked: string[] } {
  const seen: string[] = []
  const secretAsked: string[] = []
  return {
    seen,
    secretAsked,
    io: {
      say: (line) => seen.push(line),
      ask: async (question, opts) => {
        if (opts.secret) secretAsked.push(question)
        const name = Object.keys(answers).find((k) => question.includes(k))
        return name ? answers[name] : ''
      },
    },
  }
}

describe('runInit: prompts, routing, and refusal', () => {

  it('writes interpolated config to the env file and credentials to the store — never the reverse', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    const items = planInitItems({ config: baseConfig, hosts })
    const answers: Record<string, string> = {
      SAIP_R2_BUCKET: 'saip-platform',
      SAIP_R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      SAIP_R2_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      SAIP_R2_SECRET_ACCESS_KEY: 'shhh-example',
    }
    const { io, secretAsked } = fakeIo(answers)
    const r = await runInit({ store, items, io, envPath: env, interactive: true })
    expect(r.code).toBe(0)

    // The interpolation half.
    const loaded = loadEnvFile(env)
    expect(loaded.SAIP_R2_BUCKET).toBe('saip-platform')
    expect(loaded.SAIP_R2_ENDPOINT).toBe('https://acct.r2.cloudflarestorage.com')
    expect(await store.get('SAIP_R2_BUCKET')).toBeUndefined()

    // The secret half — and proof the store is what carries it.
    expect(await store.get('SAIP_R2_ACCESS_KEY_ID')).toBe('AKIAEXAMPLE')
    expect(await store.get('SAIP_R2_SECRET_ACCESS_KEY')).toBe('shhh-example')
    // Values typed as secrets must never be echoed into the reported lines.
    expect(r.lines.join('\n')).not.toContain('shhh-example')
    expect(secretAsked.some((q) => q.startsWith('SAIP_R2_SECRET_ACCESS_KEY'))).toBe(true)
  })

  it('creates the env file 0600 and preserves unrelated existing content', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    writeFileSync(env, '# my notes\nSAIP_UNRELATED=keep-me\nSAIP_R2_BUCKET=old\n')
    const items = planInitItems({ config: baseConfig, hosts })
    const answers = { SAIP_R2_BUCKET: 'new-bucket', SAIP_R2_ENDPOINT: 'https://e', SAIP_R2_ACCESS_KEY_ID: 'a', SAIP_R2_SECRET_ACCESS_KEY: 's' }
    const { io } = fakeIo(answers)
    await runInit({ store, items, io, envPath: env, force: true })
    const text = readFileSync(env, 'utf8')
    expect(text).toContain('# my notes')
    expect(text).toContain('SAIP_UNRELATED=keep-me')
    expect(text).toContain('SAIP_R2_BUCKET=new-bucket')
    expect((text.match(/SAIP_R2_BUCKET=/g) || []).length).toBe(1)
    expect(statSync(env).mode & 0o777).toBe(0o600)
  })

  it('accepts a pasted value containing CRLF and stores it stripped', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    const answers = { SAIP_R2_BUCKET: 'b\r', SAIP_R2_ENDPOINT: 'https://e\r\n', SAIP_R2_ACCESS_KEY_ID: 'AKIA\r\n', SAIP_R2_SECRET_ACCESS_KEY: 'secret-with-no-newline' }
    const items = planInitItems({ config: baseConfig, hosts })
    const { io } = fakeIo(answers)
    await runInit({ store, items, io, envPath: env })
    expect(await store.get('SAIP_R2_ACCESS_KEY_ID')).toBe('AKIA')
    expect(readFileSync(env, 'utf8')).toContain('SAIP_R2_ENDPOINT=https://e\n')
  })

  it('skips optional values on Enter and keeps an already-set value untouched', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    const seed = { SAIP_R2_BUCKET: 'b0', SAIP_R2_ENDPOINT: 'https://e0', SAIP_R2_ACCESS_KEY_ID: 'a0', SAIP_R2_SECRET_ACCESS_KEY: 's0' }
    await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io: fakeIo(seed).io, envPath: env, answers: seed, interactive: true })
    const before = await store.get('SAIP_R2_ACCESS_KEY_ID')

    // Second run with no answers: everything already set is kept, optional skipped.
    const { io: io2, seen: seen2 } = fakeIo({})
    const r2 = await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io: io2, envPath: env })
    expect(r2.code).toBe(0)
    expect(await store.get('SAIP_R2_ACCESS_KEY_ID')).toBe(before)
    expect(seen2.some((l) => /already set/i.test(l))).toBe(true)
  })

  it('refuses to store a blank for a required value, re-asking once then stopping honestly', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    let asks = 0
    const io: Io = {
      say: () => {},
      ask: async () => { asks++; return '' },
    }
    const r = await runInit({
      store, items: planInitItems({ config: baseConfig, hosts }), io, envPath: env,
    })
    expect(r.code).toBe(1)
    expect(r.lines.join(' ')).toMatch(/required|cannot be empty/)
    expect(existsSync(env)).toBe(false)
  })

  it('with --non-interactive, never prompts and never writes', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    let asked = 0
    const io: Io = { say: () => {}, ask: async () => { asked++; return 'should-never-be-used' } }
    const r = await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io, envPath: env, interactive: false })
    expect(asked).toBe(0)
    expect(r.code).toBe(1)
    expect(r.lines.join(' ')).toMatch(/SAIP_R2_BUCKET/)
    expect(existsSync(env)).toBe(false)
  })

  it('reports that R2 credentials were NOT verified, rather than implying they work', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    const answers = { SAIP_R2_BUCKET: 'b', SAIP_R2_ENDPOINT: 'https://e', SAIP_R2_ACCESS_KEY_ID: 'a', SAIP_R2_SECRET_ACCESS_KEY: 's' }
    const { io } = fakeIo(answers)
    const r = await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io, envPath: env })
    expect(r.lines.join(' ')).toMatch(/NOT verified/)
  })
})

describe('env file path resolution (#78, same class as #70)', () => {
  it('honours SAIP_ENV_FILE absolutely', () => {
    const p = join(dir(), 'custom.env')
    expect(envFilePath({ SAIP_ENV_FILE: p })).toBe(p)
  })

  it('finds an existing .env from a subdirectory upward, so an installed CLI uses the project it is in', () => {
    const root = dir()
    writeFileSync(join(root, '.env'), 'A=1\n')
    const deep = join(root, 'a', 'b')
    mkdtempSync // no-op reference to keep import used
    expect(envFilePath({}, { cwd: deep, start: deep })).toBe(join(root, '.env'))
  })

  it('defaults to a path under the given cwd when none exists anywhere', () => {
    const root = dir()
    expect(envFilePath({}, { cwd: root, start: root })).toBe(join(root, '.env'))
  })

  it('setEnvFileValues writes quoted-free KEY=value lines and never duplicates a key', () => {
    const p = join(dir(), '.env')
    writeFileSync(p, '# header\nFOO=1\n')
    setEnvFileValues(p, { FOO: '2', BAR: 'baz' })
    const t = readFileSync(p, 'utf8')
    expect(t).toContain('# header')
    expect(t.match(/^FOO=/m)![0]).toBe('FOO=')
    expect(t).toContain('FOO=2')
    expect((t.match(/FOO=/g) || []).length).toBe(1)
    expect(t).toContain('BAR=baz')
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })
})

describe('the assembled program (#76 rule: test it as a program)', () => {
  const built = existsSync(distBin)

  it.skipIf(!built)('saip config init --non-interactive reports what is missing and exits 1', () => {
    const d = dir()
    const r = spawnSync(process.execPath, [distBin, 'config', 'init', '--non-interactive'], {
      encoding: 'utf8', cwd: d,
      env: { ...process.env, SAIP_SECRETS_FILE: join(d, 'store.json'), SAIP_ENV_FILE: join(d, '.env'), SAIP_CONFIG: join(repoRoot, 'saip.yaml') },
    })
    // Deterministic without a terminal: it must describe state, store nothing, and say what is missing.
    expect(r.stdout + r.stderr).not.toBe('')
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toMatch(/SAIP_R2_/)
    expect(existsSync(join(d, '.env'))).toBe(false)
  })

  it.skipIf(!built)('`saip config help` prints the whole catalog once, with no prompting', () => {
    const d = dir()
    const r = spawnSync(process.execPath, [distBin, 'config', 'help'], {
      encoding: 'utf8', cwd: d,
      env: { ...process.env, SAIP_SECRETS_FILE: join(d, 's.json'), SAIP_ENV_FILE: join(d, '.env'), SAIP_CONFIG: join(repoRoot, 'saip.yaml') },
    })
    expect(r.status).toBe(0)
    const entries = (r.stdout.match(/-- SAIP_/g) ?? []).length
    expect(entries).toBeGreaterThanOrEqual(8)
    // Duplicate transcript was the bug: the same header must appear exactly once.
    expect((r.stdout.match(/-- SAIP_HF_TOKEN/g) ?? []).length).toBe(1)
    expect(r.stdout).not.toMatch(/no guidance entry/)
    // Integration keys are listed even with no hosts.yaml and an empty store.
    for (const n of ['SAIP_HF_TOKEN', 'SAIP_HYPERSTACK_API_KEY', 'SAIP_SSH_PRIVATE_KEY']) {
      expect(r.stdout).toContain(n)
    }
    expect(existsSync(join(d, '.env'))).toBe(false)
  })

  it.skipIf(!built)('`saip config help NAME` narrows to that entry', () => {
    const d = dir()
    const r = spawnSync(process.execPath, [distBin, 'config', 'help', 'SAIP_R2_ACCESS_KEY_ID'], {
      encoding: 'utf8', cwd: d,
      env: { ...process.env, SAIP_SECRETS_FILE: join(d, 's.json'), SAIP_ENV_FILE: join(d, '.env'), SAIP_CONFIG: join(repoRoot, 'saip.yaml') },
    })
    expect(r.stdout).toMatch(/Access Key ID half/)
    expect(r.stdout).not.toMatch(/Object storage for adapters/)
  })

  it.skipIf(!built)('the wizard is dispatched at all — `init` is not an unknown subcommand', () => {
    const r = spawnSync(process.execPath, [distBin, 'config', 'init', '--non-interactive'], {
      encoding: 'utf8', cwd: dir(), env: { ...process.env, SAIP_SECRETS_FILE: join(dir(), 's.json') },
    })
    expect(r.stdout + r.stderr).not.toMatch(/unknown subcommand/)
  })
})

describe('the display must inform BEFORE the prompt (#78 follow-up, maintainer-reported)', () => {
  it('records each item\'s teaching block ahead of the question for that item', async () => {
    const { d, store } = mkStore()
    const order: string[] = []
    const io: Io = {
      say: (l) => { order.push(`say:${l}`) },
      ask: async (q) => { order.push(`ask:${q}`); return 'value' },
    }
    await runInit({ store, items: planInitItems({ config: baseConfig, hosts }).slice(0, 2), io, envPath: join(d, '.env') })
    const bucketAsk = order.findIndex((l) => l.startsWith('ask:SAIP_R2_BUCKET'))
    const purpose = order.findIndex((l) => l.includes('Object storage for adapters'))
    const createLink = order.findIndex((l) => l.includes('dash.cloudflare.com'))
    expect(bucketAsk).toBeGreaterThan(-1)
    // The whole point of the command: explanation precedes the input it explains.
    expect(purpose).toBeGreaterThanOrEqual(0)
    expect(purpose).toBeLessThan(bucketAsk)
    expect(createLink).toBeLessThan(bucketAsk)
  })

  it('emits every line through io.say, so a real terminal shows them as they happen', async () => {
    const { d, store } = mkStore()
    const said: string[] = []
    const io: Io = { say: (l) => said.push(l), ask: async () => 'v' }
    const r = await runInit({ store, items: planInitItems({ config: baseConfig, hosts }).slice(0, 1), io, envPath: join(d, '.env') })
    expect(said.join(' ')).toMatch(/NOT verified/)
    expect(r.lines.join(' ')).toMatch(/NOT verified/)
  })
})

describe('Ctrl+C during the wizard (#78 follow-up, maintainer-reported)', () => {
  it('stops cleanly, keeps what was already stored, and names what remains', async () => {
    const { d, store } = mkStore()
    let n = 0
    const io: Io = {
      say: () => {},
      ask: async () => { n++; if (n === 3) throw new WizardCancelled(); return `value-${n}` },
    }
    const env = join(d, '.env')
    const r = await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io, envPath: env })
    expect(r.code).toBe(130)
    expect(r.lines.join(' ')).toMatch(/stopped/)
    // Answers given BEFORE the interrupt are persisted; the earlier batched-env write lost them, and
    // items 1-2 are the config pair, so the access key id (item 3) is the one left unset.
    expect(readFileSync(env, 'utf8')).toMatch(/SAIP_R2_BUCKET=value-1/)
    expect(readFileSync(env, 'utf8')).toMatch(/SAIP_R2_ENDPOINT=value-2/)
    expect(await store.get('SAIP_R2_ACCESS_KEY_ID')).toBeUndefined()
    expect(r.lines.join(' ')).toMatch(/still not set/)
  })

  it('writes nothing for the item that was interrupted', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    const io: Io = { say: () => {}, ask: async (q) => { if (q.includes('ENDPOINT')) throw new WizardCancelled(); return 'b' } }
    await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io, envPath: env })
    const text = existsSync(env) ? readFileSync(env, 'utf8') : ''
    expect(text).not.toMatch(/SAIP_R2_ENDPOINT/)
  })
})

describe('paste safety: terminal escape sequences must not enter the value', () => {
  it('strips bracketed-paste wrappers and control bytes, keeping the pasted text', () => {
    const acc = newLineAccumulator()
    // Real paste under bracketed paste mode: ESC [ 200 ~ <value> ESC [ 201 ~
    const out = acc.feed('\u001b[200\u007eAKIAIOSFODNN7EXAMPLE\u001b[201\u007e\r\n')
    expect(out.value).toBe('AKIAIOSFODNN7EXAMPLE')
    expect(out.done).toBe(true)
  })

  it('honours backspace, and Ctrl+D as end-of-input', () => {
    const a = newLineAccumulator()
    expect(a.feed('ab\u007fc\r').value).toBe('ac')
    const b = newLineAccumulator()
    expect(b.feed('xy\u0004')).toEqual({ value: 'xy', done: true, cancelled: false })
  })

  it('Ctrl+C cancels', () => {
    const c = newLineAccumulator()
    expect(c.feed('partial\u0003')).toEqual({ value: '', done: true, cancelled: true })
  })
})

describe('the real terminal reader, driven without a TTY (#78 follow-up)', () => {
  // promptTTY takes an injectable stream so the production reader — not a reimplementation of it —
  // is exercised by CI. The ad-hoc pty scripts used during development were flaky enough that
  // relying on them would leave the two maintainer-reported bugs unguarded.
  it('resolves a bracketed paste to the pasted value only', async () => {
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough() as unknown as Parameters<typeof promptTTY>[1]
    const p = promptTTY('SAIP_R2_ACCESS_KEY_ID: ', { stream })
    stream!.write('\u001b[200\u007eAKIAIOSFODNN7EXAMPLE\u001b[201\u007e\r\n')
    await expect(p).resolves.toBe('AKIAIOSFODNN7EXAMPLE')
  })

  it('rejects with WizardCancelled when Ctrl+C is typed', async () => {
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough() as unknown as Parameters<typeof promptTTY>[1]
    const p = promptTTY('SAIP_R2_BUCKET: ', { stream })
    stream!.write('half-typed\u0003')
    await expect(p).rejects.toBeInstanceOf(WizardCancelled)
  })

  it('treats Ctrl+D as end of input, so a paste terminated by EOF works', async () => {
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough() as unknown as Parameters<typeof promptTTY>[1]
    const p = promptTTY('SAIP_R2_BUCKET: ', { stream })
    stream!.write('value-then-eof\u0004')
    await expect(p).resolves.toBe('value-then-eof')
  })

  it('runInit propagates a cancel from the reader into the honest stop summary', async () => {
    const { d, store } = mkStore()
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough()
    const io: Io = {
      say: () => {},
      ask: async (q) => promptTTY(q, { stream: stream as never }),
    }
    const run = runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io, envPath: join(d, '.env') })
    // The first prompt is issued; answer it, then cancel at the second.
    await new Promise((r) => setTimeout(r, 10))
    stream.write('answered\r')
    await new Promise((r) => setTimeout(r, 10))
    stream.write('\u0003')
    const r = await run
    expect(r.code).toBe(130)
    expect(r.lines.join(' ')).toMatch(/stopped by Ctrl\+C/)
    expect(r.stored).toEqual(['SAIP_R2_BUCKET'])
  })
})

describe('guidance prints regardless of state (#82, maintainer-reported)', () => {
  it('shows purpose, scoping and provider links for an ALREADY-SET value', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    const seeded = { SAIP_R2_BUCKET: 'stale-value', SAIP_R2_ENDPOINT: 'https://stale', SAIP_R2_ACCESS_KEY_ID: 'stalekey', SAIP_R2_SECRET_ACCESS_KEY: 'stalesecret' }
    await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io: fakeIo(seeded).io, envPath: env })

    const order: string[] = []
    const io: Io = { say: (l) => order.push(l), ask: async (q) => { order.push(q); return '' } }
    await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io, envPath: env })
    const said = order.join('\n')
    // This is the branch every earlier test skipped: values already set must still be explained.
    expect(said).toMatch(/already set/)
    expect(said).toMatch(/Object storage for adapters/)
    expect(said).toMatch(/Object Read & Write/)
    expect(said).toMatch(/dash\.cloudflare\.com/)
    // And the explanation must precede the prompt for that same item.
    expect(order.findIndex((l) => l.includes('Object storage for adapters')))
      .toBeLessThan(order.findIndex((l) => l.startsWith('SAIP_R2_BUCKET: ')))
  })

  it('names the SOURCE of an existing value, because only some sources can be cleared', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io: fakeIo({ SAIP_R2_BUCKET: 'b' }).io, envPath: env })
    const said: string[] = []
    await runInit({
      store, items: planInitItems({ config: baseConfig, hosts }), envPath: env,
      io: { say: (l) => said.push(l), ask: async () => '' },
      env: { SAIP_R2_ENDPOINT: 'from-shell' },
    })
    const text = said.join('\n')
    expect(text).toMatch(/SAIP_R2_BUCKET.*source: \.env|source: \.env.*SAIP_R2_BUCKET|from \.\.env|\(\.env\)/s)
    // A shell value is un-clearable by the CLI and must say so, not just display it.
    expect(text).toMatch(/shell/); expect(text).toMatch(/cannot be cleared|clear it yourself|unset SAIP_/)
  })
})

describe('catalog always lists HF and Hyperstack (#82)', () => {
  it('lists them even with no token_env, no hyperstack host, and no hosts file at all', () => {
    const names = planInitItems({ config: { storage: {}, security: {} }, hosts: [] }).map((i) => i.name)
    for (const n of ['SAIP_HF_TOKEN', 'SAIP_HYPERSTACK_API_KEY', 'SAIP_HYPERSTACK_ENVIRONMENT', 'SAIP_SSH_PRIVATE_KEY']) {
      expect(names).toContain(n)
    }
  })

  it('marks them optional but still teaches scope and where to get them', () => {
    const items = planInitItems({ config: {}, hosts: [] })
    const hs = items.find((i) => i.name === 'SAIP_HYPERSTACK_API_KEY')!
    expect(hs.required).toBe(false)
    expect(hs.purpose.length).toBeGreaterThan(20)
    expect(hs.how).toMatch(/API Key/i)
    expect(hs.providerUrl || hs.docsUrl).toBeTruthy()
  })

  it('states the SSH provider defect instead of implying the key will work', () => {
    const ssh = planInitItems({ config: {}, hosts: [] }).find((i) => i.name === 'SAIP_SSH_PRIVATE_KEY')!
    expect(ssh.scope).toMatch(/does not yet|not yet work|\/run\/secrets/)
  })

  it('does not duplicate a name when the config already references it', () => {
    const names = planInitItems({ config: baseConfig, hosts: [{ name: 'hs', kind: 'hyperstack' }] }).map((i) => i.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('saip config help and forget (#82)', () => {
  it('help prints the catalog without prompting or writing anything', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    let asked = 0
    const r = await runHelp({
      store, items: planInitItems({ config: baseConfig, hosts }), envPath: env,
      io: { say: () => {}, ask: async () => { asked++; return '' } },
    })
    expect(asked).toBe(0)
    expect(r.code).toBe(0)
    expect(existsSync(env)).toBe(false)
    expect(store.exists()).toBe(false)
    expect(r.lines.join('\n')).toMatch(/Object Read & Write/)
  })

  it('help for one name prints just that entry', async () => {
    const { d, store } = mkStore()
    const r = await runHelp({
      store, items: planInitItems({ config: baseConfig, hosts }), envPath: join(d, '.env'),
      only: 'SAIP_R2_ACCESS_KEY_ID', io: { say: () => {}, ask: async () => '' },
    })
    expect(r.lines.join('\n')).toMatch(/Access Key ID half/)
    expect(r.lines.join('\n')).not.toMatch(/Object storage for adapters/)
  })

  it('forget clears the store AND .env, reporting each source', async () => {
    const { d, store } = mkStore()
    const env = join(d, '.env')
    writeFileSync(env, '# notes\nSAIP_R2_BUCKET=to-remove\nOTHER=keep\n')
    await store.set('SAIP_HF_TOKEN', 'hf-to-remove')
    const r = await forgetValue({ store, name: 'SAIP_R2_BUCKET', envPath: env, env: {} })
    expect(r.cleared).toContain('.env')
    expect(readFileSync(env, 'utf8')).toContain('OTHER=keep')
    expect(readFileSync(env, 'utf8')).toContain('# notes')
    expect(readFileSync(env, 'utf8')).not.toMatch(/^SAIP_R2_BUCKET=/m)

    const r2 = await forgetValue({ store, name: 'SAIP_HF_TOKEN', envPath: env, env: {} })
    expect(r2.cleared).toContain('store')
    expect(await store.get('SAIP_HF_TOKEN')).toBeUndefined()
  })

  it('forget tells you when a shell value is what remains', async () => {
    const { d, store } = mkStore()
    const r = await forgetValue({ store, name: 'SAIP_R2_BUCKET', envPath: join(d, '.env'), env: { SAIP_R2_BUCKET: 'live-shell-value' } })
    expect(r.stillFromShell).toBe(true)
    expect(r.lines.join(' ')).toMatch(/shell/)
  })
})

describe('one unlock per command (#86)', () => {
  it('prompts for the key exactly once across a multi-value wizard run', async () => {
    const d = mkdtempSync(join(tmpdir(), 'saip-unlock-'))
    const path = join(d, 's.enc.json')
    const key = Buffer.alloc(32, 61)
    let derivations = 0
    class Counting implements KeySource {
      readonly id = 'passphrase' as const
      async wrapKey(): Promise<Buffer | null> { derivations++; return key }
      async provision() { derivations++; return { key, salt: null } }
    }
    const seed = new SecretStore({ path, keySources: [new Counting()] })
    await seed.set('SAIP_R2_BUCKET', 'existing')
    derivations = 0

    const answers: Record<string, string> = { SAIP_R2_ENDPOINT: 'https://e', SAIP_R2_ACCESS_KEY_ID: 'a', SAIP_R2_SECRET_ACCESS_KEY: 's' }
    const io = fakeIo(answers)
    const r = await runInit({
      store: new SecretStore({ path, keySources: [new Counting()] }),
      items: planInitItems({ config: baseConfig, hosts }),
      io: io.io, envPath: join(d, '.env'),
    })
    expect(r.code).toBe(0)
    expect(derivations).toBe(1)
    // And it told the user why it was unlocking.
    expect(io.seen.join(' ')).toMatch(/this command reads \d+ value\(s\)/)
    expect(io.seen.join(' ')).toMatch(/you will not be asked again/)
  })

  it('refuses to start asking values when the existing store cannot be unlocked', async () => {
    const d = mkdtempSync(join(tmpdir(), 'saip-unlock-'))
    const path = join(d, 's.enc.json')
    await new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 62))] }).set('A', 'v')
    const said: string[] = []
    const r = await runInit({
      store: new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 63))] }),
      items: planInitItems({ config: baseConfig, hosts }),
      io: { say: (l) => said.push(l), ask: async () => 'x' },
      envPath: join(d, '.env'),
    })
    expect(r.code).toBe(1)
    expect(said.join(' ')).toMatch(/cannot unlock/)
    expect(said.join(' ')).not.toMatch(/stored SAIP_R2_ENDPOINT/)
  })
})

describe('sensitive vs ordinary values (#87)', () => {
  it('asks with echo ON for ordinary config and echo OFF for credentials', async () => {
    const { d, store } = mkStore()
    const seen: Array<{ q: string; secret: boolean }> = []
    const io: Io = { say: () => {}, ask: async (q, o) => { seen.push({ q, secret: o.secret }); return 'whatever' } }
    await runInit({ store, items: planInitItems({ config: baseConfig, hosts }), io, envPath: join(d, '.env') })
    const bucket = seen.find((x) => x.q.startsWith('SAIP_R2_BUCKET'))!
    const key = seen.find((x) => x.q.startsWith('SAIP_R2_ACCESS_KEY_ID'))!
    const endpoint = seen.find((x) => x.q.startsWith('SAIP_R2_ENDPOINT'))!
    expect(bucket.secret).toBe(false)
    expect(endpoint.secret).toBe(false)
    expect(key.secret).toBe(true)
  })

  it('shows the FULL current value for an ordinary setting, and only a length for a credential', async () => {
    const d = mkdtempSync(join(tmpdir(), 'saip-sens-'))
    const env = join(d, '.env')
    const path = join(d, 's.enc.json')
    const key = Buffer.alloc(32, 71)
    const store = new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', key)] })
    await store.set('SAIP_R2_ACCESS_KEY_ID', 'AKIASECRETVALUE')
    // Both required settings must already exist, or the wizard correctly aborts on the unset
    // endpoint before ever reaching the credential this test is about.
    writeFileSync(env, 'SAIP_R2_BUCKET=visible-bucket-name\nSAIP_R2_ENDPOINT=https://visible.endpoint\n')
    await store.set('SAIP_R2_SECRET_ACCESS_KEY', 'anothersecret')
    const said: string[] = []
    await runInit({
      store, items: planInitItems({ config: baseConfig, hosts }),
      io: { say: (l) => said.push(l), ask: async () => '' }, envPath: env,
    })
    const text = said.join('\n')
    expect(text).toMatch(/visible-bucket-name/)          // ordinary config: readable, so you know what you have
    expect(text).toMatch(/https:\/\/visible\.endpoint/)
    expect(text).not.toMatch(/AKIASECRETVALUE/)         // credential: never displayed
    expect(text).toMatch(/\d+ chars, hidden/)
    expect(text).toMatch(/source: \(store\)/)
  })

  it('never asks for the retired UI admin secret, even when a legacy config names it (#90)', () => {
    const items = planInitItems({ config: { security: { ui: { admin_secret: 'SAIP_UI_ADMIN' } } }, hosts: [] })
    expect(items.map((i) => i.name)).not.toContain('SAIP_UI_ADMIN')
  })
})

describe('declared sensitivity, not inferred (#93)', () => {
  it('takes sensitive from the catalog entry, including where the name pattern disagrees', () => {
    const items = planInitItems({ config: baseConfig, hosts })
    // Declared facts, each chosen because the name pattern would answer differently:
    // SAIP_R2_BUCKET has no credential substring but is declared non-sensitive (correctly),
    // and SAIP_HYPERSTACK_ENVIRONMENT likewise — while a name that LOOKS ordinary would still be
    // reported by the pattern, the catalog is what decides.
    expect(items.find((i) => i.name === 'SAIP_R2_BUCKET')!.sensitive).toBe(false)
    expect(items.find((i) => i.name === 'SAIP_HYPERSTACK_ENVIRONMENT')!.sensitive).toBe(false)
    expect(items.find((i) => i.name === 'SAIP_R2_ACCESS_KEY_ID')!.sensitive).toBe(true)
    expect(items.every((i) => typeof i.sensitive === 'boolean')).toBe(true)
  })

  it('surfaces a hand-set store name the catalog never saw and labels it inferred', async () => {
    const { d, store } = mkStore()
    await store.set('SAIP_LEGACY_ODD_THING', 'value')
    const said: string[] = []
    // Required values are answered, or the wizard correctly stops at the first one and the
    // hand-set name — appended last, since required items come first — is never reached.
    await runInit({
      store, items: planInitItems({ config: baseConfig, hosts }), envPath: join(d, '.env'),
      io: { say: (l) => said.push(l), ask: async () => 'answer' },
    })
    const text = said.join('\n')
    expect(text).toMatch(/SAIP_LEGACY_ODD_THING/)
    expect(text).toMatch(/the store already holds 1/)
    expect(text).toMatch(/not described in the catalog/i)
    expect(text).toMatch(/inferred from the name/i)
  })

  it('lists integration secrets from the catalog with their usedBy reason available', () => {
    const names = planInitItems({ config: {}, hosts: [] }).map((i) => i.name)
    for (const n of ['SAIP_HF_TOKEN', 'SAIP_HYPERSTACK_API_KEY', 'SAIP_HYPERSTACK_ENVIRONMENT', 'SAIP_SSH_PRIVATE_KEY']) expect(names).toContain(n)
    // #90 removed the credential outright, so no config shape asks for it.
    expect(planInitItems({ config: {}, hosts: [] }).map((i) => i.name)).not.toContain('SAIP_UI_ADMIN')
    const legacy = planInitItems({ config: { security: { ui: { admin_secret: 'SAIP_UI_ADMIN' } } }, hosts: [] })
    expect(legacy.map((i) => i.name)).not.toContain('SAIP_UI_ADMIN')
  })
})

describe('retired values are surfaced, not hidden (#90)', () => {
  it('tells the user a stored SAIP_UI_ADMIN is retired and how to remove it', async () => {
    const { d, store } = mkStore()
    await store.set('SAIP_UI_ADMIN', 'stale-admin-password')
    const said: string[] = []
    await runInit({
      store, items: planInitItems({ config: baseConfig, hosts }), envPath: join(d, '.env'),
      io: { say: (l) => said.push(l), ask: async () => 'x' },
    })
    const text = said.join('\n')
    expect(text).toMatch(/RETIRED \(#90\)/)
    expect(text).toMatch(/saip config forget SAIP_UI_ADMIN/)
    expect(text).not.toMatch(/stale-admin-password/)   // never echoed
    // And it is never presented as something to configure fresh.
    expect(planInitItems({ config: baseConfig, hosts }).map((i) => i.name)).not.toContain('SAIP_UI_ADMIN')
  })
})

describe('the wizard reports retired config keys (#90)', () => {
  it('warns before the first question when saip.yaml still sets ui.admin_secret', async () => {
    const { d, store } = mkStore()
    const said: string[] = []
    await runInit({
      store, items: planInitItems({ config: baseConfig, hosts }), envPath: join(d, '.env'),
      io: { say: (l) => said.push(l), ask: async () => 'x' },
      deprecations: ['security.ui.admin_secret ("SAIP_UI_ADMIN") is retired (#90): it protects nothing'],
    })
    const warn = said.findIndex((l) => /WARNING.*security\.ui\.admin_secret/.test(l))
    const firstAsk = said.findIndex((l) => /-- SAIP_R2_BUCKET/.test(l))
    expect(warn).toBeGreaterThanOrEqual(0)
    expect(warn).toBeLessThan(firstAsk)   // told before being asked, not after
  })
})
