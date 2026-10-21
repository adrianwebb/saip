
/**
 * SAIP CLI — manage inference and training services.
 *
 * A Cordis application: command plugins register themselves with the shared
 * CommandRegistryService, and this dispatcher drains that registry into the
 * commander surface. Adding a command = adding a plugin, never editing here.
 */

import { Command, Option } from 'commander'
import { Context } from 'cordis'
import { AdapterRegistryService, HostRegistryService, SecretsService } from '@saip/shared/services'
import { EnvSecrets, SecretAccessService } from '@saip/shared'
import { CommandRegistryService } from './lib/command-registry.js'
import { SAIP_BUILD_COMMIT, SAIP_BUILD_DATE, SAIP_BUILD_TARGET, SAIP_VERSION } from './version.js'
import { DisplayService } from './lib/display.js'
import { UiService } from './lib/ui.js'
import { jsonlRenderer } from './ui/json.js'
import { isStructuredCommand, jsonModeOn, redirectHumanStdout, setJsonMode, unsupportedRecord } from './lib/json-mode.js'

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
  // The #106 seam. Registered alongside DisplayService rather than replacing it: screens move to
  // `ui` one at a time, and the old path stays live until the last one has gone.
  await ctx.plugin(UiService, {})

  // Load every command plugin so they self-register.
  for (const plugin of COMMAND_PLUGINS) {
    await ctx.plugin(plugin)
  }

  const program = new Command()
    .name('saip')
    .description('Simple AI Platform — manage inference and training services')
    .version(SAIP_VERSION)

  for (const spec of ctx.commandRegistry!.list()) {
    const cmd = new Command(spec.name).description(spec.description)
    for (const opt of spec.options ?? []) cmd.option(opt.flag, opt.description)
    // Every command may be asked for machine output, so every command answers the same way (#113).
    // Declared per command rather than as a commander global because the option must appear in
    // `cmd.action`'s own opts object; a program-level global would need `program.opts()` everywhere.
    // Only declare it if the command has not already: `profiles` ships its own `--json` spec entry,
    // and commander throws on a duplicate option name — which aborted buildProgram for EVERY command,
    // so `awake --json` returned exit 1 with empty stdout. Guarded rather than assumed.
    if (!(spec.options ?? []).some((o) => o.flag.split(/[\s[]/)[0] === '--json')) {
      cmd.addOption(new Option('--json', 'Output JSONL records on stdout (for scripts and agents)'))
    }
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
      // The `--json` invariant (#113): stdout is valid JSONL or the command says why it cannot be.
      if ((options as Record<string, unknown>)?.json) {
        setJsonMode(true)
        // The machine target is a renderer choice, not a per-command code path (#113): switching the
        // service here means any command that renders blocks gets valid JSONL for free. Commands that
        // have not migrated are short-circuited below rather than emitting prose into the stream.
        ctx.ui?.useRenderer('jsonl')
        const restore = redirectHumanStdout()
        try {
          if (!isStructuredCommand(spec.name)) {
            // Short-circuit BEFORE the action. `saip awake --json` from an agent must not switch a
            // stack: an unsupported command answers with a record and exit 2, and does nothing else.
            process.stdout.write(`${jsonlRenderer.render(unsupportedRecord(spec.name))}\n`)
            process.exitCode = 2
            return
          }
          try {
            await spec.action(ctx, options, positional)
          } catch (err: any) {
            // The invariant is about the STREAM, so it has to hold when an action throws part way
            // through — `ssh --json` with no store on disk failed here and printed nothing, which is
            // indistinguishable from "no results". A record plus a non-zero exit is the honest form.
            const message = err?.message ?? String(err)
            process.stdout.write(`${jsonlRenderer.render({
              kind: 'line', level: 'error', text: message,
              data: { code: 'command_failed', command: spec.name },
            })}\n`)
            console.error(`[saip] error: ${message}`)
            process.exitCode = typeof process.exitCode === 'number' && process.exitCode !== 0 ? process.exitCode : 1
          }
        } finally {
          setJsonMode(false)
          restore()
        }
        return
      }
      setJsonMode(false)
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
/**
 * Provenance for the artifact, not the checkout (#119). Scanned from argv **before** commander runs,
 * so `saip-dev --built` answers even when the rest of the environment is broken — which is precisely the
 * moment an operator needs to know what this file is. Printed to stderr when `--json` is active, so the
 * stream invariant (#115) holds and this line can never be mistaken for a record.
 */
export function buildProvenance(): string {
  return `saip build: commit=${SAIP_BUILD_COMMIT} target=${SAIP_BUILD_TARGET} version=${SAIP_VERSION} builtAt=${SAIP_BUILD_DATE}`
}

export async function runCli(argv: string[] = process.argv): Promise<number> {
  if (argv.includes('--built')) {
    const machine = argv.includes('--json')
    ;(machine ? process.stderr : process.stdout).write(`${buildProvenance()}\n`)
    return 0
  }
  const program = await buildProgram()
  await program.parseAsync(argv)
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}
