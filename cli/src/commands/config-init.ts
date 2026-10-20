/**
 * `saip config init` — the first-time credential wizard (#78).
 *
 * Why this exists as a command rather than a longer docs page: a new user does not know which
 * variable names are required, what each one buys, or where to get a correctly scoped key. Telling
 * them to `saip config set SAIP_R2_ACCESS_KEY_ID` assumes the knowledge the step is supposed to
 * provide — that line is the RESET path, not the onboarding path.
 *
 * The question list is DERIVED from the user's own `saip.yaml` / `hosts.yaml`, so a configuration
 * that declares no API tokens is never asked about token secrets, and Hyperstack appears only when
 * a hyperstack host exists. A hardcoded checklist is exactly how docs and reality drift apart.
 *
 * Routing rule that is easy to get wrong and is therefore asserted in tests: `${VAR}`
 * interpolation reads the shell and `.env`, NEVER the encrypted store. So bucket/endpoint go to
 * `.env`; values the runtime resolves by secret name go to the store. Writing an interpolated value
 * into the store would report success and change nothing.
 */
import { existsSync, readFileSync } from 'node:fs'

/** Raised when the user presses Ctrl+C. Distinct from "empty input" on purpose. */
export class WizardCancelled extends Error { readonly name = 'WizardCancelled' }

/**
 * Incremental line reader for a raw-mode terminal, kept pure so paste and Ctrl+C are testable
 * without a TTY.
 *
 * Three behaviours that a naive chunk.toString() loop gets wrong:
 *  - **Bracketed paste.** Terminals wrap a paste in `ESC [ 200 ~ … ESC [ 201 ~`. Filtering only
 *    control bytes keeps the digits and letters INSIDE the sequence, silently corrupting a pasted
 *    key (`200AKIA…201`). So CSI/OSC sequences are skipped as sequences, not as characters.
 *  - **Ctrl+C is not a signal here.** `setRawMode(true)` disables ISIG, so 0x03 arrives as a byte.
 *    Handling it explicitly is the only way the documented "Ctrl+C stops the wizard" is true.
 *  - **Ctrl+D is EOF, not a literal.** Accept what was typed, which is what a paste ending in
 *    Ctrl+D needs.
 */
export function newLineAccumulator(): {
  feed(chunk: string): { value: string; done: boolean; cancelled: boolean }
} {
  let value = ''
  // none -> esc (saw ESC, awaiting the introducer) -> csi (consuming parameters until the final byte)
  let esc: 'none' | 'esc' | 'csi' = 'none'
  return {
    feed(chunk: string) {
      for (const ch of chunk) {
        const code = ch.codePointAt(0) ?? 0
        // ECMA-48: ESC [ is a TWO-byte introducer, then parameter bytes 0x30-0x3F and
        // intermediates 0x20-0x2F, then a single final byte 0x40-0x7E ends the sequence. Treating
        // '[' as the final byte is what made an earlier version of this reducer leak "200~" from a
        // bracketed-paste marker straight into the pasted credential.
        if (esc === 'esc') { esc = ch === '[' || ch === ']' ? 'csi' : 'none'; continue }
        if (esc === 'csi') {
          if (code >= 0x20 && code <= 0x3f) continue
          esc = 'none'
          if (code >= 0x40 && code <= 0x7e) continue
          // Outside both ranges: the sequence ended on an odd byte, so fall through and keep this
          // character rather than swallowing input the user actually typed.
        }
        if (code === 0x1b) { esc = 'esc'; continue }
        if (ch === '\n' || ch === '\r') return { value, done: true, cancelled: false }
        if (code === 0x04) return { value, done: true, cancelled: false }
        if (code === 0x03) return { value: '', done: true, cancelled: true }
        if (code === 0x7f || code === 0x08) { value = value.slice(0, -1); continue }
        // Reject other control bytes (bell, vertical tab, NUL from a stray paste) rather than
        // storing an invisible character that will silently fail authentication later.
        if (code < 0x20) continue
        value += ch
      }
      return { value, done: false, cancelled: false }
    },
  }
}
import { envFilePath, setEnvFileValues, type SecretStore } from '@saip/shared'

