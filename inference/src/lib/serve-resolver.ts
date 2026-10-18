/**
 * Serve-version resolution (pure). Turns a caller's adapter reference into the
 * concrete `name@version` vLLM should load for one request. Composites resolve
 * to their own compiled artifact version — never to component ids.
 */

import type { AdapterDefinition } from '@saip/shared'
import { parseRef } from '@saip/shared'

const pad = (n: number) => String(n).padStart(6, '0')

export function serveVersionFor(
  ref: string,
  adapters: AdapterDefinition[],
  latestFor: (name: string) => number | undefined,
): string {
  const { name, version } = parseRef(ref)
  // Explicit pin wins verbatim.
  if (version && version !== 'latest') return `${name}@${version.replace(/^@/, '')}`

  const def = adapters.find((a) => a.name === name)
  const isComposite = !!def?.composite || def?.trainable === false
  const v = latestFor(name)
  if (v == null) {
    throw new Error(isComposite ? `no compiled version for composite "${name}"` : `no promoted version for "${name}"`)
  }
  return `${name}@${pad(v)}`
}
