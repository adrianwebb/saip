/**
 * `saip ssh` — SAIP-generated, SAIP-stored SSH keypairs (#89).
 *
 * The alternative this replaces: a user downloads a private key, exports its path in an env var, and
 * the provider interpolates the secret's NAME into a `/run/secrets/...` path nothing creates (#83).
 * Owning the whole lifecycle removes the user step and the bug class together.
 *
 * Commands are the thin edge; the safety lives in `lib/ssh-keys.ts` (generation, `0600`
 * materialisation, removal on every exit path). Nothing here writes private key material anywhere
 * except through that helper, and nothing here prints it: `show` emits the PUBLIC key only.
 */
import type { Context } from 'cordis'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { sshConnectionArgs, type HostConfig, type SecretStore } from '@saip/shared'
import type { CommandSpec } from '../lib/command-registry.js'
import { lineBlock, listBlock, type Block } from '../ui/blocks.js'
import { plainRenderer } from '../ui/plain.js'
import { uiOr } from '../ui/output.js'
import { buildStore } from './config.js'
import {
  generateKeypair, importPrivateKey, managedKeyName, publicPath, writePublicKeypair,
  materialiseKey, storeKeyDir, sshKeyName, type Keypair,
} from '../lib/ssh-keys.js'

export interface SshRunner { run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } }
const defaultRunner: SshRunner = {
  run: (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 })
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') }
  },
}

export interface SshDeps { store?: SecretStore; runner?: SshRunner; hosts?: () => HostConfig[] }

/** Key directory for this store, so relocated stores keep their keys together. */
// Every key path in this command is derived from the store it is unlocking (#159) — never from the
// environment, which can disagree with an injected storePath.

/**
 * Results are **blocks**, not pre-formatted lines (#113): the command decides what a result *says*,
 * `ctx.ui` decides how it looks, and `--json` gets records for free. `lines` remains as a derived
 * view rendered by the plain renderer, so the assertions that pin this command's wording keep
 * checking real content rather than being rewritten to match a new source of truth.
 *
 * Error text stays `[saip] error: …` rather than the `warn`/`error` levels on purpose: changing the
 * marker is a user-visible change and belongs with the display review, not inside a refactor.
 */
export interface SshResult { readonly code: number; readonly blocks: Block[]; readonly lines: string[] }

const res = (code: number, ...blocks: Block[]) => ({
  code,
  blocks,
  get lines(): string[] { return blocks.map((b) => plainRenderer.render(b)) },
})
const fail = (msg: string) => res(1, lineBlock(`error: ${msg}`))
const ok = (...lines: string[]) => res(0, ...lines.map((l) => lineBlock(l.replace(/^\[saip\]\s*/, ''))))

function findHost(hosts: HostConfig[], name: string): HostConfig | undefined {
  return hosts.find((h) => h.name === name)
}

/**
 * The command body, separate from Cordis wiring so tests need no registry, no network, and no
 * `--host` pointing at a real machine.
 */
