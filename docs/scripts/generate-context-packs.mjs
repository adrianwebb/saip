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

    // Write a per-format temp config so the CLI handles all default merging
    const tmpCfg = mkdtempSync(join(tmpdir(), 'saip-repomix-'))
    const cfgPath = join(tmpCfg, 'repomix.config.json')
    writeFileSync(cfgPath, JSON.stringify({
      ...baseConfig,
      output: { ...baseConfig.output, style, filePath, headerText },
      security: { enableSecurityCheck: false },
    }, null, 2))

    execFileSync(
      repomixBin(),
      ['--config', cfgPath],
      { cwd: docsDir, stdio: ['ignore', 'pipe', 'pipe'] }
    )

    // Extract token count from repomix stdout for logging
    console.log(`[pack-context]   ${style} → ${filePath}`)
  }

  console.log('[pack-context] Done.')
}

main().catch((err) => {
  console.error('[pack-context] FAILED:', err)
  process.exit(1)
})
