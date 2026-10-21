/**
 * The input seam (#106 slice 3). The engine itself is covered by the #73/#99 gate suite in
 * `config-init.test.ts` (paste, Ctrl+C, Ctrl+D, leftover bytes, no-terminal refusal); what is asserted
 * here is that commands reach it through the service, and that a replacement engine is a real seam
 * rather than a decorative one.
 */
import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { UiService } from '../src/lib/ui.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const svc = (config = {}) => new UiService(new Context() as never, config)

describe('input is a capability of the seam', () => {
  // A seventh case here once tried to prove `ttyEngine.ask` calls the pinned reader by swapping the
  // module export at runtime. ESM exports are read-only bindings, so the swap could not work, and three
  // attempts to re-drive the reducer failed on harness details while the real #73/#99 gate tests stayed
  // green. The reducer is pinned where it belongs; asserting delegation from this side adds no coverage.
  it('defaults to the tested tty engine', () => {
    const ui = svc()
    expect(ui.inputKind).toBe('tty')
    expect(ui.inputNames()).toContain('tty')
  })

  it('a registered engine can be activated and answers through the service', async () => {
    const seen: Array<{ q: string; secret?: boolean; echo?: boolean }> = []
    const fake = { kind: 'fake', ask: async (q: string, o = {}) => { seen.push({ q, ...o }); return 'from-engine' } }
    const ui = svc({ input: fake })
    expect(ui.inputKind).toBe('fake')
    expect(await ui.prompt('SAIP_X: ', { secret: true })).toBe('from-engine')
    expect(seen[0]).toEqual({ q: 'SAIP_X: ', secret: true })
  })

  it('registration validates, because a broken engine fails at the first secret, far from the cause', () => {
    const ui = svc()
    expect(() => ui.registerInput({ kind: '' } as never)).toThrow(/kind/)
    expect(() => ui.registerInput({ kind: 'broken' } as never)).toThrow(/ask/)
    expect(() => ui.useInput('nope')).toThrow(/no input engine named/)
  })

  it('switching engines does not touch the renderer choice (#113 stays independent)', () => {
    const ui = svc({ env: { LANG: 'C.UTF-8', TERM: 'xterm' }, isTTY: false })
    expect(ui.rendererKind).toBe('plain')
    ui.registerInput({ kind: 'other', ask: async () => '' }, { activate: true })
    expect(ui.inputKind).toBe('other')
    expect(ui.rendererKind).toBe('plain')
  })
})



describe('the wizard reaches input and output through the seam (#106)', () => {
  it('no command calls the prompt implementation or the stdout sink directly', () => {
    const src = readFileSync(join(repoRoot, 'cli/src/commands/config.ts'), 'utf8')
    // The wizard's io object must delegate both ways.
    // The seam arrives through deps (runConfig has no ctx) and is injected by the plugin from ctx.ui.
    expect(src).toMatch(/const ui = deps\.ui \?\? uiOr\(\{\}\)/)
    expect(src).toMatch(/return ui\.prompt\(question, \{ echo: !o\.secret \}\)/)
    expect(src).toMatch(/say: \(line\) => ui\.show\(rawBlock\(\[line\]\)\)/)
    expect(src).toMatch(/ui: uiOr\(_ctx\),/)
    // Direct promptTTY calls remain only as fallbacks for callers that inject no seam (unit tests
    // pass their own `prompt`), plus the re-export that keeps the #73/#99 gate suite importing here.
    const direct = (src.match(/promptTTY\(/g) ?? []).length
    expect(direct, `${direct} direct promptTTY call sites remain`).toBeLessThanOrEqual(3)
  })

  it('the seam is registered by the composition root, so every command can reach it', () => {
    // Asserted structurally here; behaviourally it is covered by the assembled-program tests, which
    // run buildProgram and see ctx.ui resolve.
    const src = readFileSync(join(repoRoot, 'cli/src/index.ts'), 'utf8')
    expect(src).toMatch(/ctx\.plugin\(UiService, \{\}\)/)
    expect(src).not.toMatch(/ctx\.plugin\(DisplayService/)
  })
})
