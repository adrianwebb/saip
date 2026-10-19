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
import configPlugin, { runConfig, maskValue } from '../src/commands/config.js'
import { MemoryKeySource, SecretStore } from '@saip/shared'
import { renderDeployPlan, parseParams } from '../src/lib/deploy.js'
import { buildProgram } from '../src/index.js'

const KEY = Buffer.alloc(32, 11)
const mkStore = async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'saip-cfg-')), 'secrets.enc.json')
  const store = new SecretStore({ path, keySources: [new MemoryKeySource(KEY)] })
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
    const r = await runConfig(new SecretStore({ path, keySources: [new MemoryKeySource(KEY)] }), {}, ['list'], { env: {} })
    restore()
    expect(r.code).toBe(0)
    expect(r.lines.join(' ')).toMatch(/empty|no secrets/i)
  })
})

describe('saip config get', () => {
  it('masks the value by default', async () => {
    const r = await runConfig(await mkStore(), {}, ['get', 'SAIP_R2_BUCKET'], { env: {} })
    expect(r.code).toBe(0)
    expect(r.lines.join(' ')).toContain('saip-platform'.length.toString())
    expect(r.lines.join(' ')).not.toContain('saip-platform')
  })

  it('reveals only with --reveal', async () => {
    const r = await runConfig(await mkStore(), { reveal: true }, ['get', 'SAIP_R2_BUCKET'], { env: {} })
    expect(r.lines.join(' ')).toContain('saip-platform')
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
    expect(r.lines.join(' ')).toMatch(/shadow/i)
    expect(r.lines.join(' ')).toMatch(/from-shell/)
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
    expect(await new SecretStore({ path: store.path, keySources: [new MemoryKeySource(KEY)] }).get('SAIP_HF_TOKEN')).toBe('rotated')
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
  it('reports key source, path, and file mode', async () => {
    const store = await mkStore()
    const r = await runConfig(store, {}, ['doctor'], { env: {} })
    const text = r.lines.join('\n')
    expect(r.code).toBe(0)
    expect(text).toContain(store.path)
    expect(text).toMatch(/key source:\s+memory/)
    expect(text).toMatch(/600/)
  })

  it('warns when the store cannot be opened, and exits non-zero', async () => {
    const store = await mkStore()
    const broken = new SecretStore({ path: store.path, keySources: [new MemoryKeySource(Buffer.alloc(32, 99))] })
    const r = await runConfig(broken, {}, ['doctor'], { env: {} })
    expect(r.code).toBe(1)
    expect(r.lines.join(' ')).toMatch(/cannot decrypt/)
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
