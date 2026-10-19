# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).


## [Unreleased]

### Added
- cli: `saip` is now installable and runs however it is launched. The entry guard compared `import.meta.url` against the raw `process.argv[1]`, which is false for a symlinked launcher — the CLI loaded, ran nothing, and exited 0 in silence; it now resolves realpath. Config discovery walks up from the current directory for `saip.yaml` and `hosts.yaml`, honours `SAIP_CONFIG` / `SAIP_HOSTS_FILE` (a bad explicit path is an error naming it, never a silent fallback), and commands print the file they loaded so a global install cannot quietly read another project. The build sets the bin executable bit, `pnpm --filter @saip/cli install:local` links the CLI onto PATH, and `engines.node` is declared (#70)
- cli: `saip config list|get|set|unset|doctor` for the encrypted store — values masked by default, `--reveal` to print one, and piped stdin read automatically so a secret never has to be a process argument (#67)
- shared: encrypted local secret store (`secrets-store.ts`) behind the existing `SecretsProvider` seam — AES-256-GCM at `~/.saip/secrets.enc.json`, key from the OS keychain when `secret-tool` is present and a scrypt-derived passphrase otherwise, with `rotateKey` for re-encrypting under a new key. `SecretsService` now defaults to a chain of shell environment then store, so credentials no longer have to be exported into a shell or written into `saip.yaml` (#67)
- shared: one real config loader — `loadYamlConfig` / `interpolate` / `loadEnvFile`. `${VAR}`, `${VAR:-default}` and `${VAR:?message}` now actually resolve (interpolation was documented in every release so far and implemented nowhere, so `storage.r2.bucket` reached callers as the literal string), and `.env` is loaded by native `saip` and the gateways instead of only by Docker Compose, with the parent shell always winning (#65)
- infra/cli/docs: gated Hyperstack deployment provider (SSH+compose; OpenTofu provisioning behind `SAIP_ALLOW_INFRA`), the `infra/tofu/hyperstack` 2-GPU OpenTofu module (scaffolded, not applied), and full hosting documentation — Hosting Model explanation, Hosts Configuration reference, cloud-deploy guide (#51)
- cli: `saip deploy --target <host>` — parameterized copy-to-host reusing the DeploymentProvider abstraction; renders a safe plan (`--dry-run` default), applies only via providers that implement `deploy()`, refuses unknown/unregistered targets (#49)
- monitoring: pluggable `MonitoringProvider` seam + `MetricsService` (noop default, Prometheus later) wired into both gateways via an event bridge; emission is observe-only and never blocks serving/training (#47)
- security: pluggable `AuthProvider` seam (bearer for API/MCP, password for UI, explicit dev-mode) with **fail-closed** enforcement on inference chat/systemone and training job routes; `security:` block in saip.yaml + schema; new Security Model reference (#45)
- cli: local deployment provider + `--host` targeting on awake/sleep/down/status — hosts resolve through the shared registry (fail-closed on unknown), dispatch to a DeploymentProvider by kind; `SAIP_DRY_RUN` supported (#43)
- shared: hosting foundations — host registry types + `validateHostRegistry`, injectable `SecretsProvider`/`DeploymentProvider` seams, `EnvSecrets`, and `SecretsService`/`HostRegistryService` Cordis services; committed `hosts.example.yaml` (#41)
- inference: Data API sessions + feedback endpoints (reward validated against configured range) and a composed `server` plugin mounting all sub-apps with `startServer()`; gateway now serves its full documented surface (#34)
- inference: Data API documents — pluggable document processors (markdown/code/jsonl, PDF via Marker pending), sha256 dedup, `knowledge/` storage + index, CRUD endpoints (#33)
- inference: OpenAI-compatible `/v1/chat/completions` (stream + non-stream), config-gated `/v1/systemone/completions`, and session collection to storage (#32)
- inference: user-resolver (caller→adapter, default fallback), serve-version resolution (composites → compiled artifact), and `GET /health` + `GET /v1/models` (#31)
- inference: config loader + injectable `StorageProvider`/`VllmBackend` seams (in-memory defaults) and `GatewayStateService`; registry validated on boot (#30)
- cli: rebuilt as a Cordis application — each command is a plugin registering with `CommandRegistryService`; the dispatcher drains it into commander, and `status` resolves adapters through the shared registry service (no duplicated logic) (#25)
- training: `learning-api` Cordis plugin — Learning API honors adapter registry linkage (inherit strategy + data_scopes, override per-job) and rejects composites/unknown adapters with documented status codes (#24)
- inference: `adapter-compiler` Cordis plugin — composite compile planning, version resolution (pins + @latest), staleness detection, and provenance records; Python/PEFT merge execution behind a swappable backend (#23)
- shared: Cordis `AdapterRegistryService` + registry validator (`validateRegistry`) — single source of truth for adapter registry rules, consumed by CLI/inference/training (#22)
- Adapter registry architecture: first-class `adapters:` definitions with scopes, composite user adapters (weighted components + gain), and formal adapter→strategy→data-scope linkage (#19)
- All four Node packages (`cli`, `shared`, `inference`, `training`) documented as Cordis-based — everything is a plugin or injectable shared service (#19)
- Download for AI: Repomix context packs (XML/Markdown/JSON) at stable URLs with header selector (#10)
- Project architecture documentation and README (#1)
- Shared configuration schema (saip.yaml, saip.schema.yaml) (#1)
- CLI skeleton with awake/sleep/down/status commands (#1)
- Docker Compose scaffolds for inference and training services (#1)
- Issue templates and GitHub labels (#1)
- Agent loop guard and HTTPS remote protocol in workflow (#1)
- Changelog convention and monorepo guidance (#1)

### Fixed
- XML context pack now strict well-formed (parsableStyle) — raw doc content no longer breaks XML parsers (#16)
- Download for AI button contrast: accent-colored bold text on subtle surface replaces white-on-light-blue fill (#16)
- Download for AI header menu no longer renders permanently open; panel closes correctly (#13)

> **Backfill owed:** the entries above shipped under tags 0.1.x–0.4.0 but were never filed
> into version sections (releases were cut without touching this file). Back-file them per tag
> rather than letting a later version claim them.

- security: key sources declare `mode: raw | passphrase` rather than being matched by name string — name matching mis-keyed any implementation with a different label, which a test double hit immediately (#67)

- security: `saip deploy -p KEY=VALUE` no longer prints parameter values in the plan. The plan is a log surface and command-line arguments are already visible in `ps`; `--reveal-params` opts back in, and `KEY=secret:NAME` references keep plans readable without carrying a value at all (#67)

### Changed
- config: the shipped `saip.yaml` uses `${VAR:-}` for the R2 bucket/endpoint so platform config stays readable without cloud credentials — strict `${VAR}` would make offline hardware inspection demand credentials just to load a file. An unset value loads as empty and the storage provider is responsible for refusing it (#65)
- config: four hand-rolled YAML readers (inference, `cli status`, `cli profiles`, shared host registry) replaced by the single shared loader. Config errors are matched by `name`, not `instanceof` — `@saip/shared` loads from `dist/` in packages and `src/` in tests, and a dual-identity class silently downgrades a real config error to defaults (#65)

## [0.5.0] - 2026-10-19

> First release cut under closing-at-release: the RC for this version carries the `Closes #N`
> lines derived from merged PR titles, since `Closes` in a `staging` PR never fires.

### Added
- shared: service profile seam — `profiles.ts` (tier validation, `GpuProbe` interface with `NvidiaSmiProbe`/`FakeGpuProbe`, profile resolution, derived `gpu_memory_utilization`, vLLM argv rendering) and the `ProfileService` Cordis service, so CLI, inference, and training resolve identical hardware contracts from one probe; capability-gates KV dtypes and fails closed with a named deficit instead of an OOM (#53)
- inference: profile-driven engine launch — `vllm.Dockerfile` (pinned vLLM 0.31.0, overridable base, shell-interpolated args) and `scripts/generate-engine-args.ts`, which probes the host GPU and renders `.engine-args.env` for compose; documented both service tiers and booted each on real hardware (#53)
- cli: `saip profiles` — probes the GPU and prints every tier, whether this card satisfies it and why not, the resolved selection, the derived `gpu-memory-utilization`, and the engine arguments it would run. `--json` for scripting; exit 0 resolved, 1 configuration error, 2 no profile fits or GPU unreadable. Shares `@saip/shared` resolution with both gateways, so the CLI cannot promise a tier the server then fails to boot (#53)
- cli: `saip awake --profile <name>` plus pre-flight hardware validation — the host resolves first (an unknown host is a mistake regardless of hardware) and the profile is checked only for local targets, refusing to start compose when the card cannot hold the tier instead of crash-looping vLLM (#53)
- cli: `saip status` now reports the GPU (name, total/free VRAM, compute capability) and the active profile with derived utilization and context length, replacing the `GPU: TODO` line; an unaffordable ceiling prints `NOT STARTABLE: insufficient_free_vram: …` (#53)
- inference: `HttpVllmBackend` — the real vLLM/OpenAI client behind the `VllmBackend` seam, configured by `SAIP_VLLM_BASE_URL` (plus optional API key, timeout, retries). Per-user adapters are addressed through the standard `model` field, so the engine stays a plain OpenAI server. Auto-wired by `createApp()` from the environment; **no default endpoint** — unset means routes answer `503 backend_unavailable` while `/health` keeps reporting, so an orchestrator can tell "gateway up, engine missing" from "gateway down" (#53)
- inference: typed engine-failure mapping shared by chat and systemone — `502 backend_error` (engine answered with an error), `503 backend_unavailable` (unreachable), `504 backend_timeout` (no answer in time), with `500 internal_error` reserved for SAIP's own bugs (#53)
- docs: **Hardware Profiles** reference (`/saip/reference/hardware-profiles/`) — the measured VRAM ceilings and GPU capability matrix behind SAIP's two service tiers (8 GB inference-only, 12 GB full serve-and-train loop), including the memory decomposition, per-tier engine arguments, LoRA/adapter targeting rules for hybrid gated-deltanet models, and repro commands. Schema `profile`/`profiles` blocks documented ahead of implementation (#53)

### Fixed
- cli/config: the shipped `saip.yaml` pinned `profile: inference-8gb`, which would cap every capable dev machine at the 8 GB tier permanently; the pin is removed so resolution follows the probed card, and pinning is documented as a deliberate override for CI or shared GPUs (#53)
- docs: the `saip status` reference documented output that does not exist — nested service/PID/temperature/utilization fields, `--json` support, an adapter `last_sync` timestamp, a rolling request rate, and stale `Qwen2.5-7B` model names. Replaced with the real output plus an explicit list of fields still TODO (#53)
- inference: `VllmBackend.stream()` was declared `AsyncIterable<string>` while `api-chat` JSON-stringified each yielded value — a contract no implementation could satisfy without double-encoding. Yielded values are now typed `VllmStreamChunk` objects and the route owns SSE framing. The in-test fake had never implemented `stream()` at all, so the only streaming path CI exercised was the synthesized single-chunk fallback; real SSE parsing is now tested against an actual HTTP server, including frames split across packet boundaries (#53)
- inference: a streaming request that failed **before** the first chunk returned `200` with a truncated body, which clients read as a successful empty generation. The route now primes one chunk before committing headers, so early failures return a real status; mid-stream failures after headers are sent emit an explicit SSE error frame instead of closing silently (#53)
- inference: engine errors were unhandled in both chat and systemone — an OOMing or wedged engine escaped to the framework handler as an opaque `500`, indistinguishable from a gateway bug (#53)
- inference: the compose stack could not start — it passed `--quantization awq` to a BF16 base checkpoint, omitted `--gpu-memory-utilization` entirely, requested 65,536 context on any card, included a malformed `--lora-modules ""`, used the unpinned `latest` image, and claimed host port 8080 which collides with an existing local model server. Replaced with profile-rendered arguments (#53)
- inference/config: `loadConfig` read only `model.base`, so quantization, revision, dtype, KV dtype, `language_model_only`, and the whole `profiles` block never reached the gateway; now carried through (#53)
- docs: hardware requirements corrected against measured evidence. The previous "~7 GB VRAM" figure appeared in nine places and was unachievable with the shipped configuration; tiers are now 8 GB (inference) and 12 GB (local fine-tuning), with compute-capability floors (7.5 inference, 8.0 for bf16 training) (#53)
- docs: removed the instruction to set `SAIP_GPU_MEMORY_UTILIZATION=0.85` (a variable no code read) and the claim that vLLM defaults to 0.90 (it is 0.92); utilization is documented as derived from measured free VRAM, never a constant (#53)
- docs: `saip.schema.yaml` header no longer claims whole-file runtime validation by a nonexistent `shared/src/config-schema.ts`; it names the per-section validators that actually exist (#53)
- docs: quantization guidance fixed — an AWQ checkpoint is required (vLLM cannot AWQ-quantize a BF16 base at load time), the reference checkpoint is the community `QuantTrio/Qwen3.5-4B-AWQ` as no official Qwen AWQ build exists, and bitsandbytes is ruled out as a multi-LoRA serving path; QLoRA is no longer presented as SAIP's training method for Qwen3.5 (#53)
- docs: getting-started no longer describes Qwen3.5-4B as gated access-only, and the CLI/hyperstack examples reference the actual model and profile resolution rather than a stale 7B/4096-token config (#53)
- docs: added a warning that 8-bit KV cache (`int8_per_token_head`, `fp8*`) is forbidden below compute capability 8.9 — fp8 is rejected outright, while int8 is accepted, reports a larger cache, and silently corrupts output on Ampere (measured) (#53)

### Changed
- workflow: issue closure moves to the release candidate. GitHub executes `Closes #N` only on merges into the default branch, and every development PR here targets `staging` — so the keyword never fired for any feature or fix PR, and 19 finished issues sat open. Staging PRs now use `Part of #<issue>`; the `staging`→`main` RC carries the `Closes` lines derived mechanically from merged PR titles since the previous tag, with a hard guard holding back any issue that still has an unchecked acceptance criterion. Hotfixes keep `Closes #N` because they land on `main` (#59)
- workflow: `release-workflow` skill and `AGENTS.md` now mandate post-merge branch cleanup — delete the branch (remote + local) as the last action of every merge, with the four traps documented: squash merges defeat `git branch --merged` and `git branch -d`, `git branch -r` is stale until `--prune`, a bulk delete can silently skip refs, and open PRs must be excluded before deleting (#57)
