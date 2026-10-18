/**
 * Caller → adapter resolution (pure). The service wrapper reads config from
 * injected gateway state; this module holds the testable decision.
 */

import type { UserEntry } from '@saip/shared'

export interface ResolvedCaller {
  userId: string | null
  adapterRef?: string
}

/**
 * MVP behavior (file-based manifests, no enforced auth): a known caller gets
 * their own inference adapter; an unknown caller or missing credential resolves
 * to the `default` user's adapter. Only if there is no default and the caller
 * is unknown do we return a null user (caller cannot be served).
 */
export function resolveAdapterForCaller(users: UserEntry[], callerId?: string): ResolvedCaller {
  const match = callerId ? users.find((u) => u.id === callerId) : undefined
  const chosen = match ?? users.find((u) => u.id === 'default')
  if (!chosen) return { userId: null }
  return { userId: chosen.id, adapterRef: chosen.adapters.inference }
}
