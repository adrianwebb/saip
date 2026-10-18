/**
 * Pluggable authentication seam. API/MCP surfaces authenticate via bearer tokens;
 * UI surfaces via a password/session guard. Every HTTP route must pass through an
 * AuthProvider — the default is fail-closed (no token map + not dev_mode = reject).
 *
 * Token VALUES are never stored in committed config: each ApiToken maps a caller
 * to a SECRET NAME resolved at runtime via a SecretsReader (SecretsService).
 */

export interface Principal {
  callerId: string
  scopes?: string[]
}

export interface ApiRequestLike {
  headers: Record<string, string | undefined>
}

export interface UIRequestLike {
  password?: string
  session?: string
}

export interface AuthProvider {
  /** Returns the authenticated principal, or null when unauthenticated. */
  verifyApi(req: ApiRequestLike): Promise<Principal | null>
  /** Optional UI guard for password/session-protected interfaces. */
  verifyUi?(req: UIRequestLike): Promise<boolean>
}

/** Minimal reader so auth doesn't hard-depend on the Cordis service wrapper. */
export interface SecretsReader {
  require(name: string): Promise<string>
}

export interface ApiTokenConfig {
  caller: string
  /** Name of the secret holding this caller's bearer token value. */
  token_secret: string
}

const bearerOf = (headers: Record<string, string | undefined>): string | undefined => {
  const h = headers.authorization ?? headers.Authorization
  if (!h) return undefined
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : undefined
}

/** Bearer-token auth backed by a caller→secret-name table resolved via secrets. */
export class BearerTokenAuth implements AuthProvider {
  constructor(private readonly tokens: ApiTokenConfig[], private readonly secrets: SecretsReader) {}

  async verifyApi(req: ApiRequestLike): Promise<Principal | null> {
    const presented = bearerOf(req.headers)
    if (!presented) return null
    for (const t of this.tokens) {
      let expected: string
      try {
        expected = await this.secrets.require(t.token_secret)
      } catch {
        continue // secret unresolved → this entry cannot authenticate
      }
      if (expected && timingSafeEqual(expected, presented)) return { callerId: t.caller }
    }
    return null
  }
}

/** Single-admin-password UI guard (MVP); swap for real session store later. */
export class PasswordSessionAuth implements AuthProvider {
  constructor(private readonly secrets: SecretsReader, private readonly adminSecretName: string) {}
  async verifyApi(): Promise<Principal | null> {
    return null // UI guard only authenticates browsers, not API callers
  }
  async verifyUi(req: UIRequestLike): Promise<boolean> {
    if (!req.password) return false
    try {
      return timingSafeEqual(await this.secrets.require(this.adminSecretName), req.password)
    } catch {
      return false
    }
  }
}

/** Explicit development mode: everything authenticates as `dev`. Never default. */
export class AllowAllDevAuth implements AuthProvider {
  async verifyApi(): Promise<Principal | null> {
    return { callerId: 'dev' }
  }
  async verifyUi(): Promise<boolean> {
    return true
  }
}

/** Constant-time-ish string compare (length-guarded) to avoid trivial timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
