/**
 * Ink renderer (#113) — the components above, drawn for a real terminal.
 *
 * `renderInkToString` renders a component to text and returns it, rather than letting Ink own the
 * stream. That is deliberate for now: commands interleave output with prompts, and an Ink process that
 * keeps a live frame would move the cursor the way the bare-`\n` bug did (#99). One-shot frames keep the
 * write order under the command's control while still giving us Ink's wrapping and box layout. The
 * trade-off is recorded in #106: no live redraws yet, which is what a status/dashboard screen will want,
 * and that is when Ink should take the stream instead of returning frames.
 */
import React from 'react'
import { render, type RenderOptions } from 'ink'
import { Blank, Card, Columns, KeyValues, Line, List, Note, Rule } from './components.js'
import type { Block } from './blocks.js'
import type { Renderer } from './renderer.js'

/**
 * Render an element to a string through a collecting fake stream.
 *
 * This is also what makes the ink path *testable* rather than only observable by a human at a terminal.
 * Non-TTY here is intentional and is a different question from the runtime fact recorded in #88/#103 —
 * a **compiled** Ink binary writes nothing to a pipe — so a captured frame proves the component is sound
 * independently of how a bundled runtime streams it.
 */
export function renderInkToString(el: React.ReactElement, columns = 80): string {
  const written: string[] = []
  const stdout = {
    write: (s: string | Uint8Array) => { written.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8')); return true },
    columns,
    isTTY: false as const,
    setEncoding: () => stdout,
    on: () => stdout, once: () => stdout, off: () => stdout, removeListener: () => stdout, emit: () => false,
  }
  const stdin = {
    isTTY: false as const,
    setRawMode: () => stdin, setEncoding: () => stdin, resume: () => stdin, pause: () => stdin,
    on: () => stdin, once: () => stdin, off: () => stdin, removeListener: () => stdin, emit: () => false,
    read: () => null,
  }
  const options = {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false,
  } as unknown as RenderOptions
  const instance = render(el, options)
  const frame = written.join('')
  try { instance.unmount() } catch { /* teardown of a synthetic render must never throw outward */ }
  return frame
}

export const inkRenderer: Renderer = {
  kind: 'ink',
  renderAll: (blocks: Block[]): string => blocks.map((b) => inkRenderer.render(b)).join('\n'),
  render(block: Block): string {
    switch (block.kind) {
      case 'card': return renderInkToString(<Card spec={block.spec} />)
      case 'keyValues': return renderInkToString(<KeyValues rows={block.rows} />)
      case 'columns': return renderInkToString(<Columns header={block.header} rows={block.rows} />)
      case 'line': return renderInkToString(<Line text={block.text} level={block.level} />)
      case 'list': return renderInkToString(<List items={block.items} />)
      case 'note': return renderInkToString(<Note text={block.text} />)
      case 'blank': return renderInkToString(<Blank />)
      case 'rule': return renderInkToString(<Rule width={block.width} />)
    }
  },
}
