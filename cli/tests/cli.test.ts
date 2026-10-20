import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { CommandRegistryService } from '../src/lib/command-registry.js'
import { buildProgram } from '../src/index.js'

describe('CommandRegistryService', () => {
  it('registers and lists command specs', async () => {
    const ctx = new Context() as any
    await ctx.plugin(CommandRegistryService as any)
    ctx.commandRegistry.register({ name: 'demo', description: 'd', action: () => {} })
    expect(ctx.commandRegistry.list().map((s: any) => s.name)).toContain('demo')
    expect(ctx.commandRegistry.get('demo')).toBeTruthy()
  })
})

describe('CLI dispatcher (buildProgram)', () => {
  it('boots a Cordis context and registers all four built-in commands', async () => {
    const program = await buildProgram()
    const names = program.commands.map((c) => c.name())
    for (const expected of ['awake', 'sleep', 'down', 'status']) {
      expect(names).toContain(expected)
    }
  })

  it('status --json emits machine records with the same content (#113)', async () => {
    // Documented capability, tested at the level a script consumes it: parse it, do not eyeball it.
    process.env.SAIP_CONFIG = new URL('../../saip.yaml', import.meta.url).pathname
    const chunks: string[] = []
    const orig = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (c: string | Uint8Array): boolean => {
      chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8')); return true
    }
    try {
      const program = await buildProgram()
      await program.parseAsync(['status', '--json'], { from: 'user' })
    } finally {
      ;(process.stdout as any).write = orig
    }
    const text = chunks.join('')
    expect(text).not.toMatch(/\x1b\[/)
    expect(text).not.toMatch(/[\u2500-\u25ff]/)   // no rule drawn: decoration is skipped when structured
    const rec = JSON.parse(text.trim().split('\n')[0])
    expect(rec.kind).toBe('keyValues')
    expect(rec.rows.map((r: any) => r.label)).toContain('Adapters')
  })

  it('status command reads config via shared registry without crashing', async () => {
    const program = await buildProgram()
    const status = program.commands.find((c) => c.name())
    // point at the shipped saip.yaml so the shared validator path executes
    process.env.SAIP_CONFIG = new URL('../../saip.yaml', import.meta.url).pathname
    // #113: the ui seam writes to the process sink, not console.log, so capture at the sink. The
    // assertions below are unchanged — same strings, same pins — only the observation point moved.
    const logs: string[] = []
    const origLog = console.log
    const origWrite = process.stdout.write.bind(process.stdout)
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }
    ;(process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
      logs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }
    try {
      // invoke the action through commander parse (from:'user' → args are user-facing)
      // parseAsync, not parse+one tick: `status` renders one aligned block, so nothing is written
      // until the awaited GPU probe finishes. The old `await Promise.resolve()` only worked because
      // the previous implementation emitted line-by-line before that probe. A test that races the
      // thing it is asserting is the kind of green that hides a regression.
      await program.parseAsync(['status'], { from: 'user' })
    } finally {
      console.log = origLog
      ;(process.stdout as any).write = origWrite
    }
    const out = logs.join('\n')
    expect(out).toMatch(/Platform Status/)
    // adapters line should reflect the registry (3 defined in shipped example)
    expect(out).toMatch(/Adapters:\s+3 defined/)
    expect(out).toMatch(/registry valid/)
  })
})
