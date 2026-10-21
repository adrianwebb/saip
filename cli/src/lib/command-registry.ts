/**
 * Command registry — the Cordis service CLI commands register themselves with.
 *
 * Each command plugin calls `ctx.commandRegistry.register({ name, description, ... })`
 * at load time; the dispatcher (index.ts) drains the registry into commander.
 * Adding a new command = adding a plugin, never editing the dispatcher.
 */

import { Service } from 'cordis'
import type { Context } from 'cordis'

export interface CommandSpec {
  name: string
  description: string
  /**
   * Run the command with its parsed argv options, the CLI Cordis context, and any positional
   * arguments in declared order.
   */
  action: (ctx: Context, options: Record<string, unknown>, positional?: string[]) => void | Promise<void>
  /** Optional `--bucket <name>` style option flags. */
  options?: Array<{ flag: string; description: string }>
  /**
   * Commander argument spec, e.g. `<action> [name] [value]`. Declared only by commands that take
   * positionals; the dispatcher keeps the argument-less path exactly as it was so existing
   * commands are unaffected.
   */
  positional?: string
  /** Help text shown with `positional`. */
  positionalDescription?: string
}

declare module 'cordis' {
  interface Context {
    commandRegistry?: CommandRegistryService
  }
}

export class CommandRegistryService extends Service {
  static readonly provide = 'commandRegistry'

  private readonly commands = new Map<string, CommandSpec>()

  constructor(ctx: any) {
    super(ctx, 'commandRegistry')
  }

  register(spec: CommandSpec): void {
    this.commands.set(spec.name, spec)
  }

  list(): CommandSpec[] {
    return [...this.commands.values()]
  }

  get(name: string): CommandSpec | undefined {
    return this.commands.get(name)
  }
}
