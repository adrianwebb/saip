import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAIP_VERSION } from '../src/version.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('version parity (#71 prerequisite)', () => {
  it('the embedded version equals the manifest version', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'cli/package.json'), 'utf8')).version
    // A compiled binary cannot read package.json at runtime, so the literal is what operators see.
    expect(SAIP_VERSION).toBe(manifest)
  })

  it('the build script guards the same invariant', () => {
    const script = readFileSync(join(root, 'cli/scripts/build-binaries.mjs'), 'utf8')
    expect(script).toMatch(/refusing to build/)
    expect(script).toMatch(/SAIP_VERSION/)
  })

  it('the CLI reports the embedded version, not a hardcoded duplicate', () => {
    const src = readFileSync(join(root, 'cli/src/index.ts'), 'utf8')
    expect(src).toMatch(/\.version\(SAIP_VERSION\)/)
    expect(src).not.toMatch(/\.version\('\d/)
  })
})