export interface InitItem {
  readonly name: string
  /** `config` → written to `.env` (interpolated into saip.yaml). `secret` → written to the store. */
  readonly kind: 'config' | 'secret'
  /** Blank aborts the wizard for this item; otherwise Enter skips it with a note. */
  readonly required: boolean
  readonly purpose: string
  readonly how: string
  readonly scope?: string
  readonly providerUrl?: string
  readonly docsUrl?: string
}

export interface Io {
  say(line: string): void
  /** `secret: true` means the implementation must suppress echo. */
  ask(question: string, opts: { secret: boolean }): Promise<string>
}

const SITE = 'https://adrianwebb.github.io/saip'
const R2_DOCS = 'https://developers.cloudflare.com/r2/api/tokens/'
const CF_ACCOUNT = 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/'
const HF_DOCS = 'https://huggingface.co/docs/hub/en/security-tokens'
const HS_DOCS = 'https://docs.hyperstack.cloud/docs/api-reference/authentication/'

/**
 * The questions implied by a configuration. Pure and exported separately so the derivation is
 * testable without a terminal, a store, or a filesystem.
 */
export function planInitItems(input: { config: any; hosts: any[] }): InitItem[] {
  const { config, hosts } = input
  const items: InitItem[] = [
    {
      name: 'SAIP_R2_BUCKET',
      kind: 'config',
      required: true,
      purpose: 'Object storage for adapters, knowledge, sessions and feedback. Everything the platform persists lives here.',
      how: 'Cloudflare dashboard → R2 Object Storage → Overview → Create bucket. The name is the bucket title, not a URL.',
      scope: 'One private bucket per deployment is enough. Do not make it public: adapter weights and user data go in it.',
      providerUrl: 'https://dash.cloudflare.com/?to=/:account/r2/overview',
      docsUrl: `${SITE}/guides/manage-secrets/`,
    },
    {
      name: 'SAIP_R2_ENDPOINT',
      kind: 'config',
      required: true,
      purpose: 'The S3-compatible endpoint SAIP talks to. R2 is not addressed by the AWS endpoint.',
      how: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com — find the account ID in the dashboard header. ${CF_ACCOUNT}`,
      scope: 'Buckets created in a jurisdiction need that jurisdiction’s endpoint (…​.eu. / …​.us. / …​.fedramp.), and a client cannot mix them.',
      providerUrl: R2_DOCS,
      docsUrl: `${SITE}/guides/manage-secrets/`,
    },
    {
      name: 'SAIP_R2_ACCESS_KEY_ID',
      kind: 'secret',
      required: true,
      purpose: 'The Access Key ID half of the credential SAIP signs storage requests with.',
      how: 'R2 → Overview → Account Details → API Tokens → Manage → Create Account (or User) API token, then copy the Access Key ID shown once.',
      scope: 'Permission "Object Read & Write", scoped to the bucket above. Not Admin Read & Write, and not an account-wide token: SAIP only reads and writes objects.',
      providerUrl: R2_DOCS,
      docsUrl: `${SITE}/guides/manage-secrets/`,
    },
    {
      name: 'SAIP_R2_SECRET_ACCESS_KEY',
      kind: 'secret',
      required: true,
      purpose: 'The signing secret half. Together with the ID above it grants write access to all your platform data.',
      how: 'Shown exactly once at token creation. If it was not copied, create a new token — there is no way to recover it.',
      scope: 'Treat rotation as cheap: revoke the token in the dashboard and run this wizard again.',
      providerUrl: R2_DOCS,
      docsUrl: `${SITE}/guides/manage-secrets/`,
    },
  ]

  const hfEnv: string | undefined = config?.storage?.r2?.token_env
  if (hfEnv) {
    items.push({
      name: hfEnv,
      kind: 'secret',
      required: false,
      purpose: 'Hugging Face token, used when pulling base weights or gated checkpoints.',
      how: 'huggingface.co → Settings → Access Tokens → New token. Read only for public models.',
      scope: 'Skip this if you only use public checkpoints. "read" is enough; fine-grained and scoped to the repos you actually pull.',
      providerUrl: 'https://huggingface.co/settings/tokens',
      docsUrl: `${HF_DOCS}`,
    })
  }

  for (const t of config?.security?.api_tokens ?? []) {
    if (!t?.token_secret) continue
    items.push({
      name: t.token_secret,
      kind: 'secret',
      required: false,
      purpose: `Bearer token for API client "${t.name ?? t.id}". That client cannot authenticate until it is set.`,
      how: 'Generate your own long random string (e.g. `openssl rand -hex 32`) — there is no provider page, this value is yours.',
      scope: 'One secret per client, so a leak can be revoked without locking everyone else out.',
      docsUrl: `${SITE}/reference/configuration/`,
    })
  }

  const admin: string | undefined = config?.security?.ui?.admin_secret
  if (admin) {
    items.push({
      name: admin,
      kind: 'secret',
      required: false,
      purpose: 'Secret guarding the web UI admin area. It is a NAME in config, never the value.',
      how: 'Generate a long random string yourself.',
      scope: 'Do not reuse any other secret here; anyone holding it can reach admin actions.',
      docsUrl: `${SITE}/reference/configuration/`,
    })
  }

  if ((hosts ?? []).some((h: any) => h?.kind === 'hyperstack')) {
    items.push({
      name: 'SAIP_HYPERSTACK_API_KEY',
      kind: 'secret',
      required: false,
      purpose: 'Credentials for provisioning remote GPU hosts. Only needed to deploy to cloud, never to run locally.',
      how: 'Sign in to the Hyperstack console → API Keys → Generate a New API Key. Shown once.',
      scope: 'Skip it if you have no hyperstack host in use; `saip awake --host <name>` will refuse until it exists.',
      providerUrl: HS_DOCS,
      docsUrl: `${SITE}/guides/deploy-hyperstack-cloud/`,
    })
    items.push({
      name: 'SAIP_HYPERSTACK_ENVIRONMENT',
      kind: 'config',
      required: false,
      purpose: 'Optional deployment environment selector for the Hyperstack provider.',
      how: 'Leave blank unless your account uses named environments.',
      providerUrl: HS_DOCS,
    })
  }

  return items
}

export interface RunInitOptions {
  store: SecretStore
  items: InitItem[]
  io: Io
  envPath?: string
  /** Pre-supplied answers (CI, `--non-interactive`, or an embedding caller). */
  answers?: Record<string, string>
  interactive?: boolean
  force?: boolean
}

export interface InitResult { code: number; lines: string[]; stored: string[]; skipped: string[] }

const clean = (v: string): string => v.replace(/\r?\n$/g, '').replace(/[\r\n]+/g, '')

/**
 * Drive the wizard. Everything user-facing goes through `io`, so CI never needs a terminal while
 * the real command path still exercises this same function — the split #73/#76 taught us to make.
 */
export async function runInit(opts: RunInitOptions): Promise<InitResult> {
  const { store, items, io, answers = {}, interactive = true, force = false } = opts
  const envPath = opts.envPath ?? envFilePath()
  const lines: string[] = []
  const stored: string[] = []
  const skipped: string[] = []
  const missing: string[] = []
  // Both sinks, always. `emit` writes through io.say so a terminal sees each block BEFORE the
  // prompt it explains, and keeps a copy in `lines` for --non-interactive capture and tests.
  // Previously only the copy existed, so the entire explanation printed after the last prompt.
  const emit = (l: string): void => { lines.push(l); io.say(l) }

  emit('[saip] config init — one value at a time, hidden input, paste works')
  emit('[saip] Enter on an optional item skips it; Ctrl+C stops and keeps what is already saved.')

  try {
  for (const item of items) {
    const alreadySecret = item.kind === 'secret' ? await store.get(item.name).catch(() => undefined) : undefined
    const alreadyConfig = item.kind === 'config' ? readEnvValue(envPath, item.name) : undefined
    const already = alreadySecret ?? alreadyConfig

    if (already && !force) {
      emit(`\n${item.name} — already set (${already.length} chars). Enter keeps it, or type a new value.`)
      const next = interactive ? clean(await io.ask(`${item.name}: `, { secret: item.kind === 'secret' })) : ''
      if (!next) { stored.push(item.name); continue }
      await writeOne(item, next)
      continue
    }

    if (interactive) {
      emit(`\n── ${item.name} ${item.required ? '(required)' : '(optional)'}`)
      emit(`   what    : ${item.purpose}`)
      emit(`   how     : ${item.how}`)
      if (item.scope) emit(`   scoping : ${item.scope}`)
      emit(`   create  : ${item.providerUrl ?? 'generate this one yourself'}`)
      if (item.docsUrl) emit(`   docs    : ${item.docsUrl}`)
    } else if (item.required && !answers[item.name]) {
      // Compact for CI and agents: one line per outstanding value, with the teaching text only
      // where a human will read it.
      emit(`   missing   : ${item.name} — ${item.purpose}`)
    }

    // Scripted answers win when provided (CI, --non-interactive, embedding callers); otherwise the
    // user is prompted. Both paths produce the same routing below, so there is no second flavour
    // of behaviour to drift out of sync.
    // Non-interactive never prompts and never writes: it reports. That is what makes the mode
    // safe to run from CI or an agent, and why a required blank is recorded rather than asked.
    let value = answers[item.name] !== undefined
      ? clean(answers[item.name]!)
      : (interactive ? clean(await io.ask(`${item.name}: `, { secret: item.kind === 'secret' })) : '')

    if (!value) {
      if (!interactive) {
        if (item.required) missing.push(item.name)
        else skipped.push(item.name)
        continue
      }
      if (!item.required) {
        emit(`   → skipped; anything needing ${item.name} stays inert until you set it`)
        skipped.push(item.name)
        continue
      }
      emit(`   → ${item.name} is required and was left empty. Enter it, or Ctrl+C to stop.`)
      const retry = clean(await io.ask(`${item.name}: `, { secret: item.kind === 'secret' }))
      if (!retry) {
        lines.push(`[saip] stopped: ${item.name} is required and cannot be empty. Nothing was written for it.`)
        return { code: 1, lines: [...lines], stored, skipped }
      }
      value = retry
    }
    await writeOne(item, value)
  }

  if (missing.length) {
    lines.push('')
    lines.push(`[saip] not configured (${missing.length} required): ${missing.join(', ')}`)
    lines.push('[saip] run `saip config init` at a terminal for the guided wizard, or set them with:')
    for (const n of missing) {
      const it = items.find((x) => x.name === n)!
      emit(it.kind === 'secret'
        ? `  printf %s "$${n}" | saip config set ${n} --stdin`
        : `  echo '${n}=...' >> ${envPath}`)
    }
    return { code: 1, lines, stored, skipped }
  }

  } catch (e) {
    if (!(e instanceof WizardCancelled)) throw e
    const remaining = items.filter((i) => !stored.includes(i.name)).map((i) => i.name)
    emit('')
    emit('[saip] stopped by Ctrl+C.')
    emit(`[saip] stored so far (${stored.length}): ${stored.join(', ') || 'nothing'}`)
    if (remaining.length) emit(`[saip] still not set (${remaining.length}): ${remaining.join(', ')}`)
    emit('[saip] re-running `saip config init` continues where this left off.')
    return { code: 130, lines, stored, skipped }
  }

  emit('')
  emit(`[saip] stored ${stored.length} value(s): ${stored.join(', ') || 'none'}`)
  if (skipped.length) emit(`[saip] skipped: ${skipped.join(', ')}`)
  emit(`[saip] secrets → ${store.filePath}; interpolated config → ${envPath}`)
  emit('[saip] NOTE: credentials were NOT verified — the R2 client is separate work, and an unsigned')
  emit('[saip]       request 403s for valid and invalid keys alike, so it would prove nothing.')
  emit('[saip]       `saip config verify` will do it once the storage provider lands.')
  return { code: 0, lines, stored, skipped }

  async function writeOne(item: InitItem, value: string): Promise<void> {
    if (item.kind === 'secret') await store.set(item.name, value)
    // Written as it is answered, not batched to the end: an interrupt after five answers must not
    // discard the first four.
    else setEnvFileValues(envPath, { [item.name]: value })
    stored.push(item.name)
    emit(`   → stored ${item.name} (${value.length} chars)`)
  }
}

/**
 * Read one value straight from the env file. Deliberately not `loadEnvFile()` + fold into the
 * process: the wizard must ask "is this already set?" without mutating its own environment.
 */
function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined
  const m = readFileSync(path, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))
  return m?.[1] ? clean(m[1]) : undefined
}
