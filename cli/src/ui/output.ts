/**
 * `uiOr(ctx)` — how a command reaches the presentation seam (#113).
 *
 * Commands should use `ctx.ui`. The fallback exists for the many unit tests that build a bare context
 * object, and for a command invoked before the plugin graph is booted. Rather than construct a Cordis
 * `Service` against a non-`Context` (which would throw, or worse, half-work), the fallback writes
 * through `plainRenderer` directly — the same choice the service itself makes for a non-TTY stream, so
 * "no plugin graph" and "piped output" produce identical bytes.
 *
 * This is deliberately NOT a silent substitute for the seam: `ctx.ui` is used whenever it exists, so
 * renderer selection, `--json` records and `structured` all behave identically in production.
 */
import { plainRenderer } from './plain.js'
import { lineBlock, type Block } from './blocks.js'

export interface LinePrinter {
  showLine(text: string, level?: 'info' | 'warn' | 'error'): void
  show(block: Block): void
  showAll(blocks: Block[]): void
}

export function uiOr(ctx: any): LinePrinter {
  const ui = ctx?.ui
  if (ui?.showLine && ui?.show) return ui as LinePrinter
  return {
    showLine: (text: string, level: 'info' | 'warn' | 'error' = 'info'): void => {
      process.stdout.write(`${plainRenderer.render(lineBlock(text, level))}\n`)
    },
    show: (block: Block): void => {
      process.stdout.write(`${plainRenderer.render(block)}\n`)
    },
    showAll: (blocks: Block[]): void => {
      process.stdout.write(`${plainRenderer.renderAll(blocks)}\n`)
    },
  }
}
