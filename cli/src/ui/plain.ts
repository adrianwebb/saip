/**
 * Plain renderer (#113): the fallback that pipes, CI, agents and log collectors get, and the one that
 * must never contain box-drawing or ANSI. A card is a heading plus `label: value` lines; the framed
 * box primitive lives in `ui/card.ts` and the Ink renderer owns framed presentation.
 */
import { PREFIX, type Block, type KvRow } from './blocks.js'
import type { Renderer } from './renderer.js'


export const plainRenderer: Renderer = {
  kind: 'plain',
  renderAll: (blocks: Block[]): string => blocks.map((b) => plainRenderer.render(b)).join('\n'),
  render(block: Block): string {
    switch (block.kind) {
      case 'card': {
        // The pipe format from #82/#88, owned by the renderer rather than by each command:
        //   -- NAME (required)
        //      what    : …
        // No frame characters, because a log collector cannot use them and `grep --` still finds the
        // block header. Two earlier versions of this case got it wrong — an ASCII box (which kept
        // emitting `+---+` into pipes) and a bare `NAME (required)` heading, which silently changed
        // `config help` output and was caught by the assembled-program test counting `-- SAIP_`.
        const head = block.spec.badge ? `-- ${block.spec.title} (${block.spec.badge})` : `-- ${block.spec.title}`
        return [head, ...block.spec.fields.map((f) => `   ${f.label.padEnd(8)}: ${f.value}`)].join('\n')
      }
      case 'keyValues': {
        // `label:` with the colon inside the padded field, so `Adapters:  3 defined` stays matchable
        // by `grep 'Adapters:'` — the property that makes this output usable in logs and CI.
        const cell = (r: KvRow): string => (r.label ? `${r.label}: ` : '')
        const w = block.rows.reduce((m, r) => Math.max(m, cell(r).length), 0)
        return block.rows
          .map((r) => `  ${cell(r).padEnd(w)}${r.value}${r.hint ? `   (${r.hint})` : ''}`)
          .join('\n')
      }
      case 'columns': {
        const widths = block.header.map((h, i) =>
          Math.max(h.length, ...block.rows.map((r) => (r[i] ?? '').length)))
        // The FIRST column is padded as well. It was not, so `row()` emitted each row's remaining cells
        // at an offset measured from its own name: a two-character label and a fourteen-character one
        // put `min VRAM` in different places on consecutive lines. The table is the whole point of a
        // columns block, and nothing asserted the alignment until #156 produced real bytes to look at.
        const row = (cells: string[]): string =>
          `  ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[0]) : c.padStart(widths[i]))).join('  ')}`
        return [row(block.header.slice()), ...block.rows.map((r) => row(block.header.map((_, i) => r[i] ?? '')))].join('\n')
      }
      case 'line': {
        const level = block.level ?? 'info'
        return `${PREFIX[level]} ${block.text}`
      }
      case 'list':
        // Names with optional annotations, indented and unprefixed: this is a listing, not a message.
        return block.items.map((i) => `  ${i}`).join('\n')
      case 'note':
        // Continuation of the message above it, so it carries no `[saip] ` marker.
        return `   ${block.text}`
      case 'blank':
        return ''
      case 'raw':
        // Verbatim: the wizard's own wording, prefix and indentation included.
        return block.lines.join('\n')
      case 'rule':
        return '-'.repeat(Math.max(1, block.width))
    }
  },
}
