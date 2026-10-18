# Hosting, Security & Monitoring Foundations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the foundational, pluggable hosting layer (local + Hyperstack/OpenTofu providers), a pluggable security layer (bearer tokens on APIs/MCP, password on UIs), and a pluggable monitoring layer — with local fully working and cloud scaffolded-but-not-applied. Every web/API/MCP surface must pass through the auth seam before it can be served.

**Architecture:** Three new Cordis plugin seams live in `@saip/shared` as services consumed by the CLI, inference gateway, and training gateway: `DeploymentProvider` (local/hyperstack), `AuthProvider` (bearer/password), `MonitoringProvider` (noop/prometheus-later). The CLI gains a `--host <name>` target on awake/sleep/down/status that resolves through a committed `hosts.yaml` registry; a new `saip deploy` command reuses the same provider abstraction to push a parameterized copy to a remote host. OpenTofu configs under `infra/tofu/` define the 2-GPU Hyperstack environment; the hyperstack provider shells out to `tofu` for provisioning then drives compose over SSH (stubbed behind the interface this round). Secrets come exclusively from a `SecretsProvider` seam (env-backed today) referenced by NAME in committed config — never values.

**Tech Stack:** TypeScript ESNext/Bundler, Node ≥22, Cordis 4 rc11, Hono 4, vitest 3, commander 13, yaml; OpenTofu (HCL) under infra/tofu using the `NexGenCloud/hyperstack` alpha Terraform provider; Docker Compose v2.

**Spec / prior art:**
- Live docs: https://adrianwebb.github.io/saip/ (context pack at /context-pack/saip-docs.xml predates #22–#34; read staging docs source)
- Existing contracts this builds on: `reference/adapter-definitions.mdx`, `reference/api-inference.mdx` (§auth currently lax), `inference/README.md` + `training/README.md` plugin tables, AGENTS.md (shell-env secrets stance, "everything is a plugin")
- Hyperstack Terraform provider: https://docs.hyperstack.cloud/docs/libraries/terraform/ (resources: `hyperstack_core_environment`, `_keypair`, `_virtual_machine` w/ GPU flavors like `n3-H100x1`, `_virtual_machine_sg_rule`; alpha caveat); OpenTofu consumes Terraform HCL directly.

## Global Constraints

- All four Node packages compose via Cordis; new capabilities are plugins/injectable services, never core edits.
- Documentation-first per PR; tests outside-in; every package `build` (tsc) + `test` (vitest) green locally AND in CI.
- Agents merge to `staging` only after green CI + checked criteria; never to `main`. Conventional commits `(#issue)`; changelog entry each PR; context packs regenerate cleanly.
- **No secret VALUES in committed files.** Committed config references secret NAMES only; values resolve via `SecretsProvider` (env today). `.env` stays gitignored.
- Local is always present as the baseline host definition; cloud targets are additional named hosts.
- HTTPS git remote.
- Hyperstack provider is alpha — do NOT apply real infra this round; scaffold + gate behind explicit opt-in.

## Review Focus

Failure modes the spec implies but need pinned tests (each gets a test in the owning task):
1. **Auth fail-closed** — an API route reached without the AuthProvider attached must reject, not serve-as-default. Today api-chat/api-systemone silently fall back to the default user; the foundation must make "no auth configured" a boot error or an explicit dev-mode flag, never silent public access.
2. **Unknown host target** — `saip awake --host ghost` fails clearly (lists known hosts), does not silently run local.
3. **Secret name unresolved** — a host/config referencing a secret name absent from the SecretsProvider fails at validation/boot, not at first request.
4. **Provider selection determinism** — resolving a host yields exactly one provider (local vs hyperstack) by its declared kind; ambiguous/missing kind errors.
5. **Deploy parameterization safety** — `saip deploy` refuses to target a host whose provider kind has no registered implementation, and never invents credentials.
6. **Monitoring is non-fatal** — a failing/absent MonitoringProvider never blocks serving or training (observe-only contract).

---

## Decomposition — stacked PRs to staging

Six issues, merged sequentially, each CI-green. One RC at the end (maintainer-gated).

