/**
 * `ui` — the terminal presentation seam (#106, #113).
 *
 * Why a seam at all: SAIP's hand-rolled terminal code produced five bug reports in one session
 * (prompt-before-explanation twice, paste lockup, cursor on the wrong line, leftover input shifting
 * answers), and every command also formatted its own output, so the same idea had six implementations.
 * The maintainer's call was to build on a maintained TUI framework and to abstract the layer while only
 * one screen used it.
 *
 * What is pluggable, and what is not (#113):
 *   - `Renderer` IS the plugin seam — it is the layer that genuinely varies by stream (TTY vs pipe) and
 *     by target (a future `--json` or dashboard renderer needs no command changes).
 *   - the components are plain exports. A `Card` has nothing to substitute; putting it behind a
 *     string-keyed registry would trade typechecking for runtime lookup and turn "does not compile" into
 *     "renders nothing". #91 already removed one UI indirection that had no second implementation.
 *
 * Renderer selection is by **capability of the attached stream**, never a flag a user has to know:
 *
 *   ink    a real TTY with a UTF-8 locale
 *   plain  pipes, CI, agents, log capture, `TERM=dumb`, non-UTF-8 locales
 *
 * The plain path is load-bearing, not a courtesy: #88/#103 measured that a COMPILED Ink binary writes
 * nothing at all to a pipe, and that Ink does not degrade under `TERM=dumb`.
 *
 * Migration staging, so no PR is both a refactor and a behaviour change: screens move to this service
 * one at a time (`status`, then `config`/`ssh`, then the wizard), and `DisplayService` is retired only
 * after the last one has gone.
 */
import { Service, type Context } from 'cordis'
import type { CardSpec } from '../ui/card.js'
import type { DisplayOptions } from '../ui/card.js'
import { detectDisplay } from '../ui/card.js'
import { kvBlock, columnsBlock, lineBlock, ruleBlock, type Block, type KvRow } from '../ui/blocks.js'
import type { Renderer } from '../ui/renderer.js'
import { plainRenderer } from '../ui/plain.js'
import { inkRenderer } from '../ui/ink.js'
import { jsonlRenderer } from '../ui/json.js'
import { ttyEngine, type InputEngine } from '../ui/input.js'

declare module 'cordis' {
  interface Context { ui?: UiService }
}

export const UI_SERVICE = 'ui'
export type UiMode = 'ink' | 'plain'

export { renderInkToString, inkRenderer } from '../ui/ink.js'
export { Card, Columns, KeyValues, Line, Rule } from '../ui/components.js'
export { ttyEngine } from '../ui/input.js'
export type { InputEngine, AskOptions } from '../ui/input.js'
export { CardView } from '../ui/compat.js'
export type { Renderer } from '../ui/renderer.js'
export type { Block, KvRow } from '../ui/blocks.js'

/** Capability test, kept separate so it can be asserted without a terminal. */
export function chooseMode(env: NodeJS.ProcessEnv = process.env, isTTY = false, inkEnabled = true): UiMode {
  const d = detectDisplay(env, isTTY)
  // detectDisplay encodes "UTF-8 locale and not TERM=dumb" as `unicode`; Ink's box drawing is exactly
  // the thing that assumption protects.
  if (!isTTY || !d.unicode) return 'plain'
  return inkEnabled ? 'ink' : 'plain'
}

export interface UiConfig {
  /**
   * Where rendered text goes. Defaults to stdout. Injectable because a screen that writes to the
   * process cannot be asserted without replacing the process — which is how this repo's tests ended up
   * monkey-patching `console.log`, and why the seam owns the sink instead.
   */
  out?: (text: string) => void
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
  /** Set false to force the plain path even on a TTY (used by tests and by `--no-color`-style escapes). */
  ink?: boolean
  /** Replace the renderer entirely — the plugin seam (#113). */
  renderer?: Renderer
  /** Replace the input engine — the same idea for reading values (#106 slice 3). */
  input?: InputEngine
}

export class UiService extends Service {
  static readonly provide = UI_SERVICE
  readonly mode: UiMode
  readonly display: DisplayOptions
  private readonly out: (text: string) => void
  private active: Renderer
  private readonly registry = new Map<string, Renderer>()
  private activeInput: InputEngine
  private readonly inputRegistry = new Map<string, InputEngine>()

  constructor(ctx: Context, config: UiConfig = {}) {
    super(ctx, UI_SERVICE)
    const isTTY = config.isTTY ?? Boolean(process.stdout.isTTY)
    this.out = config.out ?? ((t: string) => { process.stdout.write(t) })
    this.mode = chooseMode(config.env ?? process.env, isTTY, config.ink ?? true)
    this.display = detectDisplay(config.env ?? process.env, isTTY)
    this.active = config.renderer ?? (this.mode === 'ink' ? inkRenderer : plainRenderer)
    this.activeInput = config.input ?? ttyEngine
    this.inputRegistry.set(ttyEngine.kind, ttyEngine)
    this.registry.set(plainRenderer.kind, plainRenderer)
    this.registry.set(inkRenderer.kind, inkRenderer)
    // Registered but never the default: a machine target is chosen, not inferred from the stream
    // (#113). `--json` activates it; nothing about the terminal can silently switch an agent's output.
    this.registry.set(jsonlRenderer.kind, jsonlRenderer)
  }

