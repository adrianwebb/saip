/**
 * The #113 UI layer, tested from the outside: through `UiService`'s public methods, with both
 * renderers, and with content parity asserted per component. Parity is the load-bearing property —
 * a card that looks right in Ink while dropping a field in log mode is invisible to every other test
 * in the suite and exactly the class of silent divergence this project keeps repairing.
 */
import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { UiService, type Renderer } from '../src/lib/ui.js'
import { cardBlock, kvBlock, columnsBlock, lineBlock, ruleBlock, type Block } from '../src/ui/blocks.js'
import { plainRenderer } from '../src/ui/plain.js'
import { inkRenderer } from '../src/ui/ink.js'

/** Strip ANSI + box drawing, COLLAPSING whitespace: for "does it contain this field" checks. */
const STRIP = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[─-╿]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Strip ANSI + box drawing but KEEP line structure. Required for per-line assertions: collapsing
 * whitespace merged every row into one line, so "the continuation row must not start with a colon"
 * passed no matter what the renderer emitted. A test that cannot fail is worse than no test.
 */
const CLEAN = (s: string): string[] =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[─-╿]/g, ' ').split('\n').map((l) => l.replace(/ +$/, '')).filter((l) => l.trim() !== '')

const CARD = cardBlock('SAIP_R2_BUCKET', 'required', [
  { label: 'what', value: 'Object storage for adapters and knowledge.' },
  { label: 'create', value: 'https://dash.cloudflare.com/?to=/:account/r2/overview' },
])
const KV = kvBlock([
  { label: 'store', value: '/home/u/.saip/secrets.json' },
  { label: 'wrapped by', value: 'passphrase' },
  { label: 'sensitive', value: '•••• (20 chars)', hint: 'never printed' },
])
const COLS = columnsBlock(['profile', 'min VRAM', 'fits'], [
  ['inference-8gb', '8 GiB', 'yes'],
  ['full-loop-12gb', '12 GiB', 'no'],
])