- **PR F** — Shared seams: `DeploymentProvider`, `HostRegistry` (hosts.yaml), `SecretsProvider` (env impl), types + validator + tests. No runtime behavior change.
- **PR G** — Local deployment provider (real) + wire CLI `--host` targeting into awake/sleep/down/status; unknown-host fail-closed.
- **PR H** — AuthProvider seam (bearer for API/MCP, password for UI) + enforce on existing inference/training routes; fail-closed default; dev-mode flag.
- **PR I** — MonitoringProvider seam (noop default) + attach points in both gateways; non-fatal contract.
- **PR J** — `saip deploy` command (option-2 path) reusing DeploymentProvider; parameterized copy-to-host; dry-run; refuses unregistered kinds.
- **PR K** — Hyperstack provider (scaffolded, gated) + `infra/tofu/` OpenTofu module for the 2-GPU env + docs (new explanation + reference pages, README status updates) + final monorepo gate.

---

### Task F1: shared types + validators for hosts, secrets, providers

**Files:**
- Create: `shared/src/hosting.ts`
- Modify: `shared/src/types.ts` (append nothing; keep separate module), `shared/src/index.ts` (re-export hosting), `shared/package.json` (add `./hosting` export)
- Create: `shared/tests/hosting.test.ts`
- Create: `hosts.example.yaml` (repo root, committed template)