  /** Which renderer is currently producing output. */
  get rendererKind(): string { return this.active.kind }

  /** Which input engine reads values. */
  get inputKind(): string { return this.activeInput.kind }
  inputNames(): string[] { return [...this.inputRegistry.keys()] }

  /**
   * Register an input engine (validated for the same reason renderers are: a broken engine fails on the
   * first secret prompt, far from the mistake). `activate` makes it the one commands use.
   */
  registerInput(engine: InputEngine, options: { activate?: boolean } = {}): void {
    if (!engine || typeof engine.kind !== 'string' || engine.kind === '') {
      throw new TypeError('registerInput: engine.kind must be a non-empty string')
    }
    if (typeof engine.ask !== 'function') {
      throw new TypeError(`registerInput: engine "${engine.kind}" has no ask() method`)
    }
    this.inputRegistry.set(engine.kind, engine)
    if (options.activate) this.activeInput = engine
  }

  useInput(kind: string): void {
    const engine = this.inputRegistry.get(kind)
    if (!engine) throw new TypeError(`no input engine named "${kind}"; registered: ${this.inputNames().join(', ')}`)
    this.activeInput = engine
  }

  /**
   * Read one value. Commands call this instead of importing a prompt implementation, so the terminal
   * semantics stay in one tested place and the mechanism remains swappable (#106 slice 3).
   */
  prompt(question: string, opts: { secret?: boolean; echo?: boolean; stream?: import('node:tty').ReadStream } = {}): Promise<string> {
    return this.activeInput.ask(question, opts)
  }

  /** True when the active renderer produces machine records, so commands skip decoration. */
  get structured(): boolean { return this.active.kind === 'jsonl' }

  /** Registered renderer names — plain, ink, jsonl, and anything a plugin adds. */
  rendererNames(): string[] { return [...this.registry.keys()] }

  /**
   * Register (or replace) a renderer. Validated rather than trusted, because a renderer that is
   * missing its `render` would otherwise fail at the first command that printed something — far from
   * the mistake, and only in the environment that loaded the plugin.
   */
  registerRenderer(renderer: Renderer, options: { activate?: boolean } = {}): void {
    if (!renderer || typeof renderer.kind !== 'string' || renderer.kind === '') {
      throw new TypeError('registerRenderer: renderer.kind must be a non-empty string')
    }
    if (typeof renderer.render !== 'function') {
      throw new TypeError(`registerRenderer: renderer "${renderer.kind}" has no render() function`)
    }
    this.registry.set(renderer.kind, renderer)
    if (options.activate) this.active = renderer
  }

  /** Activate a registered renderer by name (e.g. from a flag or a host configuration). */
  useRenderer(kind: string): void {
    const r = this.registry.get(kind)
    if (!r) throw new TypeError(`no renderer named "${kind}"; registered: ${this.rendererNames().join(', ')}`)
    this.active = r
  }

  /** Render any block. Commands may use this directly when a convenience method does not fit. */
  render(block: Block): string { return this.active.render(block) }

  card(spec: CardSpec): string { return this.active.render({ kind: 'card', spec }) }
  keyValues(rows: KvRow[]): string { return this.active.render(kvBlock(rows)) }
  columns(header: string[], rows: string[][]): string { return this.active.render(columnsBlock(header, rows)) }
  line(text: string, level: 'info' | 'warn' | 'error' = 'info'): string { return this.active.render(lineBlock(text, level)) }
  rule(width = this.display.columns): string { return this.active.render(ruleBlock(width)) }

  /** Write a block to the configured sink. Commands that print should call these, not `console.log`. */
  show(block: Block): void { this.out(`${this.active.render(block)}\n`) }
  showLine(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.out(`${this.line(text, level)}\n`)
  }
  /** Render and write several blocks in order — the common "print a report" shape. */
  showAll(blocks: Block[]): void { for (const b of blocks) this.show(b) }

  /**
   * Write to stderr. Errors stay human text on stderr even in `--json` mode: the stream invariant
   * (#115) is about **stdout**, and moving diagnostics into the record stream would make `jq` read
   * them as data. A command that fails while structured also gets a `line` record on stdout when the
   * dispatcher or command chooses to emit one — this method is only the human channel.
   */
  fail(text: string): void { process.stderr.write(`${text.startsWith('[saip') ? text : `[saip] ${text}`}\n`) }
}
