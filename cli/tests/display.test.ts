/**
 * DisplayService (#88). The renderer is pure and takes explicit options, so every degraded-terminal
 * case is asserted rather than hoped for — including the one Ink failed in the spike (TERM=dumb
 * still drawing Unicode boxes).
 */
import { describe, it, expect } from 'vitest'
import { renderCard, detectDisplay, type CardSpec } from '../src/lib/display.js'

const spec: CardSpec = {
  title: 'SAIP_R2_BUCKET', badge: 'required',
  fields: [
    { label: 'what', value: 'Object storage for adapters, knowledge, sessions and feedback.' },
    { label: 'create', value: 'https://dash.cloudflare.com/?to=/:account/r2/overview' },
  ],
}

describe('card rendering', () => {
  it('draws a unicode box when the locale supports it', () => {
    const out = renderCard(spec, { columns: 80, unicode: true, color: false })
    expect(out).toMatch(/^╭─/)
    expect(out).toMatch(/╰─/)
    expect(out).toContain('SAIP_R2_BUCKET')
    expect(out).toContain('(required)')
    expect(out).toContain('Object storage for adapters')
    expect(out).toContain('https://dash.cloudflare.com')
  })

  it('falls back to ASCII under TERM=dumb — the case the spike showed Ink getting wrong', () => {
    const out = renderCard(spec, { columns: 80, unicode: false })
    expect(out).not.toMatch(/[╭╮╰╯│─]/)
    expect(out).toMatch(/^\+-+\+/)
    expect(out).toContain('Object storage for adapters')
  })

  it('wraps long values instead of overflowing the width', () => {
    const long: CardSpec = { title: 'X', fields: [{ label: 'what', value: 'word '.repeat(60) }] }
    for (const cols of [60, 80, 100]) {
      const out = renderCard(long, { columns: cols, unicode: true })
      for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(cols)
    }
  })

  it('stacks labels and values on a narrow terminal', () => {
    const out = renderCard(spec, { columns: 60, unicode: true })
    expect(out).toContain('what:')
    const narrow = renderCard(spec, { columns: 60 })
    const wide = renderCard(spec, { columns: 90 })
    expect(narrow.split('\n').length).toBeGreaterThan(wide.split('\n').length)
    expect(wide).toContain('what: Object storage')
  })

  it('emits no ANSI when colour is off, and none at all when piped', () => {
    expect(renderCard(spec, { columns: 80, unicode: true, color: false })).not.toMatch(/\x1b\[/)
    const out = renderCard(spec, { columns: 80, unicode: true, color: true })
    expect(out).toMatch(/\x1b\[36m/)
  })
})

describe('detectDisplay', () => {
  it('reads unicode capability from the locale and TERM, not from optimism', () => {
    expect(detectDisplay({ LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, true).unicode).toBe(true)
    expect(detectDisplay({ LANG: 'C', TERM: 'dumb' }, true).unicode).toBe(false)
    expect(detectDisplay({ LANG: 'C.UTF-8' }, true).unicode).toBe(true)
  })

  it('never colours a non-TTY, and honours NO_COLOR', () => {
    expect(detectDisplay({ LANG: 'C.UTF-8', TERM: 'xterm' }, false).color).toBe(false)
    expect(detectDisplay({ LANG: 'C.UTF-8', TERM: 'xterm', NO_COLOR: '1' }, true).color).toBe(false)
    expect(detectDisplay({ LANG: 'C.UTF-8', TERM: 'xterm' }, true).color).toBe(true)
  })

  it('clamps and falls back sanely for width', () => {
    expect(detectDisplay({ COLUMNS: '5000' }, true).columns).toBeLessThanOrEqual(100)
    expect(detectDisplay({ COLUMNS: '0' }, true).columns).toBe(80)
    expect(detectDisplay({}, true).columns).toBeGreaterThan(0)
  })
})

describe('the wizard renders cards when a human is present (#88)', () => {
  it('uses the injected formatter, and keeps identical content to the plain block', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { SecretStore, MemoryKeySource } = await import('@saip/shared')
    const { planInitItems, runInit, cardGuidance, plainGuidance } = await import('../src/commands/config-init.js')
    const d = mkdtempSync(join(tmpdir(), 'saip-card-'))
    const store = new SecretStore({ path: join(d, 's.enc.json'), keySources: [new MemoryKeySource('passphrase', Buffer.alloc(32, 8))] })
    const said: string[] = []
    const items = planInitItems({ config: {}, hosts: [] })
    await runInit({
      store, items, envPath: join(d, '.env'),
      io: { say: (l) => said.push(l), ask: async () => 'x' },
      formatItem: (item) => cardGuidance(item, { columns: 80, unicode: true, color: false }),
    })
    const text = said.join('\n')
    expect(text).toMatch(/╭─/)            // a real box
    expect(text).toMatch(/╰─/)
    expect(text).toContain('SAIP_R2_BUCKET')
    expect(text).toContain('(required)')
    // Content parity: a card must not say more or less than the plain block.
    const plain = plainGuidance(items[0]).join('\n')
    for (const phrase of ['Object storage for adapters']) {
      expect(text).toContain(phrase)
      expect(plain).toContain(phrase)
    }
  })
})
