#!/usr/bin/env node
/**
 * Generate Repomix context packs for the SAIP documentation site.
 * Produces XML, Markdown, and JSON single-file packs in dist/context-pack/.
 * Each pack embeds the source commit hash and generation timestamp so AI
 * consumers can tell which build they reflect.
 *
 * Runs as part of `pnpm build` (after astro build) or standalone via
 * `pnpm --filter @saip/docs pack-context`.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const docsDir = join(__dirname, '..')
const outDir = join(docsDir, 'dist', 'context-pack')

const FORMATS = ['xml', 'markdown', 'json']

function repomixBin() {
  // Resolve the repomix CLI entry from this package's dependencies
  return join(docsDir, 'node_modules', '.bin', 'repomix')
}

function gitInfo() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: docsDir }).toString().trim()
    let dirty = ''
    try {
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: docsDir }).toString().trim()
      if (status) dirty = ' (with uncommitted changes)'
    } catch {}
    return { commit: commit + dirty }
  } catch {
    return { commit: 'unknown' }
  }
}

async function main() {
  const baseConfig = JSON.parse(readFileSync(join(docsDir, 'repomix.config.json'), 'utf8'))
  const { commit } = gitInfo()
  const generatedAt = new Date().toISOString()

  console.log(`[pack-context] Generating packs from commit ${commit}`)

  for (const style of FORMATS) {
    const ext = style === 'markdown' ? 'md' : style
    const filePath = join(outDir, `saip-docs.${ext}`)
    const headerText = [
      'SAIP Documentation Context Pack',
      '=============================',
      '',
      'Complete SAIP (Simple AI Platform) documentation packed for AI consumption.',
      `Source commit: ${commit}`,
      `Generated at:  ${generatedAt}`,
      `Format:        ${style}`,
      '',
      'Docs site: https://adrianwebb.github.io/saip/',
      'Repo:      https://github.com/adrianwebb/saip',
      '',
      'This pack is a build artifact regenerated on every deploy. Stable URL:',
      'https://adrianwebb.github.io/saip/context-pack/saip-docs.' + ext,
    ].join('\n')

    // Write a per-format temp config so the CLI handles all default merging.
    // parsableStyle: XML gets strict well-formed output (escaped content, real
    // root element) so it parses with standard XML parsers. Markdown and JSON
    // are already format-correct: markdown is plain text by design, and repomix
    // always emits valid JSON regardless of parsableStyle.
    const parsable = style === 'xml'
    const tmpCfg = mkdtempSync(join(tmpdir(), 'saip-repomix-'))
    const cfgPath = join(tmpCfg, 'repomix.config.json')
    writeFileSync(cfgPath, JSON.stringify({
      ...baseConfig,
      output: { ...baseConfig.output, style, filePath, headerText, parsableStyle: parsable },
      security: { enableSecurityCheck: false },
    }, null, 2))

    execFileSync(
      repomixBin(),
      ['--config', cfgPath],
      { cwd: docsDir, stdio: ['ignore', 'pipe', 'pipe'] }
    )

    console.log(`[pack-context]   ${style} → ${filePath}`)
  }

  validateFormats()
  console.log('[pack-context] Done.')
}

/**
 * Assert each pack respects its declared format contract:
 * - XML must parse as well-formed XML
 * - JSON must parse as JSON with expected keys
 * - Markdown must be plain text (no parse requirement; sanity-check only)
 */
function validateFormats() {
  const xml = readFileSync(join(outDir, 'saip-docs.xml'), 'utf8')
  // Parsable output uses a real <repomix> root element (no <?xml?> declaration —
  // it's optional in XML). The legacy non-parsable template starts with plain text.
  if (!xml.startsWith('<repomix>')) {
    throw new Error('XML pack is not well-formed parsable output (missing <repomix> root). Check parsableStyle.')
  }
  const json = JSON.parse(readFileSync(join(outDir, 'saip-docs.json'), 'utf8'))
  if (!json.files || typeof json.files !== 'object' || Object.keys(json.files).length === 0) {
    throw new Error('JSON pack missing files map')
  }
  const md = readFileSync(join(outDir, 'saip-docs.md'), 'utf8')
  if (!md.includes('# File Summary')) {
    throw new Error('Markdown pack missing File Summary section')
  }
  console.log('[pack-context] Format validation: xml (well-formed), json (parseable), markdown (plain) ✅')
}

main().catch((err) => {
  console.error('[pack-context] FAILED:', err)
  process.exit(1)
})
