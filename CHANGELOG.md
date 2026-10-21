# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).


## [Unreleased]

### Added

### Fixed

### Changed

## [0.6.3] - 2026-10-21

### Added

### Fixed
- docs: install commands show **full URLs again** (#141). The panel had been shortened with a `B=https://…` first line to stop long URLs clipping — a fix that traded a layout bug for instructions reading like shell history. The URLs are spelled out again and the clipping is solved by sizing the code to the content column: fits without scrolling at desktop, laptop and tablet widths, and scrolls with the fade only on a phone

### Changed

## [0.6.2] - 2026-10-21

### Added

### Fixed
- test: `config-init` is now hermetic against ambient `SAIP_*` variables (#138). The wizard reports where a value comes from and shell wins, but most of the file called `runInit` without an explicit `env`, so it asserted about `process.env`: a developer shell exporting `SAIP_R2_BUCKET` made the suite red locally while CI, which has no such variables, stayed green. Found while cutting 0.6.2. Snapshot/clear/restore in `beforeEach`/`afterEach`; tests that want a shell value still pass `env` explicitly

### Changed
- docs: the install panel now reads as one instruction rather than three parts (#137) — "Detected your platform" is centred directly above the command box, a **Copy** button sits in the box's top-right and puts the exact on-screen sequence on the clipboard (newline-separated, no `$` prompts, paste-and-run, with a selection fallback when the async clipboard API is unavailable or denied), long release URLs no longer clip because the host is held in `$B`, the panel has real padding with a fade when a line does overflow, and on Getting Started the panel is folded into path A instead of floating above the instructions. Verified in a real browser: clipboard text equals the visible text for all five platforms

## [0.6.1] - 2026-10-21

### Added

### Fixed

### Changed
- docs: the download section rewritten for someone installing the CLI for the first time (#132) — the commands for the platform in focus now sit in a permanent green panel instead of a collapsed "Verify the download" box, a single "Detected your platform: …" line replaces the explanatory prose, per-platform footnotes and defensive wording ("every target stays available", "unblock on first run") are gone, macOS notes appear only when a macOS target is chosen, and choosing a target updates the commands so the steps always match what you downloaded. Mac detection defaults to Apple Silicon because Safari and Chrome report "Intel Mac OS X" on ARM hardware. Uses Starlight's own green tokens, so it inverts correctly in dark mode

## [0.6.0] - 2026-10-21

### Added
- docs: **the link checker can now verify the deployed site**, closing the gap that let the #123 404s ship. `check-links.mjs --origin=<url>` requests every internal link against the live origin, and a new `verify-live` job in the docs workflow runs it after deployment plus spot-checks the five pages from that report. The build-time check cannot see this class at all: `/tutorials/getting-started/` and `/saip/tutorials/getting-started/` map to the same file on disk. Verified by injecting the historical href into a copy of the build — the checker fails with the page, the href and the reason (#123)
- docs: **per-architecture download section on the homepage, getting-started, and the CLI reference** (#123). A `DownloadButtons` component lists all five release targets (`linux-x64/-arm64`, `darwin-x64/-arm64`, `windows-x64.exe`) with platform icons, direct `releases/latest/download/…` links, checksum instructions, and the macOS/Windows first-run caveats. Platform detection only reorders emphasis — every target stays visible, because an agent or a container is not the browser's guess. Availability is stated rather than implied: assets are attached automatically only from the release after #111, and `0.5.0` carries none
- cli: **`pnpm --filter @saip/cli install:dev`** builds the host Bun binary and installs it as `saip-dev` in `~/.local/bin`, so the compiled artifact users get is runnable alongside the source-linked `saip` (#119). It reuses the release build script — so the version-parity guard applies to dev builds too — executes what it installed to verify `--version` and `--built`, records provenance in `saip-dev.meta.json` with a `sha256`, and refuses to overwrite a `saip-dev` it did not install unless `--force`. `saip --built` now reports commit, target, version and build time; the values are substituted at build time because a compiled binary has no `.git` to read
- cli: **shared UI component library behind a pluggable renderer seam** (#113) — commands now build blocks (`card`, `keyValues`, `columns`, `line`, `rule`) and a `Renderer` draws them: `plain` for pipes/CI/agents, `ink` for a UTF-8 TTY, and a new `jsonl` renderer that `--json` selects so **every** command can be driven by scripts and agents without Ink in the path. Components stay plain typed exports rather than Cordis plugins (a `Card` has nothing to substitute; a widget registry would trade typechecking for runtime lookup) while the renderer — the layer that genuinely varies — is the registered, validated seam. Content parity between renderers is asserted per component. `saip status` is the first command migrated (#113)
- cli: `saip config init`, a guided first-time credential wizard — one value at a time with echo off, paste accepted, each prompt explaining what the value is for, where to create it and how to scope it. Questions are derived from the user's own `saip.yaml`/`hosts.yaml`, so undeclared features are never asked about. Secrets go to the encrypted store; interpolated values (bucket, endpoint) go to `.env`, because interpolation reads shell and `.env` and never the store. `--non-interactive` reports what is missing and writes nothing, for CI and agents (#78)
- ci: smoke gate that launches the **built CLI through PATH** and asserts output plus exit codes, failing on the silent-success signature (exit 0, no output) that hid #70. Proven against its own target: reintroducing the entry-guard bug makes it fail; `node cli/dist/index.js` does not, which is why the step uses a symlink (#76)
- shared,cli: secret store v2 with **wrapped keys** — a random KEK encrypts the store and is held separately under each unlock method, so adding or removing a method never re-encrypts secrets and rotating a passphrase re-wraps only the KEK. There is no password hash: the GCM tag on the wrapped KEK is the check. `saip config key list\|add\|remove` exposes the methods, `doctor` reports which wrap unlocked and warns while an opt-in `unattended` wrap exists, and creation now prompts and confirms over the controlling terminal (#73)
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

- security: `defaultSecretsProvider(env)` passed `env` to the environment link only, while the store fell back to `process.env` — so an embedder supplying its own environment got a provider that could not unlock the store it was pointed at, and the library default silently reproduced #73's unreachable-prompt bug (#76)
- inference: the adapter alias index was snapshotted once at boot, so a newly promoted adapter stayed invisible until restart, contradicting `architecture.mdx`'s "the next request uses it without any client-side change". The initial read is now awaited and a miss triggers a refresh (#76)

- cli: `saip config init` shows each credential's explanation **before** prompting for it, rather than buffering the transcript and printing it after the last prompt, and **Ctrl+C now works** — raw mode had disabled `ISIG`, so the keypress arrived as an ordinary byte and the wizard hung. Cancelling exits 130, keeps everything already answered (config values are written per item, not batched), and reports what remains; bracketed-paste markers no longer leak into pasted keys (#78)
### Fixed
- ci: **the Windows fix needed a second pass** (#122). Naming the shim `npx.cmd` turned `ENOENT` into `EINVAL`, because since CVE-2024-27980 Node refuses to spawn `.cmd`/`.bat` files without a shell. `runBun()` now invokes `npx` through `cmd.exe /c` on Windows with every argument validated against an allowlist (spaces rejected, so a checkout under a path containing one fails loudly rather than splitting mid-command), and keeps the direct spawn on POSIX. The first attempt was merged as though it were sufficient; the matrix run said otherwise within minutes
- docs: **every documentation link now verified by a URL-aware checker, and the homepage's four 404s are fixed** (#123). `LinkCard href`s and the hero buttons in `index.mdx` omitted the site base (`/saip`), so they requested `/tutorials/getting-started/` at the domain root — confirmed live: HTTP 404 vs 200 for the base-prefixed URL. The old `check-links.sh` reported all 853 links valid anyway because Astro writes `dist` *without* the base, so both the correct and the broken href map to the same existing file: a filesystem check cannot see a URL fact. `scripts/check-links.mjs` replaces it — it rejects any root-absolute href missing the base, resolves relative links per browser rules, verifies in-page anchors exist (which caught three more broken links: two to a heading that is not `#awake-sleep-mode-…` and a self-link to a section that was never written), and optionally probes external URLs with `--live`. It runs inside `pnpm --filter @saip/docs build`, so CI fails on a broken link rather than the site shipping one
- cli: **builds no longer rewrite tracked source to inject provenance** (#125). `install:dev` substituted the commit into `cli/src/version.ts`, compiled, then restored it — while vitest ran `version.test.ts` in a parallel worker asserting that file's placeholder text, so CI failed intermittently (PR #124) and a crash mid-build could have committed a machine-specific constant. `build-binaries.mjs` now stamps a **throwaway copy** of `src` (gitignored `cli/.build-provenance/`), release binaries gain commit provenance too, and a test forbids any build script writing into `src/`
- ci: **the release matrix is no longer red on windows-x64** (#122). `execFileSync('npx', …)` cannot spawn the batch wrapper Windows ships (`npx.cmd`), so every push to `staging` since the matrix landed failed `Compile for bun-windows-x64` while the other four architectures passed. The platform-correct executable name now lives in `scripts/build-lib.mjs`, used by both the release and dev-install paths; `install:dev` also names its binary `saip-dev.exe` on Windows, since a nameless file there is not an executable
- cli: `awake`, `sleep`, `down`, `deploy` and the shared host-status line now render through the `ui` seam (#113) — the `[saip] ` marker moved out of the command bodies into the renderer, so the same content is produced by the plain, Ink and JSON targets. `UiService` gains `fail()` for stderr diagnostics, which stay human even under `--json` (the stream invariant is about stdout)
- cli: **`--json` is a guarantee on every command** (#113, #115) — stdout of a `--json` run is valid JSONL, or the command answers with a `not_structured` record and exits 2 **without running**, so `saip awake --json` can no longer switch a stack. Fixes a defect shipped in 0.5.0: `saip profiles --json` printed its `[saip] config: …` provenance line to stdout immediately before the JSON body, so the stream did not parse. Provenance now goes to stderr, the payload is compacted to one record per line, and a dispatcher-level guard quarantines `console.log` while JSON mode is on. New `cli/tests/json-mode.test.ts` asserts the shape of stdout rather than the shape of the object (#115)
- ci: **tagged releases now publish the per-platform binaries and `SHA256SUMS`** (#111). Releases before this were cut by hand and carry no assets, while the install docs told users to `curl` them — the documented download 404ed against release `0.5.0`. Each platform is compiled and **executed on a native runner** before upload, a missing platform fails the release rather than publishing a partial set, the tag must equal the version the binary reports, and an existing hand-written release gets assets attached without its notes being overwritten. The docs now say plainly which releases carry binaries (#111)
- XML context pack now strict well-formed (parsableStyle) — raw doc content no longer breaks XML parsers (#16)
- Download for AI button contrast: accent-colored bold text on subtle surface replaces white-on-light-blue fill (#16)
- Download for AI header menu no longer renders permanently open; panel closes correctly (#13)

> **Backfill owed:** the entries above shipped under tags 0.1.x–0.4.0 but were never filed
> into version sections (releases were cut without touching this file). Back-file them per tag
> rather than letting a later version claim them.

- security: key sources declare `mode: raw | passphrase` rather than being matched by name string — name matching mis-keyed any implementation with a different label, which a test double hit immediately (#67)

- security: `saip deploy -p KEY=VALUE` no longer prints parameter values in the plan. The plan is a log surface and command-line arguments are already visible in `ps`; `--reveal-params` opts back in, and `KEY=secret:NAME` references keep plans readable without carrying a value at all (#67)

- security: both key sources are now actually reachable from the CLI. Previously `defaultKeySources()` was called with no prompt and no keychain runner, so an injected test double was the only thing that could unlock a store and every real `saip config set` failed — green tests, unusable binary (#73)
- cli: `saip config set` reads stdin only with `--stdin`. The earlier auto-detect-when-not-a-TTY made any non-interactive invocation hang indefinitely waiting for input (#73)

- security: an `unattended` wrap could be created but **never used** — the CLI built its key sources without that tier, and the key path was derived from the environment instead of from the store it belongs to, so any store relocated with `SAIP_SECRETS_FILE` could not find its own key. Reading now offers every tier that may exist on disk while creation stays opt-in, and there is a single store-construction site in the CLI instead of two (#73)

- docs,cli: corrected a wrong conclusion recorded in `DisplayService` and the CLI reference. Both claimed Ink could not be bundled; the failures came from the spike's configuration (Ink's optional `react-devtools-core` was not installed). Re-measured: Ink works under plain Node (including into a pipe) and compiles to a working Bun binary (~0.7 MB over a plain one), while the esbuild failure and the `TERM=dumb` non-degradation still hold. The hand-rolled renderer remains, on an honest basis — no dependencies and identical behaviour in every environment — and the correction keeps the measurements and their configuration visible so the mistake is not re-made in either direction (#103)

- cli: the executable is now `dist/bin.js`, a file whose only job is to start the CLI, and `dist/index.js` is a library with no self-executing side effects (#101). The previous entry point detected whether it was `main` by comparing `import.meta.url` against `realpathSync(process.argv[1])`; in a compiled single-file binary that path is `/$bunfs/root/…`, which does not exist, so detection failed and the binary **exited 0 having printed nothing**. Detecting "am I main?" is only needed while one file plays two roles, so the roles are split and the guard is gone. Unblocks Bun packaging (#71) and Ink (#106)

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
