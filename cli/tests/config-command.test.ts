/**
 * `saip config` and deploy-parameter redaction.
 *
 * Two rules drive these tests. First: a command that manages secrets must never print one unless
 * explicitly told to, so the default-output assertions here matter more than the happy paths.
 * Second: the store sits below the shell in resolution order, which is a footgun the tool must
 * surface rather than leave for someone to discover at 2am.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRegistryService } from '../src/lib/command-registry.js'
import configPlugin, { runConfig, maskValue, buildStore } from '../src/commands/config.js'
import { SecretStore, MemoryKeySource, PassphraseKey, KeyFileKey } from '@saip/shared'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryKeySource, SecretStore } from '@saip/shared'
import { renderDeployPlan, parseParams } from '../src/lib/deploy.js'
import { buildProgram } from '../src/index.js'

const KEY = Buffer.alloc(32, 11)
const mkStore = async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'saip-cfg-')), 'secrets.enc.json')
  const store = new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', KEY)] })
  await store.set('SAIP_R2_BUCKET', 'saip-platform')
  await store.set('SAIP_R2_SECRET_ACCESS_KEY', 'super-secret-value-12345')
  return store
}

async function boot() {
  const ctx = new Context() as any
  await ctx.plugin(CommandRegistryService as any)
  return ctx
}

let out: string[]
beforeEach(() => { out = [] })
const capture = () => { const o = console.log; console.log = (...a: unknown[]) => out.push(a.map(String).join(' ')); return () => { console.log = o } }

describe('saip config dispatch through the registry', () => {
  it('registers with positional arguments declared', async () => {
    const ctx = await boot()
    await ctx.plugin(configPlugin as any, { store: await mkStore() })
    const spec = ctx.commandRegistry.get('config')
    expect(spec).toBeTruthy()
    expect(spec.positional).toContain('action')
  })

  it('buildProgram wires positionals without breaking argument-less commands', async () => {
    const program = await buildProgram()
    const cmd = program.commands.find((c) => c.name() === 'config')
    expect(cmd).toBeTruthy()
    expect(cmd!.registeredArguments.length).toBeGreaterThan(0)
    // The existing no-positional commands must still declare none.
    expect(program.commands.find((c) => c.name() === 'profiles')!.registeredArguments).toHaveLength(0)
  })
})

describe('saip config list', () => {
  it('prints names and never values', async () => {
    const restore = capture()
    const r = await runConfig(await mkStore(), {}, ['list'], { env: {} })
    restore()
    expect(r.code).toBe(0)
    expect(r.lines.join('\n')).toContain('SAIP_R2_BUCKET')
    expect(r.lines.join('\n')).not.toContain('saip-platform')
    expect(r.lines.join('\n')).not.toContain('super-secret-value-12345')
  })

  it('reports an empty store without failing', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'saip-empty-')), 'none.enc.json')
    const restore = capture()
    const r = await runConfig(new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', KEY)] }), {}, ['list'], { env: {} })
    restore()
    expect(r.code).toBe(0)
    expect(r.lines.join(' ')).toMatch(/empty|no secrets/i)
  })
})

describe('saip config get', () => {
  it('shows a declared non-sensitive value plainly, and masks a credential', async () => {
    const path = mkdtempSync(join(tmpdir(), 'saip-plain-')) + '/s.enc.json'
    const store = new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', KEY)] })
    await store.set('SAIP_R2_BUCKET', 'visible-bucket-name')
    await store.set('SAIP_R2_ACCESS_KEY_ID', 'AKIASECRETVALUE')
    const r = await runConfig(store, {}, ['get', 'SAIP_R2_BUCKET'], { env: {} })
    // SAIP_R2_BUCKET is declared sensitive: false in the catalog (#93), so masking it would be
    // the same blanket rule the wizard just stopped using.
    expect(r.code).toBe(0)
    expect(r.lines.join(' ')).not.toMatch(/••••/)
    expect(r.lines.join(' ')).toContain('visible-bucket-name')

    const k = await runConfig(store, {}, ['get', 'SAIP_R2_ACCESS_KEY_ID'], { env: {} })
    expect(k.lines.join(' ')).toMatch(/••••/)
  })

  it('masks a credential by default', async () => {
    // Retargeted from SAIP_R2_BUCKET, which #93 declares NON-sensitive: masking it was the blanket
    // rule the catalog replaced. Credentials are the subject a masking test actually needs.
    const r = await runConfig(await mkStore(), {}, ['get', 'SAIP_R2_SECRET_ACCESS_KEY'], { env: {} })
    expect(r.code).toBe(0)
    expect(r.lines.join(' ')).toContain('super-secret-value-12345'.length.toString())
    expect(r.lines.join(' ')).not.toContain('super-secret-value-12345')
  })

  it('reveals a credential only with --reveal', async () => {
    const r = await runConfig(await mkStore(), { reveal: true }, ['get', 'SAIP_R2_SECRET_ACCESS_KEY'], { env: {} })
    expect(r.lines.join(' ')).toContain('super-secret-value-12345')
  })

  it('a missing name is exit 1, not an empty success', async () => {
    const r = await runConfig(await mkStore(), {}, ['get', 'SAIP_ABSENT'], { env: {} })
    expect(r.code).toBe(1)
    expect(r.lines.join(' ')).toMatch(/not set|not found/i)
  })

  it('names the shadowing shell variable instead of pretending the store answered', async () => {
    const r = await runConfig(await mkStore(), { reveal: true }, ['get', 'SAIP_R2_BUCKET'], {
      env: { SAIP_R2_BUCKET: 'from-shell' },
    })
    // #157 reworded the label to name BOTH places and which one wins ("from shell environment — it
    // wins over the encrypted store"), so the literal word this case used to look for is gone. The
    // intent it was standing in for is what is asserted now: the shell is named as the source, the
    // store is named as the thing being beaten, and the shell's value is what is displayed.
    const line = r.lines.join(' ')
    expect(line).toMatch(/from shell environment/)
    expect(line).toMatch(/store/i)
    expect(line).toMatch(/wins over/)
    expect(line).toMatch(/from-shell/)
  })
})

describe('maskValue', () => {
  it('reveals the length but no part of the value', () => {
    // Asserting that no single character appears anywhere is meaningless: any human-readable
    // label shares letters with any short secret. What matters is that no substring of the
    // secret itself, and no tail of it, is recoverable from the mask.
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const masked = maskValue(secret)
    for (const len of [secret.length, 8, 4]) {
      for (let i = 0; i + len <= secret.length; i++) {
        expect(masked).not.toContain(secret.slice(i, i + len))
      }
    }
    expect(masked).toContain(String(secret.length))
  })
})

describe('saip config set / unset', () => {
  it('persists a value that a fresh reader can retrieve', async () => {
    const store = await mkStore()
    const r = await runConfig(store, { value: 'rotated' }, ['set', 'SAIP_HF_TOKEN'], { env: {} })
    expect(r.code).toBe(0)
    expect(await new SecretStore({ path: store.path, keySources: [new MemoryKeySource('passphrase', KEY)] }).get('SAIP_HF_TOKEN')).toBe('rotated')
    // The write path must not print the value it was given.
    expect(r.lines.join(' ')).not.toContain('rotated')
  })

  it('reads a piped value from stdin mode without it becoming an argument', async () => {
    const store = await mkStore()
    const r = await runConfig(store, { stdin: true }, ['set', 'SAIP_X'], {
      env: {}, readStdin: async () => 'piped-secret\n',
    })
    expect(r.code).toBe(0)
    expect(await store.get('SAIP_X')).toBe('piped-secret')
  })

  it('refuses an interactive-less empty value rather than storing nothing', async () => {
    const store = await mkStore()
    const r = await runConfig(store, { stdin: true }, ['set', 'SAIP_X'], { env: {}, readStdin: async () => '' })
    expect(r.code).toBe(1)
    expect(await store.get('SAIP_X')).toBeUndefined()
  })

  it('unset reports whether anything was removed', async () => {
    const store = await mkStore()
    expect((await runConfig(store, {}, ['unset', 'SAIP_R2_BUCKET'], { env: {} })).code).toBe(0)
    const r = await runConfig(store, {}, ['unset', 'SAIP_R2_BUCKET'], { env: {} })
    expect(r.code).toBe(1)
    expect(r.lines.join(' ')).toMatch(/not set|was not/i)
  })
})

describe('saip config doctor', () => {
  it('reports wraps, path, and file mode', async () => {
    const store = await mkStore()
    const r = await runConfig(store, {}, ['doctor'], { env: {} })
    const text = r.lines.join('\n')
    expect(r.code).toBe(0)
    expect(text).toContain(store.path)
    // v2 reports unlock methods rather than a single key source.
    expect(text).toMatch(/wraps:\s+passphrase/)
    expect(text).toMatch(/unlocked by:\s+passphrase/)
    expect(text).toMatch(/600/)
  })

  it('warns when the store cannot be opened, and exits non-zero', async () => {
    const store = await mkStore()
    const broken = new SecretStore({ path: store.path, keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 99))] })
    const r = await runConfig(broken, {}, ['doctor'], { env: {} })
    expect(r.code).toBe(1)
    expect(r.lines.join(' ')).toMatch(/cannot unlock/)
  })

  it('flags a store readable by group or other', async () => {
    const store = await mkStore()
    const { chmodSync } = await import('node:fs')
    chmodSync(store.path, 0o644)
    const r = await runConfig(store, {}, ['doctor'], { env: {} })
    expect(r.lines.join(' ')).toMatch(/permissive|0o644|chmod/i)
    expect(r.code).toBe(1)
  })
})

describe('deploy parameter redaction', () => {
  it('masks every value in the plan by default', () => {
    const plan = renderDeployPlan(
      { name: 'default', kind: 'local', role: 'both' } as any,
      { name: 'cloud', kind: 'hyperstack', role: 'inference' } as any,
      parseParams(['SAIP_R2_SECRET_ACCESS_KEY=abc123XYZ', 'SAIP_R2_BUCKET=saip-prod']),
    )
    expect(plan.detail).not.toContain('abc123XYZ')
    expect(plan.detail).not.toContain('saip-prod')
    // The names still have to be visible, or the plan is useless.
    expect(plan.detail).toContain('SAIP_R2_SECRET_ACCESS_KEY')
  })

  it('keeps secret:NAME indirection readable, since the name is not a secret', () => {
    const plan = renderDeployPlan({ name: 'a', kind: 'local', role: 'both' } as any, { name: 'b', kind: 'local', role: 'both' } as any,
      parseParams(['SAIP_R2_BUCKET=secret:SAIP_R2_BUCKET_ALT']))
    expect(plan.detail).toContain('secret:SAIP_R2_BUCKET_ALT')
  })

  it('reveals only on explicit request', () => {
    const params = parseParams(['K=topsecret'])
    expect(renderDeployPlan({} as any, {} as any, params).detail).not.toContain('topsecret')
    expect(renderDeployPlan({} as any, {} as any, params, { revealParams: true }).detail).toContain('topsecret')
  })

  it('a secret NAME never appears masked, so plans stay debuggable', () => {
    const plan = renderDeployPlan({} as any, {} as any, { KEY_NAME: 'secret:SAIP_TOKEN' })
    expect(plan.detail).toMatch(/KEY_NAME=secret:SAIP_TOKEN/)
  })
})

describe('store creation prompts (#73)', () => {
  it('asks twice, and stores nothing when the two answers differ', async () => {
    const asked: string[] = []
    const store = new SecretStore({ path: join(mkdtempSync(join(tmpdir(), 'saip-c-')), 's.enc.json'), keySources: [new MemoryKeySource('passphrase', null)] })
    // Answers are keyed to the question, not the call count: the value itself is prompted for
    // when no --stdin/--value is given, so an order-based fake silently shifts out of phase.
    const r = await runConfig(store, { value: 'the-secret' }, ['set', 'SAIP_X'], {
      env: {},
      prompt: async (q) => { asked.push(q); return q.startsWith('confirm') ? 'two' : 'one' },
    })
    expect(asked.length).toBe(2)
    expect(r.code).toBe(1)
    expect(r.lines.join(' ')).toMatch(/did not match/)
    expect(store.exists()).toBe(false)
  })

  it('refuses an empty passphrase rather than creating an unrecoverable store', async () => {
    const store = new SecretStore({ path: join(mkdtempSync(join(tmpdir(), 'saip-c-')), 's.enc.json'), keySources: [new MemoryKeySource('passphrase', null)] })
    const r = await runConfig(store, { value: 'v' }, ['set', 'SAIP_X'], { env: {}, prompt: async () => '' })
    expect(r.code).toBe(1)
    expect(r.lines.join(' ')).toMatch(/passphrase is required/)
    expect(store.exists()).toBe(false)
  })

  it('creates the store once both answers agree, keyed by the typed passphrase', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'saip-c-')), 's.enc.json')
    // No usable key to begin with, so creation must come from the prompt itself.
    const store = new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', null)] })
    const r = await runConfig(store, { value: 'v' }, ['set', 'SAIP_X'], { env: {}, prompt: async () => 'same-twice' })
    expect(r.code).toBe(0)
    // Read it back through a passphrase source, not the raw placeholder key: the store is keyed
    // by scrypt('same-twice'), which is the whole point of the confirm flow.
    const reopened = new SecretStore({ path, keySources: [new PassphraseKey({ SAIP_SECRETS_PASSPHRASE: 'same-twice' })] })
    expect(await reopened.get('SAIP_X')).toBe('v')
  })
})

describe('saip config key', () => {
  it('lists wraps and adds unattended only on request', async () => {
    const d = mkdtempSync(join(tmpdir(), 'saip-key-'))
    const store = new SecretStore({ path: join(d, 's.enc.json'), keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 6))] })
    await store.set('A', '1')
    expect((await runConfig(store, {}, ['key', 'list'], { env: {} })).lines.join(' ')).toContain('passphrase')
    const added = await runConfig(store, {}, ['key', 'add', 'unattended'], { env: {} })
    expect(added.code).toBe(0)
    expect(added.lines.join(' ')).toMatch(/WARNING/)
    expect(store.wrapIds().sort()).toEqual(['passphrase', 'unattended'])
  })

  it('refuses an unknown wrap id', async () => {
    const store = new SecretStore({ path: join(mkdtempSync(join(tmpdir(), 'saip-key-')), 's.enc.json'), keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 6))] })
    await store.set('A', '1')
    const r = await runConfig(store, {}, ['key', 'add', 'nonsense'], { env: {} })
    expect(r.code).toBe(1)
  })
})

describe('unattended wrap is actually usable (#73 follow-up)', () => {
  it('buildStore can open a store carrying an unattended wrap, with no passphrase in reach', async () => {
    const d = mkdtempSync(join(tmpdir(), 'saip-unatt-'))
    const path = join(d, 's.enc.json')
    const seed = new SecretStore({ path, keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 11))] })
    await seed.set('SAIP_R2_BUCKET', 'from-store')
    await seed.addWrap(new KeyFileKey(join(d, 'keys', 'unattended.key')))

    // Simulate a fresh process with no passphrase anywhere: exactly the installed-CLI case.
    const savedPass = process.env.SAIP_SECRETS_PASSPHRASE
    delete process.env.SAIP_SECRETS_PASSPHRASE
    const store = buildStore({ env: {}, storePath: path })
    if (savedPass !== undefined) process.env.SAIP_SECRETS_PASSPHRASE = savedPass
    expect(await store.get('SAIP_R2_BUCKET')).toBe('from-store')
    expect(await store.activeWrap()).toBe('unattended')
  })
})

describe('the /dev/tty handle must not keep the process alive (#110 F1)', () => {
  /**
   * A prompted command used to print its result and never exit: the module-level tty ReadStream holds
   * the event loop open. The fix refs the handle only while a question is open.
   *
   * Asserted on an injected stream on purpose. The obvious harness — running the CLI under `script` —
   * cannot detect the bug: `script` exits when its own stdin hits EOF and reports success while the
   * child is still alive. That harness produced a green test for a defect that was not yet fixed,
   * which is the definition of an unfailable test.
   */
  const fakeStream = () => {
    const calls: string[] = []
    const handlers: Record<string, Array<(c: Buffer) => void>> = {}
    const s = {
      isTTY: true, isRaw: false, fd: 99,
      setRawMode(v: boolean) { calls.push(`raw:${v}`); s.isRaw = v; return s },
      setEncoding() { return s }, resume() { return s }, pause() { return s },
      on(ev: string, fn: (c: Buffer) => void) { calls.push(`on:${ev}`); (handlers[ev] ??= []).push(fn); return s },
      once(ev: string) { calls.push(`on:${ev}`); return s },
      removeListener(ev: string) { calls.push(`off:${ev}`); return s },
      ref() { calls.push('ref'); return s },
      unref() { calls.push('unref'); return s },
      destroy() { calls.push('destroy'); return s },
      emit() { return true }, read() { return null },
    }
    return { stream: s, calls, deliver: (ev: string, chunk: Buffer) => handlers[ev]?.forEach((h) => h(chunk)) }
  }

  it('holds the loop while the question is open and releases it afterwards', async () => {
    const { promptTTY } = await import('../src/commands/config.js')
    const { stream, calls, deliver } = fakeStream()
    const done = promptTTY('probe: ', { secret: true, stream: stream as never })
    const refAt = calls.indexOf('ref')
    const dataAt = calls.indexOf('on:data')
    expect(refAt, 'the handle must be ref’d before listening').toBeGreaterThanOrEqual(0)
    expect(dataAt, 'must actually listen').toBeGreaterThan(refAt)

    deliver('data', Buffer.from('\r'))          // the user presses Enter
    await done
    // The property is ordering, not "last call": the handle is released during cleanup, before the
    // listeners go away, and nothing re-refs it afterwards.
    expect(calls.lastIndexOf('unref'), `calls were ${calls.join(',')}`).toBeGreaterThan(calls.lastIndexOf('ref'))
    expect(calls.filter((c) => c === 'unref').length).toBeGreaterThanOrEqual(1)
    expect(calls.slice(calls.lastIndexOf('unref')), 'nothing may re-hold the loop after release').not.toContain('ref')
  })

  it('releases the handle on the cancel path too, not only on success', async () => {
    const { promptTTY } = await import('../src/commands/config.js')
    const { stream, calls, deliver } = fakeStream()
    const done = promptTTY('probe: ', { secret: true, stream: stream as never })
    deliver('data', Buffer.from('\u0003'))      // Ctrl+C
    await expect(done).rejects.toThrow(/cancelled/i)
    expect(calls.lastIndexOf('unref'), `cancel path calls were ${calls.join(',')}`).toBeGreaterThan(calls.lastIndexOf('ref'))
  })

  it('releases before removing listeners, so a queued keystroke is not dropped (#99)', async () => {
    const { promptTTY } = await import('../src/commands/config.js')
    const { stream, calls, deliver } = fakeStream()
    const done = promptTTY('probe: ', { secret: true, stream: stream as never })
    deliver('data', Buffer.from('\r\rleftover'))   // Enter, then bytes for the next question
    await done
    const release = calls.indexOf('unref')
    const removed = calls.indexOf('off:data')
    expect(release).toBeGreaterThanOrEqual(0)
    expect(removed).toBeGreaterThan(release)
  })
})
