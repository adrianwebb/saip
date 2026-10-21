/**
 * The one place a deployment command turns a host into a usable SSH identity (#89).
 *
 * Lives apart from the providers so `providerFor` stays the single construction point, and apart
 * from the store wiring so the lifetime rule is stated once: the key is materialised around the
 * callback and nothing outside can hold the path.
 */
import type { HostConfig } from '@saip/shared'
import { buildStore } from '../commands/config.js'
import { materialiseKey, sshKeyName } from './ssh-keys.js'
import type { SshIdentityScope } from './providers/hyperstack.js'

/**
 * Resolve the host's key by name, read its value through the store (which may prompt once), then
 * run `fn` with a temporary identity file. Absent key is a named error with the command to fix it,
 * never an anonymous keyless ssh.
 */
export const withManagedIdentity: SshIdentityScope = async <T>(host: HostConfig, fn: (path: string) => Promise<T>): Promise<T> => {
  const name = sshKeyName(host)
  const reason = `host "${host.name}" needs its SSH key (${name}) from the encrypted store`
  // The reason goes INTO the store, not printed beside it: the prompt is raised lazily by the
  // first read, and a line printed before that still leaves the prompt itself bare.
  const store = buildStore({ reason })
  let pem: string | undefined
  try {
    await store.ensureUnlocked()
    pem = await store.get(name)
  } catch (e) {
    const msg = (e as Error).message
    // An unlock failure is not a missing key; conflating them sends the user to `saip ssh
    // generate` when the real problem is a passphrase, and destroys trust in the retry.
    if (/cannot unlock|not readable as JSON|format/.test(msg)) {
      throw new Error(`cannot read ${name} from the encrypted store: ${msg}`)
    }
    throw new Error(`could not open the secret store for host "${host.name}": ${msg}`)
  }
  if (!pem) throw new Error(`host "${host.name}" has no SSH key named ${name}. Create one: saip ssh generate --host ${host.name}`)
  return materialiseKey(pem, host.name, fn)
}
