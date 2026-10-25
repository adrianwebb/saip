/**
 * Shared vitest setup: the developer's `SAIP_*` environment must not reach any test (#138).
 *
 * The bug this prevents was found during the 0.6.2 release: `cli/tests/config-init.test.ts` asserted
 * that the wizard reports a value from a temp `.env`, and passed on CI while failing on the
 * maintainer's laptop — whose shell exports `SAIP_R2_BUCKET` and `SAIP_R2_ENDPOINT`, which legitimately
 * WIN over the file. Nothing in the diff explained it, because the suite was not testing the behaviour;
 * it was testing the emptiness of the CI environment.
 *
 * Clearing here (once, for every package) is the difference between per-file discipline that a new test
 * file can forget and a default that holds. A test that wants a shell value passes one explicitly
 * through the injectable `env` — that path is unaffected, because it never reads `process.env`.
 *
 * The `__saipEnvIsolation` flag exists so `tests/env-isolation.test.ts` can tell "the guard ran and the
 * shell was clean" apart from "the setup file never loaded". An assertion that cannot distinguish those
 * two is not a guard.
 */
const SAIP_PREFIX = 'SAIP_'
const removed: string[] = []
for (const key of Object.keys(process.env)) {
  if (key.startsWith(SAIP_PREFIX)) {
    delete process.env[key]
    removed.push(key)
  }
}

;(globalThis as Record<string, unknown>).__saipEnvIsolation = true

// Tell the developer once per worker, not once per file: vitest runs this setup file for every test
// module, and an unconditional line here printed 12 times in `shared` alone — noise that teaches people
// to ignore the output that exists to explain a confusing failure.
// The sentinel has to live in `process.env`, not `globalThis`: vitest gives each test FILE its own
// module registry and globals, so a flag on `globalThis` resets per file and this line printed 12
// times in `shared` and 36 in `cli`. The environment is shared by the worker, and mutating it is
// already what this file does.
// NOT SAIP_-prefixed, and that is the whole point: the first version used `SAIP_ENV_ISOLATION_NOTICE`,
// which the loop below then deleted, so every file printed again and the guard test legitimately failed
// on a variable this file had itself introduced.
const NOTICE = 'TEST_ENV_ISOLATION_DONE'
if (removed.length && !process.env[NOTICE]) {
  process.env[NOTICE] = removed.join(',')
  process.stdout.write(`[env-isolation] cleared ${removed.length} ambient SAIP_* variable(s) in this worker: ${removed.join(', ')}\n`)
}

export {}
