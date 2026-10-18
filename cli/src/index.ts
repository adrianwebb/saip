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
import { AdapterRegistryService, HostRegistryService, SecretsService } from '@saip/shared/services'
import { EnvSecrets } from '@saip/shared'
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
  await ctx.plugin(SecretsService, { provider: new EnvSecrets() })
  await ctx.plugin(HostRegistryService, { path: process.env.SAIP_HOSTS_FILE ?? 'hosts.yaml' })
  await ctx.plugin(CommandRegistryService)

  // Load every command plugin so they self-register.
  for (const plugin of COMMAND_PLUGINS) {
    await ctx.plugin(plugin)
  }

  const program = new Command()
    .name('saip')
    .description('Simple AI Platform — manage inference and training services')
    .version('0.4.0')

  for (const spec of ctx.commandRegistry!.list()) {
    const cmd = new Command(spec.name).description(spec.description)
    for (const opt of spec.options ?? []) cmd.option(opt.flag, opt.description)
    cmd.action(async (options: Record<string, unknown>) => {
      try {
        await spec.action(ctx, options)
      } catch (err: any) {
        // Fail closed with a readable line instead of a raw stack trace.
        console.error(`[saip] error: ${err?.message ?? err}`)
        process.exitCode = 1
      }
    })
    program.addCommand(cmd)
  }

  return program
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void buildProgram().then((program) => program.parse())
}
