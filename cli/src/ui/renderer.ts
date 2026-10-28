/**
 * The plugin seam (#113). This is the piece that is genuinely substitutable — per stream (TTY vs pipe),
 * and per target (a future `--json` renderer or dashboard needs no command changes) — so it is the
 * thing that gets an interface and a registry, while the components above it stay plain exports.
 *
 * Implementations must be **pure**: given a block, return the text to write. Streaming, cursor
 * handling and redraws belong to Ink inside the renderer, never to the interface, so a caller cannot
 * tell which engine produced a line.
 */
import type { Block } from './blocks.js'

export interface Renderer {
  readonly kind: string
  render(block: Block): string
  /** A command result is a SEQUENCE of blocks; joining is part of the renderer's job, not each caller's. */
  renderAll(blocks: Block[]): string
}
