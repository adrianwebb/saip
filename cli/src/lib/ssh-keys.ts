/**
 * SAIP-managed SSH keypairs (#89), and the fix for #83.
 *
 * The previous design asked users to export a private key path in an environment variable, then had
 * the provider interpolate the secret's NAME into `/run/secrets/<name>` — a path nothing created, so
 * remote SSH could never authenticate. This resolves the secret's **value** and hands `ssh` a real
 * file for exactly as long as one command runs.
 *
 * ## Why the temporary file is the dangerous part
 * OpenSSH only accepts an identity from a file, so private key material must touch disk during a
 * call. Everything here is arranged around that constraint:
 *   - at rest the private key lives only in the encrypted store;
 *   - the public key is a plain file, because it is not secret;
 *   - the materialised file is `0600` inside a `0700` directory, created with exclusive open so a
 *     pre-existing path cannot be followed;
 *   - it is removed on **every** exit path: normal return, thrown error, `Ctrl+C`, and process
 *     teardown via the live-file registry.
 * A leaked private key is a worse outcome than the bug being fixed, so cleanup is not a `finally`
 * in one function — it is a registry that survives callers that forget.
 *
 * Keys are Ed25519 from `node:crypto`: no `ssh-keygen` dependency, which matters for the #71
 * single-file binaries and for Windows. Whether OpenSSH accepts a PKCS#8 PEM here was measured
 * against `ssh-keygen -y` on this host, not assumed.
 */
import { generateKeyPairSync, createPublicKey, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { HostConfig } from '@saip/shared'

/** Directory holding public halves and, transiently, materialised private halves. */
export function sshKeyDir(env: NodeJS.ProcessEnv = process.env): string {
  // Keys live beside the store they unlock. The first version tested the env var's *extension*
  // and fell back to the home directory otherwise, so `SAIP_SECRETS_FILE=/tmp/x/s.json` still
  // wrote public keys into ~/.saip — which is how a unit test ends up touching a real home dir.
  const raw = env.SAIP_SECRETS_FILE || join(homedir(), '.saip', 'secrets.enc.json')
  const base = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
  return join(dirname(isAbsolute(base) ? base : join(process.cwd(), base)), 'keys')
}

export function managedKeyName(host: string): string {
  // Upper + underscore: env-var-safe. Case collapse is intentional — DNS hostnames are
  // case-insensitive, so 'lab' and 'LAB' are one host and must not get two keys.
  return `SAIP_SSH_KEY_${host.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`
}

/** Which secret name holds this host's identity: explicit wins, else the managed name. */
export function sshKeyName(host: HostConfig): string {
  return host.ssh?.key_secret?.trim() || managedKeyName(host.name)
}

export function publicPath(host: string, dir = sshKeyDir()): string {
  return join(dir, `${host}.ed25519.pub`)
}

export interface Keypair { privatePem: string; publicOpenSsh: string; comment: string }

/** OpenSSH wire format: string(算法名) + string(公钥裸字节). Public only — no secret material. */
function encodePublic(raw: Buffer, algo = 'ssh-ed25519'): string {
  const a = Buffer.alloc(4 + algo.length); a.writeUInt32BE(algo.length, 0); a.write(algo, 4)
  const p = Buffer.alloc(4 + raw.length); p.writeUInt32BE(raw.length, 0); raw.copy(p, 4)
  return `${algo} ${Buffer.concat([a, p]).toString('base64')}`
}

export function generateKeypair(host: string): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  // SPKI DER ends with the 32 raw bytes; take them from the exported buffer rather than assuming.
  const der = createPublicKey(publicKey).export({ type: 'spki', format: 'der' })
  const comment = `saip-${host}`
  return { privatePem: privateKey, publicOpenSsh: `${encodePublic(der.subarray(der.length - 32))} ${comment}`, comment }
}

/** Import an existing PEM (for `saip ssh migrate`) and derive its public half. */
export function importPrivateKey(pem: string, host: string): Keypair {
  const pub = createPublicKey(pem).export({ type: 'spki', format: 'der' })
  const comment = `saip-${host}`
  return { privatePem: pem, publicOpenSsh: `${encodePublic(pub.subarray(pub.length - 32))} ${comment}`, comment }
}

export async function writePublicKeypair(kp: Keypair, host: string, dir = sshKeyDir()): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = publicPath(host, dir)
  writeFileSync(p, `${kp.publicOpenSsh}\n`, { mode: 0o644 })
  return p
}

const live = new Set<string>()

/** Paths with key material currently on disk. Diagnostic and test hook; never logs contents. */
export function liveMaterialisedKeys(): string[] { return [...live] }

/**
 * Remove every materialised private key. Registered on `exit` and on the fatal signals so a caller
 * that never returns — `Ctrl+C`, a killed process — still cannot leave key material behind.
 * Idempotent, and never throws: teardown that fails loudly can prevent other cleanup.
 */
export function cleanupMaterialisedKeys(): void {
  for (const p of [...live]) {
    try { rmSync(dirname(p), { recursive: true, force: true }) } catch { /* best effort at teardown */ }
    live.delete(p)
  }
}

let handlersInstalled = false
function installTeardown(): void {
  if (handlersInstalled) return
  handlersInstalled = true
  process.on('exit', cleanupMaterialisedKeys)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { cleanupMaterialisedKeys(); process.exit(sig === 'SIGINT' ? 130 : 143) })
  }
}

/**
 * Run `fn` with the private key available as a file path, and guarantee the file's removal.
 * The directory is 0700 and the file 0600, written with exclusive create so a pre-existing path
 * cannot be followed or overwritten. Removal happens in `finally` AND via the registry, so a
 * callback that throws, cancels, or kills the process is covered identically.
 */
/**
 * `dir` defaults to the host's key directory, but callers that know where the STORE lives must pass
 * it: this function creates a real directory, and leaving it out meant `saip ssh verify` wrote a
 * temporary key directory into `~/.saip/keys` even when the configured store was elsewhere (#113).
 */
export async function materialiseKey<T>(
  privatePem: string,
  host: string,
  fn: (path: string) => Promise<T>,
  dir = sshKeyDir(),
): Promise<T> {
  installTeardown()
  const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  chmodSync(tmp, 0o700)   // mkdir's mode is umask-filtered; be explicit about a key directory
  const path = join(tmp, 'id_ed25519')
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, privatePem, { mode: 0o600 })
    chmodSync(path, 0o600)
  } finally {
    closeSync(fd)
  }
  live.add(path)
  try {
    return await fn(path)
  } finally {
    // `tmp`, never `dir`: the parent is the caller's real key directory. Renaming this variable
    // without renaming the cleanup would have deleted it recursively.
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* already gone */ }
    live.delete(path)
  }
}
