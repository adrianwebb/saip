/**
 * The secret catalog (#93) — declared facts about every credential SAIP knows about.
 *
 * Why a catalog rather than a name pattern: sensitivity, requiredness, purpose and scope are
 * things the system KNOWS. Deriving them by matching substrings is a guess, and the first guess was
 * wrong in production — `SAIP_UI_ADMIN` is a password but did not match the pattern until `ADMIN`
 * was added by hand (#87). A guess also fails silently: a new variable is mis-classified until
 * someone notices it was displayed in plaintext.
 *
 * This file is the single source for both the wizard's guidance and the runtime's access policy, so
 * the help text and the enforcement cannot drift apart. `usedBy` is what lets a command say "I am
 * reading this because X" instead of prompting without explanation.
 *
 * Entries marked `inferred` are the only ones whose sensitivity was decided by heuristic, and that
 * is recorded so it can be presented as an assumption rather than a fact.
 */
import { isSensitiveName } from './secrets-store.js'

const SITE = 'https://adrianwebb.github.io/saip'
const R2_DOCS = 'https://developers.cloudflare.com/r2/api/tokens/'
const HF_DOCS = 'https://huggingface.co/docs/hub/en/security-tokens'
const HS_DOCS = 'https://docs.hyperstack.cloud/docs/api-reference/authentication/'
const CF_ACCOUNT = 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/'

export interface SecretEntry {
  readonly name: string
  /** Declared. Never recomputed for catalogued names. */
  readonly sensitive: boolean
  readonly required: boolean
  readonly purpose: string
  readonly how: string
  readonly scope?: string
  readonly providerUrl?: string
  readonly docsUrl?: string
  /** Commands that read this secret — the reason a prompt is justified. */
  readonly usedBy: readonly string[]
  /** True when `sensitive` was inferred from the name because the entry is not catalogued. */
  readonly inferred?: boolean
  /** `config` values go to `.env` (interpolated); `secret` values go to the encrypted store. */
  readonly kind: 'config' | 'secret'
}

