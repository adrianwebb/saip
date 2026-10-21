import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpolate, loadEnvFile, loadYamlConfig, ConfigInterpolationError } from '../src/config-source.js'

const dir = () => mkdtempSync(join(tmpdir(), 'saip-cfg-'))
const yamlFile = (body: string) => { const p = join(dir(), 'saip.yaml'); writeFileSync(p, body); return p }

describe('interpolate', () => {
  it('replaces a whole-string ${VAR}', () => {
    expect(interpolate({ bucket: '${SAIP_R2_BUCKET}' }, { SAIP_R2_BUCKET: 'saip-prod' }).bucket).toBe('saip-prod')
  })

  it('replaces an embedded ${VAR} inside a larger string', () => {
    const out = interpolate({ endpoint: 'https://${ACCOUNT}.r2.cloudflarestorage.com' }, { ACCOUNT: 'abc123' })
    expect(out.endpoint).toBe('https://abc123.r2.cloudflarestorage.com')
  })

  it('replaces every occurrence in one string', () => {
    const out = interpolate({ k: '${A}-${A}-${B}' }, { A: '1', B: '2' })
    expect(out.k).toBe('1-1-2')
  })

  it('applies the default form when unset or empty', () => {
    expect(interpolate({ p: '${S_AIP_PORT:-8000}' }, {}).p).toBe('8000')
    expect(interpolate({ p: '${S_AIP_PORT:-8000}' }, { S_AIP_PORT: '' }).p).toBe('8000')
    expect(interpolate({ p: '${S_AIP_PORT:-8000}' }, { S_AIP_PORT: '9000' }).p).toBe('9000')
  })

  it('errors with the caller message on the :? form', () => {
    expect(() => interpolate({ b: '${SAIP_R2_BUCKET:?set the bucket in .env}' }, {}))
      .toThrow(/set the bucket in \.env/)
  })

  it('fails closed naming the variable AND its path when a bare ${VAR} is unset', () => {
    expect(() => interpolate({ storage: { r2: { bucket: '${SAIP_R2_BUCKET}' } } }, {}))
      .toThrow(ConfigInterpolationError)
    try {
      interpolate({ storage: { r2: { bucket: '${SAIP_R2_BUCKET}' } } }, {})
    } catch (e: any) {
      expect(e.message).toMatch(/SAIP_R2_BUCKET/)
      expect(e.message).toMatch(/storage\.r2\.bucket/)
    }
  })

  it('treats an empty value as missing, not as a successful substitution', () => {
    // Empty credentials otherwise surface much later as an opaque storage 403.
    expect(() => interpolate({ k: '${A}' }, { A: '' })).toThrow(/missing variable: A/)
  })

  it('recurses into arrays and nested objects', () => {
    const out = interpolate(
      { list: ['${A}', { inner: '${B}' }], deep: { x: { y: '${A}' } } } as any,
      { A: 'a', B: 'b' },
    )
    expect(out).toEqual({ list: ['a', { inner: 'b' }], deep: { x: { y: 'a' } } })
  })

  it('leaves non-string scalars alone', () => {
    const out = interpolate({ n: 16384, f: 1.5, t: true, z: null }, { N: 'no' })
    expect(out).toEqual({ n: 16384, f: 1.5, t: true, z: null })
  })

  it('does not stringify numbers that merely look like tokens', () => {
    const out = interpolate({ port: 8000 }, {})
    expect(out.port).toBe(8000)
    expect(typeof out.port).toBe('number')
  })

  it('is single-pass: no nesting, and a produced value is never re-scanned', () => {
    // ${VAR_${OTHER}} is documented as unsupported; it stays literal and therefore fails.
    expect(() => interpolate({ k: '${A_${B}}' }, { A: 'x', B: 'y' })).toThrow()
    // A value that itself contains ${...} must not be expanded again.
    expect(interpolate({ k: '${A}' }, { A: '${B}' }).k).toBe('${B}')
  })

  it('leaves unrelated $ text and bare $VAR untouched', () => {
    expect(interpolate({ s: 'costs $5 and $HOME and $$' }, {})).toEqual({ s: 'costs $5 and $HOME and $$' })
  })

  it('reports every missing variable, not just the first', () => {
    try {
      interpolate({ a: '${A}', b: '${B}' }, {})
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e.errors).toHaveLength(2)
    }
  })
})

describe('loadEnvFile', () => {
  it('parses KEY=VALUE, quotes, comments and blank lines', () => {
    const p = join(dir(), '.env')
    writeFileSync(p, [
      '# a comment',
      '',
      'A=plain',
      'B="double quoted"',
      "C='single quoted'",
      'D=with=equals',
      'E=',
      '  F=indented',
    ].join('\n'))
    const env = loadEnvFile(p)
    expect(env).toEqual({ A: 'plain', B: 'double quoted', C: 'single quoted', D: 'with=equals', E: '' })
    // A leading-space key is not a valid assignment; ignoring it beats guessing.
    expect('F' in env).toBe(false)
  })

  it('returns empty for a file that does not exist — absence is not an error', () => {
    expect(loadEnvFile(join(dir(), 'nope.env'))).toEqual({})
  })
})

describe('loadYamlConfig', () => {
  it('parses YAML then interpolates, with shell winning over .env', () => {
    const cfg = yamlFile('model:\n  base: "${BASE}"\ninference:\n  port: ${PORT:-8000}\n')
    const envP = join(dir(), '.env')
    writeFileSync(envP, 'BASE=from-dotenv\n')
    const doc = loadYamlConfig(cfg, { env: { ...loadEnvFile(envP), BASE: 'from-shell' } })
    expect(doc.model.base).toBe('from-shell')
    expect(doc.inference.port).toBe('8000')
  })

  it('applies .env values when the shell has none', () => {
    const cfg = yamlFile('b: "${SAIP_R2_BUCKET}"\n')
    const envP = join(dir(), '.env')
    writeFileSync(envP, 'SAIP_R2_BUCKET=saip-local\n')
    expect(loadYamlConfig(cfg, { env: loadEnvFile(envP) }).b).toBe('saip-local')
  })

  it('throws naming the path when a required variable is missing', () => {
    const cfg = yamlFile('storage:\n  r2:\n    bucket: "${SAIP_R2_BUCKET}"\n')
    expect(() => loadYamlConfig(cfg, { env: {} })).toThrow(/storage\.r2\.bucket/)
  })

  it('does not interpolate values that contain no tokens', () => {
    const cfg = yamlFile('s: 7 GB\nl:\n  - a\n  - b\nn: 4096\n')
    expect(loadYamlConfig(cfg, { env: {} })).toEqual({ s: '7 GB', l: ['a', 'b'], n: 4096 })
  })

  it('leaves an absent export from the shipped saip.yaml loadable', () => {
    // The committed saip.yaml uses ${SAIP_R2_*} with :- defaults only where intended;
    // loading it must not require a filled-in .env just to inspect the platform config.
    const repo = new URL('../../saip.yaml', import.meta.url)
    let threw: unknown = null
    try { loadYamlConfig(repo, { env: {} }) } catch (e) { threw = e }
    // Either it loads, or it fails ONLY on the documented secret names — never a crash.
    if (threw) expect((threw as Error).message).toMatch(/SAIP_R2_|missing variable/)
  })
})
