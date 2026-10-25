/**
 * The suite must not be able to see the developer's own `SAIP_*` environment (#138).
 *
 * Why this file exists as a TEST and not as a convention: #138's bug was a suite that passed on CI
 * because CI has no `SAIP_R2_BUCKET` exported, and failed on a laptop that does — the wizard reported
 * the shell value honestly and the assertion about the temp `.env` could never match. Encoding "the CI
 * environment is empty" is not encoding the behaviour under test, and prose about it has no failing
 * state. This does.
 *
 * It fails before `tools/vitest/env-isolation.ts` is wired into the vitest config, on exactly the
 * machine the issue described. Run `env | grep -c '^SAIP_'` to see what the developer shell carries.
 */
import { describe, it, expect } from 'vitest'

describe('ambient environment isolation (#138)', () => {
  it('no SAIP_* variable reaches a test from the developer shell', () => {
    const leaked = Object.keys(process.env).filter((k) => k.startsWith('SAIP_'))
    expect(leaked, `ambient SAIP_* visible to the suite: ${leaked.join(', ')} — the setup file did not load`).toEqual([])
  })

  it('the setup file ran, so the guard itself is not vacuously green', () => {
    // Without this, a suite with zero keys for an unrelated reason (e.g. the isolation never loaded
    // and the shell happened to be clean) would look identical to the protected case.
    expect((globalThis as Record<string, unknown>).__saipEnvIsolation, 'env-isolation.ts did not execute').toBe(true)
  })
})
