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

  it('status command reads config via shared registry without crashing', async () => {
    const program = await buildProgram()
    const status = program.commands.find((c) => c.name())
    // point at the shipped saip.yaml so the shared validator path executes
    process.env.SAIP_CONFIG = new URL('../../saip.yaml', import.meta.url).pathname
    const logs: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }
    try {
      // invoke the action through commander parse (from:'user' → args are user-facing)
      program.parse(['status'], { from: 'user' })
      // allow microtasks (action is sync here) to flush
      await Promise.resolve()
    } finally {
      console.log = origLog
    }
    const out = logs.join('\n')
    expect(out).toMatch(/Platform Status/)
    // adapters line should reflect the registry (3 defined in shipped example)
    expect(out).toMatch(/Adapters:\s+3 defined/)
    expect(out).toMatch(/registry valid/)
  })
})
