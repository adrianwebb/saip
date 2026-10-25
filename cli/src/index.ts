
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
import { UiService } from './lib/ui.js'
// The terminal handle is released by whoever owns the process lifecycle (#172).
import { releaseTty } from './ui/prompt.js'
import { jsonlRenderer } from './ui/json.js'
import { classifyCommanderError, isStructuredCommand, jsonModeOn, parseRecord, redirectHumanStdout, setJsonMode, suppressHumanText, takeSuppressedText, unsupportedRecord } from './lib/json-mode.js'

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

/**
 * Hand commander's parse-level decisions back to the dispatcher instead of letting it exit.
 *
 * Applied to the program AND to every subcommand: `addCommand` does not carry `exitOverride` or
 * `configureOutput` across, so setting only the program left `saip config --json` calling
 * `process.exit` inside the subcommand — the reason the first version of #147 still printed nothing
 * for a missing argument while working fine for `--version`.
 */
function parseGuard<T extends Command>(cmd: T): T {
  return cmd
    .exitOverride()
    .configureOutput({
      writeOut: (text) => { if (jsonModeOn()) suppressHumanText(text); else process.stdout.write(text) },
      writeErr: (text) => { if (jsonModeOn()) suppressHumanText(text); else process.stderr.write(text) },
    })
}

export async function buildProgram(): Promise<Command> {
  const ctx = new Context()
  await ctx.plugin(AdapterRegistryService)
  await ctx.plugin(SecretsService, {})
  await ctx.plugin(HostRegistryService, {})
  // The gateway that owns unlocking and the audit record (#93). One per process.
  await ctx.plugin(SecretAccessService, {})
  await ctx.plugin(CommandRegistryService)
  // Cards for humans, plain lines for pipes — the choice is made once, here (#88).
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
    // #147: see parseGuard — applied to the program and to every subcommand.
    

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
    program.addCommand(parseGuard(cmd))
  }

  return parseGuard(program)
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

/**
 * A CLI is expected to survive its reader going away. `saip status | head -1` or
 * `saip config doctor | grep -q …` closes the pipe while output is still being written, and Node
 * surfaces that as an asynchronous `error` event on the stream — which, unhandled, prints an
 * `Error: write EPIPE` stack trace and exits 1 as though the command failed.
 *
 * This belongs at the composition root, not in the renderer: `console.log` used to hide the problem
 * by swallowing write errors, so moving output to `ctx.ui`'s sink (#113) turned every piped
 * invocation into a potential crash. Found by CI, where the smoke step pipes `config doctor` into
 * `grep -qi`. Non-EPIPE errors are re-raised rather than hushed, because a real write failure
 * (disk full, closed fd) must not be reported as success.
 */
/** The condition that means "the reader went away", not "the command failed". */
export function isClosedReader(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
}

export function tolerateClosedReaders(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (isClosedReader(err)) return
      throw err
    })
  }
}

/**
 * One record for a parse-level outcome, and nothing else on stdout (#147).
 *
 * `--version`/`--help` exit 0: they succeeded at what was asked. Everything else keeps commander's own
 * non-zero exit code, so "you asked badly" (1) stays distinguishable from "refused for no records" (2).
 */