export async function runSsh(
  action: string | undefined,
  options: Record<string, unknown>,
  deps: SshDeps = {},
): Promise<SshResult> {
  const runner = deps.runner ?? defaultRunner
  const hostName = typeof options.host === 'string' ? options.host : undefined
  const hosts = deps.hosts?.() ?? []
  // Built after the host is known, so the passphrase prompt can say which host's key it is
  // unlocking. A bare "passphrase:" for a command the user typed as `saip ssh generate` is the
  // same complaint they already filed twice.
  const store = deps.store ?? buildStore({
    reason: hostName
      // No hint text here: buildStore appends it, and repeating it per call site is how one
      // drifts out of date while the other stays polite.
      ? `unlocking the store that holds the SSH key for host "${hostName}"`
      : 'unlocking the encrypted secret store',
  })

  /** Managed key name for a host: explicit `key_secret` wins, else the per-host managed name. */
  const nameFor = (host?: HostConfig) => (host ? sshKeyName(host) : managedKeyName(hostName!))

  if (!hostName && action !== 'migrate' && action !== 'list') return fail('--host <name> is required for `saip ssh` commands')
  const host = hostName ? findHost(hosts, hostName) : undefined
  if (hostName && hosts.length && !host) {
    return fail(`no host "${hostName}" in hosts.yaml. Known: ${hosts.map((h) => h.name).join(', ') || 'none'}`)
  }
  // Lazy: `list` runs with no --host, and resolving a name from undefined threw. A getter keeps
  // every branch honest without forcing the guard into each case.
  const keyName = () => nameFor(host)

  switch (action) {
    case 'list': {
      const names = (await store.names()).filter((n) => n.startsWith('SAIP_SSH_KEY_'))
      if (!names.length) return ok('no managed SSH keys. Create one: saip ssh generate --host <name>')
      return res(0,
        lineBlock('managed keys:'),
        listBlock(names.map((n) => `${n}  (public: ${join(storeKeyDir(store), n.replace(/^SAIP_SSH_KEY_/, '').toLowerCase() + '.ed25519.pub')})`)),
      )
    }

    case 'generate': {
      if (await store.get(keyName())) {
        return fail(`${keyName()} already exists. Use \`saip ssh rotate --host ${hostName}\` to replace it — rotating is deliberate so a running deployment is not silently locked out.`)
      }
      const kp = generateKeypair(hostName!)
      await store.set(keyName(), kp.privatePem)
      const pub = await writePublicKeypair(kp, hostName!, storeKeyDir(store))
      return ok(
        `generated Ed25519 keypair for "${hostName}"`,
        `  private: encrypted store as ${keyName()}`,
        `  public:  ${pub}`,
        '',
        `public key (${kp.publicOpenSsh}) — authorise this on the host, then verify:`,
        '',
        'Add the public key where the host authorises access (console keypair, or authorized_keys), then:',
        `  saip ssh verify --host ${hostName}`,
      )
    }

    case 'show': {
      const pubPath = publicPath(hostName!, storeKeyDir(store))
      if (existsSync(pubPath)) return ok(readFileSync(pubPath, 'utf8').trimEnd())
      const pem = await store.get(keyName())
      if (!pem) return fail(`no managed key for "${hostName}". Create one: saip ssh generate --host ${hostName}`)
      return ok(importPrivateKey(pem, hostName!).publicOpenSsh)
    }

    case 'verify': {
      const pem = await store.get(keyName())
      if (!pem) return fail(`no managed key for "${hostName}". Create one: saip ssh generate --host ${hostName}`)
      const user = host?.ssh?.user ?? 'ubuntu'
      const addr = host?.ssh?.host
      if (!addr) return fail(`host "${hostName}" has no ssh.host in hosts.yaml`)
      // Materialised inside the helper: removal is guaranteed even if ssh hangs, throws, or the user
      // interrupts — the reason this command exists rather than asking for a key path.
      return materialiseKey(pem, hostName!, async (path) => {
        // Same builder as the provider paths (#98), with verify's own timeout. The port is the reason:
        // `saip ssh verify` against a host declaring `port: 2222` used to report a refusal on 22.
        const r = runner.run('ssh', [...sshConnectionArgs(host!, path, ['-o', 'ConnectTimeout=10']), `${user}@${addr}`, 'true'])
        if (r.code === 0) return ok(`"${hostName}" authenticates with the managed key (${user}@${addr})`)
        const why = (r.stderr || r.stdout).trim().split('\n')[0]
        return fail(`ssh to ${user}@${addr} failed (exit ${r.code}): ${why}. `
          + `If the host is new, authorise the public key there first: saip ssh show --host ${hostName}`)
      }, storeKeyDir(store))
    }

    case 'rotate': {
      const old = await store.get(keyName())
      if (!old) return fail(`no managed key for "${hostName}". Create one: saip ssh generate --host ${hostName}`)
      const kp = generateKeypair(hostName!)
      await store.set(keyName(), kp.privatePem)
      const pub = await writePublicKeypair(kp, hostName!, storeKeyDir(store))
      return ok(
        `rotated the keypair for "${hostName}"`,
        `  public: ${pub}`,
        'The OLD public key is still authorised wherever you installed it — SAIP cannot revoke a key',
        'it does not control. Remove it from the provider console or authorized_keys once the new one works:',
        `  saip ssh verify --host ${hostName}`,
      )
    }

    case 'remove': {
      const had = await store.unset(keyName())
      let removedFile = false
      const pubPath = publicPath(hostName!, storeKeyDir(store))
      if (existsSync(pubPath)) { try { unlinkSync(pubPath); removedFile = true } catch { /* gone already */ } }
      if (!had && !removedFile) return fail(`no managed key for "${hostName}"`)
      return ok(`removed the managed key for "${hostName}"${host?.ssh?.host ? `; the host may still trust the old public key` : ''}`)
    }

    case 'migrate': {
      const legacy = await store.get('SAIP_SSH_PRIVATE_KEY')
      if (!legacy) return ok('nothing to migrate: SAIP_SSH_PRIVATE_KEY is not in the store')
      if (!hostName) return fail('migrate needs --host <name> to know which managed key to create')
      if (await store.get(keyName())) return fail(`${keyName()} already exists; not overwriting`)
      // The legacy value is documented both ways across releases (a path, or the key itself).
      // Detect instead of guessing, and say which was found.
      const looksLikePath = /^\//.test(legacy.trim()) && existsSync(legacy.trim())
      const pem = looksLikePath ? readFileSync(legacy.trim(), 'utf8') : legacy
      if (!pem.includes('PRIVATE KEY')) {
        return fail(looksLikePath
          ? `${legacy.trim()} does not contain a private key`
          : 'the stored SAIP_SSH_PRIVATE_KEY value is not a private key PEM — likely a path from the older docs. Re-export it as the key contents, or run: saip ssh generate --host ' + hostName)
      }
      const kp = importPrivateKey(pem, hostName)
      await store.set(keyName(), kp.privatePem)
      await writePublicKeypair(kp, hostName!, storeKeyDir(store))
      await store.unset('SAIP_SSH_PRIVATE_KEY')
      return ok(
        `migrated ${looksLikePath ? 'a key file' : 'the stored key'} into ${keyName}`,
        'SAIP_SSH_PRIVATE_KEY is retired (#89); remove it from hosts.yaml key_secret or leave the field',
        'out entirely and the managed key is used automatically.',
      )
    }

    default:
      return fail(`unknown ssh subcommand "${action}" (expected list|generate|show|verify|rotate|remove|migrate)`)
  }
}