**Interfaces:**
- Produces:
  - `type HostKind = 'local' | 'hyperstack'`
  - `interface HostConfig { name:string; kind:HostKind; role:'inference'|'training'|'both'; gpu_node?:string; compose_dir?:string; ssh?:{host:string; user:string; key_secret?:string}; tofu?:{workspace:string; vars?:Record<string,string>}; secrets?:{[refName:string]: string /* SECRET NAME not value */} }`
  - `interface HostRegistryFile { hosts: HostConfig[] }`
  - `validateHostRegistry(reg): ValidationError[]` — unique names, valid kind, role required, hyperstack requires tofu.workspace OR ssh, secret refs are non-empty strings, at least one `role` covers inference and one covers training across the file (Review-Focus #2/#4).
  - `interface SecretsProvider { get(name:string): Promise<string|undefined>; require(name:string): Promise<string> /* throws MissingSecret if absent */ }`
  - `class EnvSecrets implements SecretsProvider` (reads process.env; `require` throws `MissingSecretError`).
  - `interface DeploymentProvider { readonly kind: HostKind; up(host, opts):Promise<void>; down(host, opts):Promise<void>; status(host):Promise<HostStatus>; deploy?(srcHost, dstHost, params):Promise<DeployResult> }`
  - `type HostStatus = { reachable:boolean; mode?:'awake'|'asleep'|'down'; adapters?:string[]; detail?:string }`
  - `interface MonitorSink { emit(metric:Metric):void|Promise<void> }` + `Metric` type (kept minimal here, expanded in PR I).
- Consumes: node fs/yaml for example-file parse test.

- [ ] Step 1: failing test — validateHostRegistry flags duplicate name, bad kind, hyperstack-without-tofu-or-ssh, missing inference+training coverage; passes a valid two-host (local + hyperstack) fixture. Run `pnpm --filter @saip/shared test tests/hosting.test.ts` → FAIL.
- [ ] Step 2: implement hosting.ts types + validateHostRegistry + EnvSecrets + interfaces; add `./hosting` export; re-export from index.
- [ ] Step 3: run test → PASS; add EnvSecrets test (get returns undefined for unset; require throws MissingSecretError).
- [ ] Step 4: create `hosts.example.yaml` (a local `default` host role both + a commented hyperstack pair) with header comment: secrets referenced by NAME only.
- [ ] Step 5: tsc clean; commit `feat(shared): hosting types, host registry validator, secrets/deployment/monitor seams (#F)`.

### Task F2: gateway wiring of SecretsProvider + host resolution service

**Files:**
- Create: `shared/src/services.ts` additions → `HostRegistryService`, `SecretsService` (Cordis Services, static provide)
- Create: `shared/tests/host-services.test.ts`
- Modify: `shared/src/services.ts`

**Interfaces:**
- Produces: `SecretsService` (provide `secrets`) wrapping an injected SecretsProvider (default EnvSecrets); `HostRegistryService` (provide `hosts`) exposing `load(path)`, `resolve(name):HostConfig`, `list()`, `assertValid()` throwing aggregated ValidationError list. Both usable by CLI/gateways identically.
- Consumes: validateHostRegistry, EnvSecrets.

- [ ] Step 1: failing test — boot Context, register both services, load hosts.example.yaml, `hosts.resolve('default').kind==='local'`, `secrets.require('ABSENT')` rejects. Run → FAIL.
- [ ] Step 2: implement the two Service classes; declare `static inject` where they read each other.
- [ ] Step 3: run → PASS; tsc; commit `feat(shared): HostRegistryService + SecretsService Cordis services (#F)`.

*(PR F merges after CI green.)*

---

### Task G1: local deployment provider

**Files:**
- Create: `cli/src/lib/providers/local.ts`
- Create: `cli/tests/local-provider.test.ts`

**Interfaces:**
- Consumes: `HostConfig` (compose_dir, role), child_process (docker compose).
- Produces: `LocalDeploymentProvider implements DeploymentProvider { kind='local' }` — `up/down` shell `docker compose -f <dir>/docker-compose.yml up -d|down` selecting inference vs training stack by role; `status` reads `docker compose ps` (parse minimal) → HostStatus. Accepts an injectable `runner` (defaults to execFileSync) so tests use a fake and never invoke docker.

- [ ] Step 1: failing test with FakeRunner — `up({role:'inference'})` issues the inference compose up command; `down` issues down; `status` maps runner output to reachable/mode. Run → FAIL.
- [ ] Step 2: implement provider + command builders (pure fn `composeArgs(host, verb)` exported for testability).
- [ ] Step 3: run → PASS; tsc; commit `feat(cli): local deployment provider (#G)`.

### Task G2: CLI --host targeting wired through providers

**Files:**
- Modify: `cli/src/index.ts` (register HostRegistryService + SecretsService + provider registry; add global `--host`), `cli/src/commands/{awake,sleep,down,status}.ts` (accept host, dispatch to provider)
- Create: `cli/src/lib/providers/index.ts` (`providerFor(kind):DeploymentProvider` — local real, others throw `UnregisteredProvider`)
- Create: `cli/tests/host-targeting.test.ts`

**Interfaces:**
- Produces: each command resolves `--host` (default `SAIP_HOST` env or `'default'`) via HostRegistryService, picks provider by kind, calls up/down/status. Unknown host → error listing known hosts (Review-Focus #2). Unregistered kind → clear message (never invents creds).

- [ ] Step 1: failing test — `awake --host ghost` rejects with known-hosts list; `awake --host default` invokes local provider up (FakeRunner); provider-for-hyperstack throws UnregisteredProvider (until PR K). Run → FAIL.
- [ ] Step 2: implement provider registry + command refactor to dispatch; keep current console output shape for compatibility.
- [ ] Step 3: run → PASS; full cli suite green (existing 3 updated as needed); tsc; commit `feat(cli): --host targeting via deployment providers (#G)`.

*(PR G merges after CI green.)*

---

### Task H1: AuthProvider seam + bearer/password

**Files:**
- Create: `shared/src/auth.ts`
- Create: `shared/tests/auth.test.ts`
- Modify: `shared/src/index.ts`, `shared/package.json` (`./auth` export)

**Interfaces:**
- Produces:
  - `interface AuthProvider { verifyApi(req:{headers}):Promise<Principal|null>; verifyUi?(req):Promise<boolean>; }`
  - `type Principal = { callerId:string; scopes?:string[] }`
  - `class BearerTokenAuth implements AuthProvider` — validates `Authorization: Bearer <token>` against an injected token→caller map resolved via SecretsProvider (tokens stored as secret NAMES, e.g. `SAIP_TOKEN_ALICE`→alice). Returns null on miss (route turns into 401).
  - `class PasswordSessionAuth implements AuthProvider` — UI guard hook (cookie/session check) with a pluggable verifier; MVP checks a single admin secret name.
  - `class AllowAllDevAuth implements AuthProvider` — explicit dev-mode, returns a fixed principal; used ONLY when `security.dev_mode=true`.
- Consumes: SecretsProvider.

- [ ] Step 1: failing test — BearerTokenAuth accepts a valid token (resolved from env-named secret), rejects missing/bogus (null); AllowAllDevAuth returns dev principal; PasswordSessionAuth verifies a correct secret and rejects wrong. Run → FAIL.
- [ ] Step 2: implement auth.ts + exports.
- [ ] Step 3: run → PASS; tsc; commit `feat(shared): AuthProvider seam (bearer + password + dev) (#H)`.

### Task H2: enforce auth on inference + training routes (fail-closed)

**Files:**
- Create: `inference/src/plugins/auth-middleware.ts`, `training/src/plugins/auth-middleware.ts` (thin Hono middleware factories consuming ctx.auth)
- Modify: `inference/src/index.ts`, `training/src/index.ts` (register AuthProvider service; wrap chat/systemone/data/learning routes), `inference/src/plugins/api-chat.ts` + `api-systemone.ts` (use authenticated Principal instead of silent default), `training/src/plugins/learning-api.ts`
- Create: `inference/tests/auth-enforcement.test.ts`, `training/tests/auth-enforcement.test.ts`
- Modify: `saip.yaml` (+ schema) — add `security:` block `{ dev_mode:false, api_tokens:[{caller,secret}], ui:{admin_secret} }`

**Interfaces:**
- Produces: `ctx.auth` (AuthProvider chosen by config: dev_mode→AllowAllDevAuth else BearerTokenAuth). Middleware returns 401 when verifyApi null. Caller identity now comes from the verified Principal (fixes the silent-default gap, Review-Focus #1). Default `dev_mode:false` ⇒ boot without configured tokens = fail-closed error unless explicitly dev.

- [ ] Step 1: failing test (inference) — with a token map, chat POST without Authorization → 401; with valid bearer → 200 and caller = mapped id; dev_mode:true → 200 anonymous dev principal. Run → FAIL.
- [ ] Step 2: implement middleware + registration; thread Principal into existing caller resolution (replace raw header scrape).
- [ ] Step 3: run → PASS; repeat for training learning-api (x-saip-caller replaced by bearer). Full suites green; tsc; commit `feat(inference,training): enforce bearer auth on API routes (#H)`.
- [ ] Step 4: update `reference/api-inference.mdx` + `api-training.mdx` auth sections (401 semantics, dev_mode) — docs parity.

*(PR H merges after CI green.)*

---

### Task I1: MonitoringProvider seam + attach points

**Files:**
- Create: `shared/src/monitoring.ts`
- Create: `shared/tests/monitoring.test.ts`
- Modify: `shared/src/index.ts`, `shared/package.json` (`./monitoring`)
- Modify: `inference/src/index.ts`, `training/src/index.ts` (register monitoring service; emit metrics on request/job events)

**Interfaces:**
- Produces: `interface MonitoringProvider { counter(name,tags?,n?):void; gauge(...); histogram(...); }`, `class NoopMonitoring implements MonitoringProvider`, and a `Metrics` Cordis service (provide `metrics`) that wraps the chosen provider and NEVER throws (swallows sink errors — Review-Focus #6). Gateways call `ctx.metrics.counter('chat_requests', …)` etc. Prometheus exporter is a future provider behind the same interface.

- [ ] Step 1: failing test — Metrics with a throwing sink does not propagate the error; counters callable pre-init; NoopMonitoring is inert. Run → FAIL.
- [ ] Step 2: implement monitoring.ts + Metrics service; wire emissions (chat req count, job started/complete, data stored) in both gateways.
- [ ] Step 3: run → PASS; ensure existing gateway tests still green (emissions are fire-and-forget); tsc; commit `feat(shared,inference,training): MonitoringProvider seam + metric emission (#I)`.

*(PR I merges after CI green.)*

---

### Task J1: saip deploy command (copy-to-host, parameterized)

**Files:**
- Create: `cli/src/commands/deploy.ts`
- Create: `cli/tests/deploy.test.ts`
- Modify: `cli/src/index.ts` (register command plugin)

**Interfaces:**
- Consumes: HostRegistryService, provider registry, SecretsService.
- Produces: `saip deploy --target <host> [--source local] [--dry-run] [-p key=value…]` — resolves target host, requires its provider to implement `deploy()`, renders parameters into a deploy plan, prints plan; `--dry-run` (and any provider lacking a real deploy) stops at plan without side effects. Refuses unregistered kinds (never invents creds).

- [ ] Step 1: failing test — deploy --target ghost → known-hosts error; deploy --target <hyperstack> → provider-not-implemented/clear message until PR K; deploy --target local --dry-run → prints plan, no runner calls. Run → FAIL.
- [ ] Step 2: implement command + param rendering (pure `renderDeployPlan`).
- [ ] Step 3: run → PASS; tsc; commit `feat(cli): saip deploy command (parameterized copy-to-host) (#J)`.

*(PR J merges after CI green.)*

---

### Task K1: infra/tofu OpenTofu module (scaffold, not applied)

**Files:**
- Create: `infra/tofu/hyperstack/versions.tf`, `providers.tf`, `variables.tf`, `main.tf` (2× GPU VMs: inference + training, keypair, SG rules for 8000/8001/22, floating IPs), `outputs.tf`, `terraform.tfvars.example`, `README.md`
- Create: `infra/.gitignore` (`.terraform/`, `*.tfstate*`)

**Interfaces:**
- Produces: standard OpenTofu config using `NexGenCloud/hyperstack` provider (documented alpha version pin), variables for region/flavor/keypair/SSH public key; outputs `inference_floating_ip`, `training_floating_ip`. tfvars.example references secrets by ENV var name (`API_KEY`), never values.

- [ ] Step 1: write versions/providers/variables/main/outputs with resources per Hyperstack provider docs (environment optional/reused, keypair via tls, two virtual_machines with GPU flavor vars, sg_rules). Keep flavors as variables with sensible defaults.
- [ ] Step 2: `terraform fmt`-style formatting; document `tofu init && tofu plan` (NOT apply) in infra/tofu/hyperstack/README.md; note alpha + cost + opt-in gating.
- [ ] Step 3: validate HCL syntactically if `tofu`/`terraform` available (`tofu validate` in a guarded step); if binary absent, skip with a note (do not install). Commit `chore(infra): OpenTofu module scaffold for 2-GPU Hyperstack env (#K)`.

### Task K2: hyperstack deployment provider (gated scaffold)

**Files:**
- Create: `cli/src/lib/providers/hyperstack.ts`
- Modify: `cli/src/lib/providers/index.ts` (register kind), `cli/tests/host-targeting.test.ts` (now expects hyperstack resolves but gates)
- Create: `cli/tests/hyperstack-provider.test.ts`

**Interfaces:**
- Consumes: HostConfig.tofu, SecretsService (API_KEY), child_process.
- Produces: `HyperstackDeploymentProvider implements DeploymentProvider { kind='hyperstack' }` — `up/down/status` drive compose over SSH (via injected runner); `deploy()` runs `tofu plan`/`apply` ONLY when `SAIP_ALLOW_INFRA=true` else throws `InfraNotAuthorized` (Review-Focus #5 + alpha safety). Real execution is thin wrappers over an injectable runner so it's unit-testable without tofu/docker.

- [ ] Step 1: failing test — provider.kind; deploy() throws InfraNotAuthorized unless allow-flag set (then would call runner — assert via FakeRunner); up() uses ssh compose command builder. Run → FAIL.
- [ ] Step 2: implement gated provider + register in providerFor.
- [ ] Step 3: run → PASS; tsc; commit `feat(cli): hyperstack deployment provider (gated, SSH+tofu seams) (#K)`.

### Task K3: documentation + final verification

**Files:**
- Create: `docs/src/content/docs/explanation/hosting.mdx`, `.../guides/deploy-hyperstack-cloud.mdx` (distinct from existing deploy-hyperstack.mdx which becomes cross-linked), `.../reference/hosts-config.mdx`, `.../reference/security-model.mdx`
- Modify: `docs/astro.config.mjs` (sidebar), `README.md` (architecture: hosts + security + monitoring), `AGENTS.md` (note hosting/seams), `CHANGELOG.md`, `inference/README.md` + `training/README.md` status rows, `docs/src/content/docs/reference/configuration.mdx` (security block)
- Create: `docs/scripts/check-links.sh` already exists — reuse

- [ ] Step 1: write explanation/hosting.mdx (three seams, why local-always, option-1+2 layered model, OpenTofu placement, fail-closed auth, non-fatal monitoring) + reference pages (hosts-config fields table, security-model bearer/password/dev + secret-name rule) + guide (cloud deploy walkthrough, gated apply). Add sidebar entries.
- [ ] Step 2: update root README architecture diagram to show hosts.yaml + providers + auth/monitoring seams; mark R2/vLLM/Marker pending consistent with inference README.
- [ ] Step 3: rebuild docs → format validation + link check green (all new internal links resolve).
- [ ] Step 4: FINAL MONOREPO GATE — `pnpm install`; for shared,inference,training,cli: build + test all green; confirm no regressions; confirm `saip --help` lists deploy; `saip awake --host default` works against local (manual, docker may be absent → assert graceful message).
- [ ] Step 5: commit `docs: hosting, security, monitoring foundations documented (#K)`.

*(PR K merges after CI green.)*

---

### Final: Release candidate (maintainer-gated)

After F–K green on staging: bump six manifests `0.4.0 → 0.5.0` (minor: new capability), open RC `staging→main`, watch CI, STOP for maintainer to merge/tag/publish, then sync main→staging. (Note: the 0.4.0 inference release is still pending maintainer action; fold sequencing with them.)