function reportParseOutcome(err: { code?: string; message?: string; exitCode?: number }, program: Command): number {
  const message = String(err?.message ?? err ?? '').replace(/^error:\s*/i, '')
  const version = /^version\b/i.test(message) || err?.code === 'commander.version'
  // `exitOverride` reports help as the literal message '(outputHelp)', so the real usage text is taken
  // from what commander tried to write (captured by parseGuard) rather than from err.message.
  const captured = takeSuppressedText()
  const help = err?.code === 'commander.helpDisplayed' || err?.code === 'commander.help'
    || /Display help for command/i.test(captured) || /^Usage: /i.test(captured)

  if (version) {
    emit({ kind: 'line', level: 'info', text: SAIP_VERSION,
      data: { code: 'version', version: SAIP_VERSION, commit: SAIP_BUILD_COMMIT, target: SAIP_BUILD_TARGET, builtAt: SAIP_BUILD_DATE } })
    return 0
  }
  if (help) {
    const wanted = process.argv.slice(2).find((a) => !a.startsWith('-'))
    const named = program.commands.find((c) => c.name() === wanted)
    const usage = captured || message
    emit(parseRecord('help', `${named ? `saip ${wanted}` : 'saip'}: ${usage.split('\n')[0]}`,
      { command: named ? wanted : undefined, usage, commands: program.commands.map((c) => c.name()) }))
    return 0
  }

  const condition = classifyCommanderError(err?.code)
  const fullText = captured || message
  const detail: Record<string, unknown> = {}
  const flag = /unknown option '(.*?)'/i.exec(message)?.[1]
  const name = /unknown command '(.*?)'/i.exec(message)?.[1]
  const argument = /required argument '(.*?)'/i.exec(message)?.[1]
  const cmd = process.argv.slice(2).find((a) => !a.startsWith('-'))
  if (flag) detail.flag = flag
  if (name) detail.name = name
  if (argument) detail.argument = argument
  if (cmd) detail.command = cmd
  if (condition === 'unknown_command') detail.commands = program.commands.map((c) => c.name())
  emit(parseRecord(condition, fullText && !/^\(.*\)$/.test(fullText) ? fullText.replace(/\n.*$/, '') : (message || `could not parse the command line (${err?.code ?? 'unknown error'})`), detail))
  // Commander reports 0 for a usage *display* and 1 for a usage *error*; keep its number when it
  // supplied one, since the documented contract is 1 = bad ask, 2 = refused, 0 = success.
  return typeof err?.exitCode === 'number' && err.exitCode > 0 ? err.exitCode : 1
}

/** Write one record straight to stdout — the machine stream, bypassing the human sink. */
function emit(block: Parameters<typeof jsonlRenderer.render>[0]): void {
  process.stdout.write(`${jsonlRenderer.render(block)}\n`)
}

export async function runCli(argv: string[] = process.argv): Promise<number> {
  tolerateClosedReaders()
  // Detected from argv BEFORE commander parses, because the paths this protects are exactly the ones
  // where no command action ever runs to turn it on (#147).
  const machine = argv.includes('--json')
  setJsonMode(machine)
  try {
    if (argv.includes('--built')) {
      // Provenance is a diagnostic even when it is a record's worth of data: it stays off the machine
      // stream (#115) — the line that used to corrupt `profiles --json`, in its original shape.
      ;(machine ? process.stderr : process.stdout).write(`${buildProvenance()}\n`)
      return 0
    }
    const program = await buildProgram()
    try {
      await program.parseAsync(argv)
    } catch (err: any) {
      // `exitOverride` removes commander's own `process.exit`, so the dispatcher owns the code now —
      // in BOTH modes. Omitting this turned every usage error into exit 0 while the text still read
      // like a failure, which is worse than the bug #147 set out to fix; the exit-code case in
      // tests/json-parse-level.test.ts is what caught it.
      const code = machine ? reportParseOutcome(err, program) : (typeof err?.exitCode === 'number' ? err.exitCode : 1)
      process.exitCode = code
      return code
    }
    return typeof process.exitCode === 'number' ? process.exitCode : 0
  } finally {
    setJsonMode(false)
    // Give the terminal back before the process is allowed to end (#172). Once a prompt has put the
    // tty stream into flowing mode, `unref()` alone drains the loop under Node but NOT under Bun — and
    // Bun compiles the artifact users run — so a command could print its whole report and leave the
    // user's shell frozen. The dispatcher owns the process lifecycle, so the release happens once
    // here instead of at every command's exit path; it is a no-op when nothing was ever prompted.
    releaseTty()
  }
}
