#!/usr/bin/env node
/**
 * The CLI executable. This file's only job is to start the program — unconditionally.
 *
 * Why it exists separately (#101): `index.ts` used to detect whether it was the entry point by
 * comparing `import.meta.url` with `realpathSync(process.argv[1])`. That worked for a source run,
 * a symlink and a relative path (#72), and fails for the thing we now want — a compiled single-file
 * binary, where `argv[1]` is a virtual path like `/$bunfs/root/saip` that is not on the real
 * filesystem. `realpathSync` throws, the guard returned false, and the binary exited 0 having
 * printed nothing: the original silent-no-op symptom of #70, reproduced by packaging rather than by
 * a broken link.
 *
 * Detecting "am I main?" is only ever needed while one file plays two roles. Splitting the roles
 * removes the class, so there is no guard here to get wrong and no `import.meta.url` to compare.
 */
import { runCli } from './index.js'
import { promptingHappened } from './ui/prompt.js'

/**
 * Drain what is buffered before the process is ended by hand.
 *
 * `process.exit()` truncates a pipe: on a terminal stdout writes synchronously, but when it is a pipe
 * the write is queued and exiting drops it — the same "empty stdout" family as #147. So the last write
 * is awaited through its callback, bounded by a deadline so a reader that already closed (`| head -1`,
 * the EPIPE case #113 absorbed) cannot hold the process forever.
 */
async function flush(stream: NodeJS.WriteStream, deadlineMs = 1_000): Promise<void> {
  if (!stream.writableLength) return
  await Promise.race([
    new Promise<void>((resolve) => stream.write('', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, deadlineMs).unref()),
  ])
}

const code = await runCli()

// #172: the dispatcher releases the terminal, but releasing is not sufficient under Bun. Measured in a
// real pty against both `bun run` and `bun build --compile` (the artifact shape): once a `/dev/tty`
// reader has delivered any data the process never exits — `destroy()` does not release it, an explicit
// `closeSync()` of the descriptor does not, `pause()` does not, and never calling `ref()` does not —
// while the identical source exits cleanly under Node. Ink and React are exonerated: importing both
// without ever opening the terminal exits fine. So the difference is the runtime's loop, not our code.
//
// The entry point therefore ends the process, and only for a run that actually prompted, so nothing
// about a piped or non-interactive command changes. Commands do not do this themselves: they are
// library code whose caller may not want its process ended, which is exactly why this file exists
// (#101) — it is the only thing in the package that is a program rather than a module.
if (promptingHappened()) {
  await flush(process.stdout)
  await flush(process.stderr)
  process.exit(code)
}
