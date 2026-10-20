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

await runCli()
