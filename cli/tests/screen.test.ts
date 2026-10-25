/**
 * Self-test for the screen model (#154).
 *
 * The ordering probes assert "the explanation is on the row ABOVE the prompt". That claim is only as
 * good as this model, so here the model is fed sequences whose correct result is known by hand, and —
 * the part that matters most — a sequence it does not understand must leave VISIBLE residue in
 * `unparsed` rather than be silently swallowed. A screen that ate `ESC[2K` without acting on it would
 * make every ordering probe pass for the wrong reason.
 */
import { describe, expect, it } from 'vitest'
import { Screen, renderScreen } from './support/screen.js'
import { CSI } from './support/pty.js'

describe('the screen model does what a terminal does', () => {
  it('writes glyphs and advances the cursor', () => {
    const s = new Screen(3, 10).feed('abc')
    expect(s.lineAt(0)).toBe('abc')
    expect([s.cx, s.cy]).toEqual([3, 0])
  })

  it('LF moves down, CR moves to column zero — the raw-mode distinction (#99)', () => {
    const s = new Screen(4, 20).feed('one\r\n')
    expect(s.cx).toBe(0)
    expect(s.cy).toBe(1)
    // The bug this exists to catch: a bare \n in raw mode leaves the cursor under 'e', not at col 0.
    const bare = new Screen(4, 20).feed('one\n')
    expect(bare.cx).toBe(3)
    expect(bare.lineAt(1)).toBe('')
  })

  it('handles ESC[G (cursor to column) which is how Ink returns to column zero, not \\r', () => {
    // Measured: ansi-escapes cursorTo(0) is `ESC[1G`… and the no-argument `ESC[G` form is
    // `cursorLeft`; Ink emits no CR for erasure. A bare `\n` does NOT reset the column (see above),
    // so 'def' lands at column 3 — that offset is the #99 artifact, reproduced, not asserted away.
    const s = new Screen(3, 20).feed('abc\ndef')
    expect(s.cx).toBe(6)
    expect(s.lineAt(1)).toBe('   def')
    s.feed('\x1b[1G')                            // cursorTo(0)
    expect(s.cx).toBe(0)
    s.feed('X')                                  // overwrites only column 0; 'def' stays at 3-5
    expect(s.lineAt(1)).toBe('X  def')
    s.feed('\x1b[G')                             // cursorLeft, the form eraseLines ends with
    expect(s.cx).toBe(0)
  })

  it('ESC[2K erases the whole current line and leaves the cursor where it was', () => {
    const s = new Screen(3, 10).feed('line0\r\nkeep')
    const before = s.cy
    s.feed('\x1b[2K')
    expect(s.lineAt(before)).toBe('')
    expect(s.lineAt(1)).toBe('')
    expect(s.cy).toBe(before)
  })

  it('ESC[<n>A moves the cursor up n rows', () => {
    const s = new Screen(4, 10).feed('a\r\nb\r\nc\r\nd')
    expect(s.cy).toBe(3)
    s.feed('\x1b[2A')
    expect(s.cy).toBe(1)
  })

  it('reproduces Ink eraseLines(n): n× ESC[2K with ESC[1A between, then ESC[G', () => {
    // Verbatim from ansi-escapes@7.3.0 base.js:77-89 (read on this host, not recalled):
    //   for (i = 0; i < count; i++) clear += eraseLine + (i < count - 1 ? cursorUp() : '')
    //   if (count) clear += cursorLeft                                    // ESC[G
    const eraseLines = (count: number): string => {
      let clear = ''
      for (let i = 0; i < count; i++) clear += '\x1b[2K' + (i < count - 1 ? '\x1b[1A' : '')
      if (count) clear += '\x1b[G'
      return clear
    }
    // Ink stores `previousLineCount = text.split('\n').length` (log-update.js:53) and a frame ends in
    // '\n', so a THREE-line frame carries the count FOUR — the extra erase is the cursor's own row.
    const s = new Screen(6, 20)
    s.feed('H1\r\nH2\r\nH3\r\n')                 // three frames of Ink history, cursor below them
    expect(s.cy).toBe(3)
    s.feed(eraseLines(4))
    expect([s.lineAt(0), s.lineAt(1), s.lineAt(2)]).toEqual(['', '', ''])
    expect(s.cy).toBe(0)
    expect(s.cx).toBe(0)
    s.feed('FRAME')
    expect(s.lineAt(0)).toBe('FRAME')
    expect(s.unparsed).toEqual([])                 // every sequence was understood
  })

  it('preserves text ABOVE the erased region — the #78 ordering guarantee depends on this', () => {
    const s = new Screen(8, 30)
    s.feed('EXPLANATION about the secret\r\n')   // command guidance, written before Ink took over
    s.feed('prompt: typed\r\n')                  // an Ink frame
    s.feed('\x1b[2K\x1b[1A\x1b[2K\x1b[G')        // Ink erasing its own previous frame only
    s.feed('prompt: typed-again')
    expect(s.lineAt(0)).toBe('EXPLANATION about the secret')
    expect(s.lineAt(1)).toBe('prompt: typed-again')
    expect(s.findRow('EXPLANATION')).toBeLessThan(s.findRow('prompt'))
  })

  it('models ESC[J (erase down) and ESC[?1049h alt screen', () => {
    const s = new Screen(4, 10).feed('a\r\nb\r\nc')
    s.feed('\x1b[1;1H\x1b[J')
    expect(s.visible()).toEqual([])
    const alt = new Screen(2, 10).feed('main')
    alt.feed(CSI.altScreenOn)
    expect(alt.altScreen).toBe(true)
    expect(alt.lineAt(0)).toBe('')
    alt.feed(CSI.altScreenOff)
    expect(alt.altScreen).toBe(false)
  })

  it('records synchronized-output BSU/ESU without corrupting glyphs', () => {
    const s = new Screen(2, 20)
    s.feed('\x1b[?2026hhello\x1b[?2026l')
    expect(s.lineAt(0)).toBe('hello')
    expect(s.unparsed).toEqual([])
  })

  it('FAILS LOUDLY on a sequence it does not model — no silent swallowing', () => {
    // The unfailable-test guard: if `?2004h` were handled by the default branch, an ordering probe
    // could pass while the model ignored half the stream.
    // DECSTBM (scroll region) and DSR (cursor report) have no glyph effect and are not modelled.
    // SGR is now handled (rendition only), so it must NOT appear here — that distinction is the point.
    const s = new Screen(2, 20).feed('\x1b[1;2r\x1b[6n\x1b[31mred')
    expect(s.unparsed.join('')).toContain('r')
    expect(s.unparsed.join('')).toContain('n')
    expect(s.unparsed.join('')).not.toContain('31')
    expect(s.lineAt(0)).toBe('red')
  })

  it('bracketed paste markers arriving as OUTPUT are recorded, not painted as glyphs', () => {
    // A program echoing the paste marker would show up here; markers are DEC modes in our probes.
    const s = renderScreen(`${CSI.pasteStart}value${CSI.pasteEnd}`)
    // The markers are `ESC[200~` / `ESC[201~` — CSI finals this model does not act on, so they are
    // visible gaps in the evidence rather than invisible successes.
    expect(s.lineAt(0)).toBe('value')
    expect(s.unparsed).toEqual(['\x1b[200~', '\x1b[201~'])
  })

/**
 * #176 — the model had no bottom margin and no right margin. It clamped: `
` at the last row kept
 * writing onto that row, and a glyph past the last column overwrote its own last cell. A wizard
 * transcript is 100+ lines into a 60-row pty, so the bottom of every reconstructed screen was a braid
 * of unrelated lines, and #110 row 2 failed against a product whose byte stream was correct.
 *
 * These cases are the ones that would have caught it, and each is stated as "what a terminal does",
 * not as "what this model happens to output".
 */
describe('the model scrolls and wraps the way a terminal does (#176)', () => {
  it('scrolls at the bottom margin so the LAST lines stay readable', () => {
    // `\r\n`, not `\n`: a terminal in raw mode does NOT return to column zero on LF — that is the
    // distinction this file already asserts in the #99 case above, and my first draft of these cases
    // forgot it, which produced correct-looking output at odd columns and nearly got "fixed" in the
    // model. Transcripts come from raw mode, so that is the shape they arrive in.
    const s = renderScreen('one\r\ntwo\r\nthree\r\nfour\r\nfive', 3, 20)
    expect(s.rows.length, 'the viewport never grows').toBe(3)
    expect(s.visible()).toEqual(['three', 'four', 'five'])
    expect(s.findRow('one'), 'a line that scrolled off is gone, as it is on a real screen').toBe(-1)
  })

  it('keeps the tail of a long transcript — the exact #110 row 2 failure', () => {
    // 70 short lines into a 30-row screen, ending with the summary the acceptance list looks for.
    const body = Array.from({ length: 67 }, (_, i) => `card line ${i}`).join('\r\n')
    const tail = '[saip] written now: 2 value(s)\r\n[saip] still to fill (3): SAIP_HF_TOKEN'
    const s = renderScreen(`${body}\r\n${tail}`, 30, 100)
    expect(s.visible().some((l) => l.startsWith('[saip] written now: 2 value(s)')), 'the summary must be on screen').toBe(true)
    expect(s.visible().some((l) => l.startsWith('[saip] still to fill')), 'and so must the line after it').toBe(true)
    expect(s.visible().some((l) => l === 'card line 0'), 'the head scrolled away').toBe(false)
    expect(s.rows.length).toBe(30)
  })

  it('wraps at the right margin instead of overwriting the last cell', () => {
    const s = renderScreen('abcdefghijkl\n', 4, 10)
    expect(s.lineAt(0)).toBe('abcdefghij')
    expect(s.lineAt(1), 'a terminal continues on the next row; the old model stamped on cell 9').toBe('kl')
  })

  it('wrapping that reaches the bottom scrolls rather than braiding one row', () => {
    const s = renderScreen('aaaaaaaaaaaaaaaaaaaa', 2, 10)   // 20 columns of input into a 10×2 screen
    expect(s.lineAt(0)).toBe('aaaaaaaaaa')
    expect(s.lineAt(1), 'the overflow occupies the second row').toBe('aaaaaaaaaa')
  })

  it('cursor-up after a scroll addresses the row that is NOW on screen', () => {
    // Two rows, three lines: the screen scrolled once. `ESC[1A` from the bottom row must land on the
    // row that is VISIBLE above it, and writing there must change that row — not a row that has gone
    // by. This is the property Ink's `eraseLines` depends on, so a model that got it wrong would hide
    // the #99 cursor class rather than reveal it.
    const s = renderScreen('AAA\r\nBBB\r\nCCC\x1b[1A\x1b[GX', 2, 10)
    expect(s.lineAt(1), 'the bottom row still shows the last line written').toBe('CCC')
    expect(s.lineAt(0), 'and the cursor moved up onto the row now at the top').toBe('XBB')
    expect(s.visible().length).toBe(2)
  })

  it('ESC[M (index) scrolls at the bottom margin too', () => {
    const s = renderScreen('aaa\r\nbbb\x1b[M\rz', 2, 10)
    expect(s.visible()).toEqual(['bbb', 'z'])
  })

  it('a full-screen redraw (ESC[2J ESC[H) still starts at the top after scrolling', () => {
    const s = renderScreen('old1\nold2\nold3\x1b[2J\x1b[Hfresh', 2, 20)
    expect(s.lineAt(0)).toBe('fresh')
    expect(s.findRow('old1')).toBe(-1)
  })
})
})
