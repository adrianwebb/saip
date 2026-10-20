
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
import { EnvSecrets, SecretAccessService } from '@saip/shared'
import { CommandRegistryService } from './lib/command-registry.js'
import { DisplayService } from './lib/display.js'

// Command plugins (each registers itself on load via ctx.commandRegistry).
import awakePlugin from './commands/awake.js'
import sleepPlugin from './commands/sleep.js'
import downPlugin from './commands/down.js'
import statusPlugin from './commands/status.js'
import deployPlugin from './commands/deploy.js'
import profilesPlugin from './commands/profiles.js'
import configPlugin from './commands/config.js'
import sshPlugin from './commands/ssh.js'

const COMMAND_PLUGINS = [awakePlugin, sleepPlugin, downPlugin, statusPlugin, deployPlugin, profilesPlugin, configPlugin, sshPlugin]

export async function buildProgram(): Promise<Command> {
  const ctx = new Context()
  await ctx.plugin(AdapterRegistryService)
  await ctx.plugin(SecretsService, {})
  await ctx.plugin(HostRegistryService, {})
  // The gateway that owns unlocking and the audit record (#93). One per process.
  await ctx.plugin(SecretAccessService, {})
  await ctx.plugin(CommandRegistryService)
  // Cards for humans, plain lines for pipes — the choice is made once, here (#88).
  await ctx.plugin(DisplayService, {})

  // Load every command plugin so they self-register.
  for (const plugin of COMMAND_PLUGINS) {
    await ctx.plugin(plugin)
  }

  const program = new Command()
    .name('saip')
    .description('Simple AI Platform — manage inference and training services')
    .version('0.5.0')

  for (const spec of ctx.commandRegistry!.list()) {
    const cmd = new Command(spec.name).description(spec.description)
    for (const opt of spec.options ?? []) cmd.option(opt.flag, opt.description)
    // `.argument()` describes ONE parameter; a multi-word spec must go through `.arguments()`.
    // Passing '<action> [name]' to .argument() registers a single argument and then rejects every
    // two-word call — which only a real CLI invocation caught, not the unit suite.
    if (spec.positional) {
      const specs = spec.positional.trim().split(/\s+(?=[<\[])/)
      if (specs.length === 1) cmd.argument(specs[0], spec.positionalDescription ?? '')
      else cmd.arguments(specs.join(' '))
    }
    cmd.action(async (...argv: unknown[]) => {
      // Commander's action signature is (…declaredArgs, options, command). Taking the last
      // element yields the Command object, not the options — which silently made every flag
      // read as falsy. Detect the trailing Command by its opts() method instead of counting
      // from the end, so this holds whether or not a command declares positionals.
      const last = argv[argv.length - 1]
      const hasCommand = typeof (last as { opts?: unknown })?.opts === 'function'
      const head = hasCommand ? argv.slice(0, -1) : argv
      const options = (head[head.length - 1] ?? {}) as Record<string, unknown>
      const positional = (spec.positional ? head.slice(0, -1) : []).map(String)
      try {
        await spec.action(ctx, options ?? {}, positional)
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

/**
 * Run the CLI. `bin.ts` calls this and nothing else does — see that file for why entry detection
 * was removed rather than fixed (#101).
 *
 * `argv` defaults to the real process arguments, with the two node prefixes stripped the way
 * commander expects; tests and a future programmatic `saip.api()` can pass their own.
 */
export async function runCli(argv: string[] = process.argv): Promise<number> {
  const program = await buildProgram()
  await program.parseAsync(argv)
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}
