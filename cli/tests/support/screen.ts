/**
 * A deliberately small VT100-ish screen model (#154).
 *
 * "Did the explanation end up above the prompt, and did the typed value land ON the prompt's line?" is
 * a question about the *screen*, not about the byte stream: Ink erases with `ESC[2K`/`ESC[1A` and
 * positions with `ESC[nG`, so raw output cannot answer it and eyeballing a terminal cannot be asserted
 * by CI. This emulator handles exactly the sequences Ink 8 emits (measured: `eraseLines`,
 * `cursorTo`, `cursorUp/Down`, `eraseDown`, `home`, BSU/ESU, optional alt screen) and nothing else.
 *
 * It is used as evidence, so it is falsifiable: `screen.test.ts` feeds it known sequences and asserts
 * the resulting grid, including the trap that an unhandled sequence must leave VISIBLE residue rather
 * than vanish — a model that silently ate `ESC[2K` would make every ordering probe pass.
 */
const ESC = '\x1b'

export class Screen {
  readonly rows: string[][]
  readonly cols: number
  cx = 0
  cy = 0
  /** Sequences this model did not understand, kept verbatim so a gap shows up as evidence. */
  readonly unparsed: string[] = []
  altScreen = false

  constructor(rows = 24, cols = 80) {
    this.rows = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '))
    this.cols = cols
  }

  feed(text: string): this {
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch === ESC) { i = this.escape(text, i); continue }
      if (ch === '\r') { this.cx = 0; i++; continue }
      if (ch === '\n') { this.cy = Math.min(this.cy + 1, this.rows.length - 1); i++; continue }
      if (ch === '\b') { this.cx = Math.max(0, this.cx - 1); i++; continue }
      if (ch === '\t') { this.cx = Math.min(this.cols - 1, this.cx + 8 - (this.cx % 8)); i++; continue }
      if (ch < ' ') { i++; continue }                       // controls already acted on by raw mode
      this.rows[this.cy][this.cx] = ch
      this.cx = Math.min(this.cx + 1, this.cols - 1)
      i++
    }
    return this
  }

  /** Returns the index after the consumed escape. */
  private escape(text: string, start: number): number {
    const next = text[start + 1]
    if (next === undefined) return start + 1
    if (next === '[') {
      let j = start + 2
      let params = ''
      let inter = ''
      while (j < text.length && text[j] >= '\x30' && text[j] <= '\x3f') { params += text[j]; j++ }
      while (j < text.length && text[j] >= '\x20' && text[j] <= '\x2f') { inter += text[j]; j++ }
      const final = text[j]
      if (final === undefined) { this.unparsed.push(text.slice(start)); return text.length }
      this.csi(params + inter, final)
      return j + 1
    }
    if (next === '(' || next === ')') return start + 3      // charset designators: two operands
    if (next === 'M') { this.rows[this.cy].fill(' '); return start + 3 }
    this.unparsed.push(text.slice(start, start + 2))
    return start + 2
  }

  private csi(params: string, final: string): void {
    const n = (def: number): number => (params === '' ? def : Number.parseInt(params, 10) || 0)
    const at = (v: number): number => Math.max(0, Math.min(v, this.rows.length - 1))
    const col = (v: number): number => Math.max(0, Math.min(v, this.cols - 1))
    switch (final) {
      case 'A': this.cy = at(this.cy - n(1)); return
      case 'B': case 'e': this.cy = at(this.cy + n(1)); return
      case 'C': this.cx = col(this.cx + n(1)); return
      case 'D': this.cx = col(this.cx - n(1)); return
      case 'G': case '`': this.cx = col(n(1) - 1); return
      case 'd': this.cy = at(n(1) - 1); return
      case 'H': case 'f': {
        const [r, c] = params.split(';').map((x) => Number.parseInt(x, 10) || 1)
        this.cy = at((r || 1) - 1); this.cx = col((c || 1) - 1); return
      }
      case 'J': {
        const mode = n(0)
        if (mode === 2 || mode === 3) { this.rows.forEach((r) => r.fill(' ')); this.cy = 0; this.cx = 0; return }
        for (let y = this.cy; y < this.rows.length; y++) {
          const from = y === this.cy ? this.cx : 0
          for (let x = from; x < this.cols; x++) this.rows[y][x] = ' '
        }
        return
      }
      case 'K': {
        const mode = n(0)
        const row = this.rows[this.cy]
        if (mode === 0) for (let x = this.cx; x < this.cols; x++) row[x] = ' '
        else if (mode === 1) for (let x = 0; x < this.cx; x++) row[x] = ' '
        else row.fill(' ')
        return
      }
      case 's': this.saved = { x: this.cx, y: this.cy }; return
      case 'u': if (this.saved) { this.cx = this.saved.x; this.cy = this.saved.y } return
      case 'h': case 'l': {
        // DEC private modes: only the ones Ink can emit are modelled; others are recorded.
        if (params === '?1049') { this.altScreen = final === 'h'; if (this.altScreen) this.rows.forEach((r) => r.fill(' ')); return }
        if (params === '?25') return                        // cursor visibility: no glyph effect
        if (params === '?2004' || params === '?2026' || params === '?1049') return
        if (params === '?1049') return
        this.unparsed.push(`${ESC}[${params}${final}`)
        return
      }
      default:
        this.unparsed.push(`${ESC}[${params}${final}`)
    }
  }
  private saved?: { x: number; y: number }

  /** The screen as text, trailing spaces stripped. */
  toString(): string {
    return this.rows.map((r) => r.join('').replace(/\s+$/, '')).join('\n')
  }

  /** Rows in order, blanks collapsed away — what a human would say they can read. */
  visible(): string[] {
    return this.rows.map((r) => r.join('').replace(/\s+$/, '')).filter((l) => l.length > 0)
  }

  lineAt(y: number): string { return (this.rows[y] ?? []).join('').replace(/\s+$/, '') }

  /** First row index containing `needle`, or -1. */
  findRow(needle: string | RegExp): number {
    const re = typeof needle === 'string' ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : needle
    return this.rows.findIndex((r) => re.test(r.join('')))
  }
}

/** Parse a byte stream into a screen. */
export function renderScreen(text: string, rows = 24, cols = 80): Screen {
  return new Screen(rows, cols).feed(text)
}
