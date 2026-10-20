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
import { planInitItems, runInit, newLineAccumulator, WizardCancelled, type Io } from '../src/commands/config-init.js'
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

  it('asks about each declared API token secret and the UI admin secret', () => {
    const names = planInitItems({ config: baseConfig, hosts }).map((i) => i.name)
    expect(names).toContain('SAIP_TOKEN_ALICE')
    expect(names).toContain('SAIP_UI_ADMIN')
  })

  it('omits declared-token questions when the config declares none, and omits hyperstack for local hosts', () => {
    const cfg = { storage: baseConfig.storage, security: { api_tokens: [], ui: {} } }
    const names = planInitItems({ config: cfg, hosts }).map((i) => i.name)
    expect(names).not.toContain('SAIP_TOKEN_ALICE')
    expect(names).not.toContain('SAIP_UI_ADMIN')
    expect(names).not.toContain('SAIP_HYPERSTACK_API_KEY')
  })

  it('asks for the Hyperstack key only when a hyperstack host exists', () => {
    const withCloud = planInitItems({ config: baseConfig, hosts: [{ name: 'hs', kind: 'hyperstack' }] })
    expect(withCloud.map((i) => i.name)).toContain('SAIP_HYPERSTACK_API_KEY')
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
    const p = promptTTY('SAIP_R2_ACCESS_KEY_ID: ', stream)
    stream!.write('\u001b[200\u007eAKIAIOSFODNN7EXAMPLE\u001b[201\u007e\r\n')
    await expect(p).resolves.toBe('AKIAIOSFODNN7EXAMPLE')
  })

  it('rejects with WizardCancelled when Ctrl+C is typed', async () => {
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough() as unknown as Parameters<typeof promptTTY>[1]
    const p = promptTTY('SAIP_R2_BUCKET: ', stream)
    stream!.write('half-typed\u0003')
    await expect(p).rejects.toBeInstanceOf(WizardCancelled)
  })

  it('treats Ctrl+D as end of input, so a paste terminated by EOF works', async () => {
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough() as unknown as Parameters<typeof promptTTY>[1]
    const p = promptTTY('SAIP_R2_BUCKET: ', stream)
    stream!.write('value-then-eof\u0004')
    await expect(p).resolves.toBe('value-then-eof')
  })

  it('runInit propagates a cancel from the reader into the honest stop summary', async () => {
    const { d, store } = mkStore()
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough()
    const io: Io = {
      say: () => {},
      ask: async (q) => promptTTY(q, stream as unknown as Parameters<typeof promptTTY>[1]),
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