describe('content parity between renderers (#113)', () => {
  const cases: [string, Block, string[]][] = [
    ['card', CARD, ['SAIP_R2_BUCKET', 'required', 'Object storage for adapters and knowledge.', 'dash.cloudflare.com']],
    ['keyValues', KV, ['store', '/home/u/.saip/secrets.json', 'wrapped by', 'passphrase', '•••• (20 chars)', 'never printed']],
    ['columns', COLS, ['profile', 'min VRAM', 'fits', 'inference-8gb', '8 GiB', 'yes', 'full-loop-12gb', '12 GiB', 'no']],
    ['line', lineBlock('[saip] dry-run: nothing applied'), ['dry-run: nothing applied']],
  ]

  for (const [name, block, fields] of cases) {
    it(`${name}: both renderers carry every field`, () => {
      for (const r of [plainRenderer, inkRenderer]) {
        const out = STRIP(r.render(block))
        for (const f of fields) {
          expect(out, `${r.kind}/${name} dropped ${f}`).toContain(f)
        }
      }
    })
  }

  it('plain output contains no box-drawing and no ANSI, ever', () => {
    for (const b of [CARD, KV, COLS]) {
      const out = plainRenderer.render(b)
      expect(out).not.toMatch(/[\u2500-\u25ff]/)
      expect(out).not.toMatch(/\x1b\[/)
    }
  })

  it('the rule is a rule in plain and a box edge in ink, and neither invents content', () => {
    expect(plainRenderer.render(ruleBlock(20))).toMatch(/-{20}/)
    expect(STRIP(inkRenderer.render(ruleBlock(20)))).toBe('')
  })
})

describe('the renderer seam is pluggable (the point of #113)', () => {
  it('a registered renderer replaces the output without touching a command', () => {
    const upper: Renderer = {
      kind: 'shout',
      render: (b) => plainRenderer.render(b).toUpperCase(),
    }
    const ui = new UiService(new Context() as any, { env: { LANG: 'C.UTF-8' }, isTTY: false, renderer: upper })
    expect(ui.card(CARD.spec).toUpperCase()).toBe(ui.card(CARD.spec))
    expect(ui.card(CARD.spec)).toContain('SAIP_R2_BUCKET')
  })

  it('default construction (nothing injected) still picks plain for a non-TTY stream', () => {
    // The composition-root rule (#76): the wiring, not the parts.
    const ui = new UiService(new Context() as any, {})
    expect(ui.mode).toBe('plain')
    expect(ui.rendererKind).toBe('plain')
  })

  it('a TTY selects the ink renderer', () => {
    const ui = new UiService(new Context() as any, { env: { LANG: 'C.UTF-8', TERM: 'xterm-256color' }, isTTY: true })
    expect(ui.mode).toBe('ink')
    expect(ui.rendererKind).toBe('ink')
  })

  it('registerRenderer validates rather than accepting anything', () => {
    const ui = new UiService(new Context() as any, {})
    expect(() => ui.registerRenderer({ kind: 'broken' } as unknown as Renderer)).toThrow(/render/)
    expect(() => ui.registerRenderer({ kind: '', render: () => '' })).toThrow(/kind/)
  })
})

describe('UI code is isolated to the UI layer (#113)', () => {
  it('no block renderer emits the [saip] prefix except the line renderer', () => {
    // The prefix is a convention about *messages*, not about every string: a card must not gain it,
    // and this pins where the rule lives.
    expect(plainRenderer.render(lineBlock('stored X (3 chars)'))).toContain('[saip] stored X')
    expect(plainRenderer.render(CARD)).not.toMatch(/^\[saip\]/m)
  })
})

describe('renderer defects found by running the binary in a pty (#113)', () => {
  it('an empty label (a continuation row) never prints a bare colon, in either renderer', () => {
    // Real output from the compiled binary: `: gpu_memory_utilization=0.6875 (derived)`. The plain
    // renderer had the guard; Ink did not, so the two diverged in *content*, which is the one thing
    // the parity property forbids.
    const b = kvBlock([{ label: 'Profile', value: 'full-loop-12gb' }, { label: '', value: 'gpu_memory_utilization=0.6875 (derived)' }])
    for (const r of [plainRenderer, inkRenderer]) {
      const lines = CLEAN(r.render(b))
      const cont = lines.find((l) => l.includes('gpu_memory_utilization'))
      expect(cont, `${r.kind} dropped the continuation row`).toBeDefined()
      expect(cont!.trim().startsWith(':'), `${r.kind} printed a bare colon for an empty label`).toBe(false)
    }
  })

  it('both renderers align the value column', () => {
    const b = kvBlock([{ label: 'Host', value: 'reachable' }, { label: 'Adapters', value: '3 defined' }])
    for (const r of [plainRenderer, inkRenderer]) {
      const lines = CLEAN(r.render(b))
      const cols = lines.map((l) => l.indexOf('reachable') >= 0 ? l.indexOf('reachable') : l.indexOf('3 defined'))
      expect(new Set(cols).size, `${r.kind}: values start at different columns (${cols.join(',')})`).toBe(1)
    }
  })
})

describe('the json renderer — Ink bypassed for agents and automation (#113)', () => {
  it('emits one parseable object per block, no ANSI, no box characters', async () => {
    const { jsonlRenderer } = await import('../src/ui/json.js')
    for (const b of [CARD, KV, COLS, lineBlock('stored SAIP_X (3 chars)'), ruleBlock(20)]) {
      const out = jsonlRenderer.render(b)
      expect(out).not.toMatch(/\x1b\[/)
      expect(out).not.toMatch(/[\u2500-\u25ff]/)
      const parsed = JSON.parse(out)
      expect(parsed.kind).toBe(b.kind)
    }
  })

  it('keeps every field, because the machine path is the same blocks', async () => {
    const { jsonlRenderer } = await import('../src/ui/json.js')
    const parsed = JSON.parse(jsonlRenderer.render(CARD))
    expect(parsed.title).toBe('SAIP_R2_BUCKET')
    expect(parsed.badge).toBe('required')
    expect(parsed.fields.map((f: any) => f.label)).toEqual(['what', 'create'])
  })

  it('is registered by default and selectable without touching a command', () => {
    const ui = new UiService(new Context() as any, {})
    expect(ui.rendererNames()).toContain('jsonl')
    ui.useRenderer('jsonl')
    expect(ui.rendererKind).toBe('jsonl')
    expect(ui.structured).toBe(true)
    expect(() => ui.useRenderer('nope')).toThrow(/no renderer named/)
  })

  it('unknown renderer names fail loudly instead of falling back silently', () => {
    const ui = new UiService(new Context() as any, {})
    expect(() => ui.useRenderer('ink')).not.toThrow()
    expect(ui.mode).toBe('plain') // selection unchanged; only activation moved
  })
})
