#!/usr/bin/env node

/**
 * SAIP CLI — manage inference and training services.
 *
 * A Cordis application: command plugins register themselves with the shared
 * CommandRegistryService, and this dispatcher drains that registry into the
 * commander surface. Adding a command = adding a plugin, never editing here.
 */

import { Command } from 'commander'
import { Context } from 'cordis'
import { AdapterRegistryService } from '@saip/shared/services'
import { CommandRegistryService } from './lib/command-registry.js'

// Command plugins (each registers itself on load via ctx.commandRegistry).
import awakePlugin from './commands/awake.js'
import sleepPlugin from './commands/sleep.js'
import downPlugin from './commands/down.js'
import statusPlugin from './commands/status.js'

const COMMAND_PLUGINS = [awakePlugin, sleepPlugin, downPlugin, statusPlugin]

export async function buildProgram(): Promise<Command> {
  const ctx = new Context()
  await ctx.plugin(AdapterRegistryService)
  await ctx.plugin(CommandRegistryService)

  // Load every command plugin so they self-register.
  for (const plugin of COMMAND_PLUGINS) {
    await ctx.plugin(plugin)
  }

  const program = new Command()
    .name('saip')
    .description('Simple AI Platform — manage inference and training services')
    .version('0.3.0')

  for (const spec of ctx.commandRegistry!.list()) {
    const cmd = new Command(spec.name).description(spec.description)
    for (const opt of spec.options ?? []) cmd.option(opt.flag, opt.description)
    cmd.action((options: Record<string, unknown>) => spec.action(ctx, options))
    program.addCommand(cmd)
  }

  return program
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void buildProgram().then((program) => program.parse())
}