const spec: CommandSpec = {
  name: 'ssh',
  description: 'Generate and manage SSH keypairs per host (SAIP stores private halves; you never handle a key file)',
  positional: '<action>',
  positionalDescription: 'list|generate|show|verify|rotate|remove|migrate',
  options: [
    { flag: '--host <name>', description: 'Host from hosts.yaml the key belongs to' },
  ],
  action: async () => { /* replaced at registration */ },
}

export interface SshPluginOptions extends SshDeps {}

export default {
  inject: ['commandRegistry'] as const,
  apply(ctx: Context, config: SshPluginOptions = {}) {
    ctx.commandRegistry!.register({
      ...spec,
      action: async (_ctx: Context, options, positional) => {
        // The store is deliberately NOT constructed here: runSsh builds it once the host is known
        // so the passphrase prompt can name that host. Pre-building it (as an earlier revision of
        // this file did) made the plugin hand down a reason-less store and the explanation vanished
        // for every real invocation — green tests, unhelpful prompt, the same split again.
        const hosts = config.hosts ?? ((): HostConfig[] => {
          try { return (_ctx as any).hosts?.list?.() ?? [] } catch { return [] }
        })
        const result = await runSsh(positional?.[0], options ?? {}, {
          store: config.store, runner: config.runner, hosts,
        })
        // Rendered through the seam: the same blocks become an Ink frame on a terminal,
        // plain text in a pipe, and JSONL records under --json.
        uiOr(_ctx).showAll(result.blocks)
        process.exitCode = result.code
      },
    })
  },
}
