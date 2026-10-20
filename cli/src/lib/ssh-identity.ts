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
  const store = buildStore({})
  let pem: string | undefined
  try {
    pem = await store.get(name)
  } catch (e) {
    throw new Error(`cannot read ${name} from the encrypted store: ${(e as Error).message}`)
  }
  if (!pem) throw new Error(`host "${host.name}" has no SSH key named ${name}. Create one: saip ssh generate --host ${host.name}`)
  return materialiseKey(pem, host.name, fn)
}