export const SECRET_CATALOG: readonly SecretEntry[] = [
  {
    name: 'SAIP_R2_BUCKET', kind: 'config', sensitive: false, required: true,
    purpose: 'Object storage for adapters, knowledge, sessions and feedback. Everything the platform persists lives here.',
    how: 'Cloudflare dashboard → R2 Object Storage → Overview → Create bucket. The value is the bucket name, not a URL.',
    scope: 'One private bucket per deployment is enough. Do not make it public: adapter weights and user data go in it.',
    providerUrl: 'https://dash.cloudflare.com/?to=/:account/r2/overview',
    docsUrl: `${SITE}/guides/manage-secrets/`,
    usedBy: ['config init', 'config help', 'inference gateway', 'training sync'],
  },
  {
    name: 'SAIP_R2_ENDPOINT', kind: 'config', sensitive: false, required: true,
    purpose: 'The S3-compatible endpoint SAIP talks to. R2 is not addressed by the AWS endpoint.',
    how: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com — find the account ID in the dashboard header. ${CF_ACCOUNT}`,
    scope: 'Buckets created in a jurisdiction need that jurisdiction’s endpoint (…​.eu. / …​.us. / …​.fedramp.), and a client cannot mix them.',
    providerUrl: R2_DOCS, docsUrl: `${SITE}/reference/configuration/`,
    usedBy: ['config init', 'config help', 'inference gateway', 'training sync'],
  },
  {
    name: 'SAIP_R2_ACCESS_KEY_ID', kind: 'secret', sensitive: true, required: true,
    purpose: 'The Access Key ID half of the credential SAIP signs storage requests with.',
    how: 'R2 → Overview → Account Details → API Tokens → Manage → Create Account (or User) API token, then copy the Access Key ID shown once.',
    scope: 'Permission "Object Read & Write", scoped to the bucket above. Not Admin Read & Write, and not an account-wide token: SAIP only reads and writes objects.',
    providerUrl: R2_DOCS, docsUrl: `${SITE}/guides/manage-secrets/`,
    usedBy: ['config init', 'config help', 'inference gateway', 'training sync', 'config verify (A3)'],
  },
  {
    name: 'SAIP_R2_SECRET_ACCESS_KEY', kind: 'secret', sensitive: true, required: true,
    purpose: 'The signing secret half. Together with the ID above it grants write access to all your platform data.',
    how: 'Shown exactly once at token creation. If it was not copied, create a new token — there is no way to recover it.',
    scope: 'Treat rotation as cheap: revoke the token in the dashboard, then re-run `saip config init`.',
    providerUrl: R2_DOCS, docsUrl: `${SITE}/guides/manage-secrets/`,
    usedBy: ['config init', 'config help', 'inference gateway', 'training sync', 'config verify (A3)'],
  },
  {
    name: 'SAIP_HF_TOKEN', kind: 'secret', sensitive: true, required: false,
    purpose: 'Hugging Face token, used when pulling base weights or gated repositories during training and serving.',
    how: 'huggingface.co → Settings → Access Tokens → New token. Name it after this deployment so it can be revoked alone.',
    scope: 'Skip it if you only use public checkpoints. Read is enough; fine-grained and scoped to the repos you actually pull.',
    providerUrl: 'https://huggingface.co/settings/tokens', docsUrl: HF_DOCS,
    usedBy: ['config init', 'config help', 'training fetch', 'inference gateway'],
  },
  {
    name: 'SAIP_HYPERSTACK_API_KEY', kind: 'secret', sensitive: true, required: false,
    purpose: 'Credentials for provisioning and controlling remote GPU instances. Not needed to run locally.',
    how: 'Sign in to the Hyperstack console → API Keys → Generate a New API Key. The value is shown ONCE and cannot be recovered.',
    scope: 'Issue a key per deployment rather than reusing a personal one, so a leak can be revoked alone. Mind the billing surface: this credential can create billable GPUs.',
    providerUrl: HS_DOCS, docsUrl: `${SITE}/guides/deploy-hyperstack-cloud/`,
    usedBy: ['config init', 'config help', 'saip awake', 'saip sleep', 'training remote'],
  },
  {
    name: 'SAIP_HYPERSTACK_ENVIRONMENT', kind: 'config', sensitive: false, required: false,
    purpose: 'Selects which Hyperstack environment the provider operates in.',
    how: 'Copy the environment identifier from the console. Leave blank unless your account uses named environments.',
    providerUrl: HS_DOCS, docsUrl: `${SITE}/guides/deploy-hyperstack-cloud/`,
    usedBy: ['config init', 'saip awake'],
  },
  {
    name: 'SAIP_SSH_PRIVATE_KEY', kind: 'secret', sensitive: true, required: false,
    purpose: 'Private half of the key pair used to log into a provisioned instance as ubuntu.',
    how: 'Downloaded once when the key pair is created in the console, then stored here.',
    // Declared where the fact belongs: the guidance and the access policy read the same entry.
    scope: 'NOT ENFORCED YET: the provider builds `-i /run/secrets/<key_secret>`, treating the secret NAME as a path nothing populates, so storing this value does not yet make remote SSH work. Superseded by #89 (SAIP-managed keypairs).',
    docsUrl: `${SITE}/guides/deploy-hyperstack-cloud/`,
    usedBy: ['config init', 'config help', 'saip awake (pending #83/#89)'],
  },
]

export interface RetiredSecret {
  readonly name: string
  /** Why it went, so tooling can answer "I used to be asked for this — why not now?" */
  readonly reason: string
  /** The config path that referenced it, kept so a legacy file can be diagnosed. */
  readonly configPath: string
  readonly since: string
}

/**
 * Retired credentials. Removal is the honest resolution for a secret that promised protection
 * nothing implemented: `security.ui.admin_secret` was prompted for, stored, and typed — while the
 * guard class that would have checked it was never constructed and no UI route existed to guard.
 * Values a user already stored are still treated as sensitive (#90).
 */
export const RETIRED_SECRETS: readonly RetiredSecret[] = [
  {
    name: 'SAIP_UI_ADMIN',
    reason: 'No UI route exists and PasswordSessionAuth is never constructed, so the value guarded nothing. Removed instead of left implying protection (#90).',
    configPath: 'security.ui.admin_secret',
    since: '#90',
  },
]

export function retiredSecret(name: string): RetiredSecret | undefined {
  return RETIRED_SECRETS.find((r) => r.name === name)
}

export function findSecret(name: string): SecretEntry | undefined {
  return SECRET_CATALOG.find((e) => e.name === name)
}

export interface CatalogQuery {
  config: any
  hosts: readonly { kind?: string }[]
  /** Entries discovered from the user's own config that are not in the catalog. */
  extra?: readonly SecretEntry[]
}

/**
 * The catalog as it applies to one deployment: the core entries, plus anything the user's
 * `saip.yaml` references by name. Names outside the catalog are added with sensitivity INFERRED from
 * the name and labelled as such — a declared fact and a guess must never look the same.
 */
export function catalogFor(query: CatalogQuery): SecretEntry[] {
  // The catalog is the registry of declared facts; this function decides what APPLIES to one
  // deployment. SAIP_UI_ADMIN is described (so its caveat travels with it) but is not asked about
  // unless the config references an admin secret — prompting for a credential that gates nothing,
  // in a deployment that has no UI guard configured, is noise that also implies protection.
  const relevant = SECRET_CATALOG.filter((e) => {
    if (e.name === 'SAIP_UI_ADMIN') return Boolean(query.config?.security?.ui?.admin_secret)
    return true
  })
  const out: SecretEntry[] = [...relevant]
  const seen = new Set(out.map((e) => e.name))

  const add = (name: string, make: () => SecretEntry): void => {
    if (!name || seen.has(name)) return
    seen.add(name)
    out.push(make())
  }

  for (const t of query.config?.security?.api_tokens ?? []) {
    const name: string | undefined = t?.token_secret
    if (!name) continue
    add(name, () => ({
      name, kind: 'secret', sensitive: true, required: false,
      purpose: `Bearer token for API client "${t.name ?? t.id}". That client cannot authenticate until it is set.`,
      how: 'Generate your own long random string (e.g. `openssl rand -hex 32`) — there is no provider page; this value is yours.',
      scope: 'One secret per client, so a leak can be revoked without locking everyone else out.',
      docsUrl: `${SITE}/reference/configuration/`,
      usedBy: ['config init', 'config help', 'api auth'],
      // Declared here rather than inferred: a bearer token is sensitive by definition.
    }))
  }

  const hf: string | undefined = query.config?.storage?.r2?.token_env
  if (hf && hf !== 'SAIP_HF_TOKEN') add(hf, () => findSecret('SAIP_HF_TOKEN')! ?? { ...SECRET_CATALOG[4], name: hf })

  for (const e of query.extra ?? []) add(e.name, () => e)

  return out
}

/** Sensitivity for an arbitrary name: declared if catalogued, otherwise inferred and flagged. */
export function sensitivityOf(name: string): { sensitive: boolean; declared: boolean } {
  const e = findSecret(name)
  if (e) return { sensitive: e.sensitive, declared: true }
  // A retired name is still known, not guessed: we are confident it was a credential, which is why
  // a leftover value must stay masked even though nothing reads it. Falling through to the pattern
  // would report this as a guess.
  if (retiredSecret(name)) return { sensitive: true, declared: true }
  return { sensitive: isSensitiveName(name), declared: false }
}
