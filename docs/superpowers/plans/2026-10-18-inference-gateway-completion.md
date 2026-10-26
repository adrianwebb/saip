# Inference Gateway Completion Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. If a subagent-driven execution skill is installed, use it; otherwise work the checkboxes directly in this session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the SAIP inference gateway so it serves the full documented surface — OpenAI-compatible chat completions, SystemOne structured output, adapter resolution/selection, session collection, and the Data API (`/v1/data/*`) with pluggable document processors — wired as Cordis plugins behind injectable vLLM/storage backends.

**Architecture:** The gateway is a Cordis app composing focused plugins (`user-resolver`, `session-collector`, `data-api`, `api`, plus existing `adapter-compiler`). External systems (vLLM HTTP engine, object storage) are reached through **injectable backend interfaces** with in-memory/fake implementations for tests, exactly as the compiler already treats its Python merge backend. R2 is not yet implemented in shared, so storage goes behind a `StorageProvider` seam defaulting to in-memory; the real R2 client lands in a later issue. This keeps every endpoint testable deterministically without a GPU or network.

**Tech Stack:** TypeScript (ESNext/Bundler), Node ≥22, Cordis 4 rc11, Hono 4 (+ @hono/node-server), vitest 3, yaml, zod. Package: `@saip/inference`. Depends on `@saip/shared` (AdapterRegistryService, types).

**Spec:** The docs ARE the spec here. Authoritative pages (on staging):
- `docs/src/content/docs/reference/api-inference.mdx` — exact request/response shapes for `/v1/chat/completions`, `/v1/models`, `/health`, `/v1/systemone/completions`, and all `/v1/data/*` endpoints + Document Processor Plugins table
- `docs/src/content/docs/inference/README.md` — plugin responsibilities, event names, request flow, adapter selection order
- `docs/src/content/docs/reference/adapter-definitions.mdx` — registry/validation contract
- Context pack (latest deployed): https://adrianwebb.github.io/saip/context-pack/saip-docs.xml (note: predates #22–#25; read staging docs source for those)

## Global Constraints

- All four Node packages compose via Cordis; new capabilities are plugins/services, never core edits (AGENTS.md).
- Documentation-first: update reference/README docs before code in each PR.
- Tests outside-in per layer; every package change runs `pnpm --filter @saip/inference build` (tsc) and `test` (vitest) green locally AND in CI.
- Conventional commits referencing `(#<issue>)`; changelog entry under `[Unreleased]`; context packs regenerate cleanly.
- HTTPS git remote; agents merge to `staging` only after green CI + checked criteria; never to `main`.
- No secrets in committed files; callers authenticated by bearer token mapped in user manifest (file-based MVP).
- Injectable-backend rule: no plugin may import a concrete R2/vLLM client directly; it consumes an interface injected at construction (mirrors `CompilerBackend`).
- Version bump deferred to a single RC at the end of the stack (0.4.0), maintainer-gated.

## Review Focus

Failure modes the spec implies but that need explicit pinned tests (each gets a test in the owning task):
1. **Unknown caller / missing Authorization header** → DECIDED for MVP: a request with no credential or an unknown caller resolves to the `id:'default'` user's adapter and is served (never 401), because the MVP uses file-based user manifests without enforced auth; a known caller gets their own adapter. Pin this exact behavior with tests in B1 and C1.
2. **Composite vs leaf adapter served** → a user's `inference` adapter may be a composite; the gateway serves the *compiled* artifact id, never attempts to load components individually. Test resolution returns a concrete `name@version`.
3. **Data processor rejects unsupported type** → unknown extension/source_type returns a structured error, does not write storage. Test.
4. **Dedup by hash** → identical document content re-submitted is marked duplicate and not re-stored. Test.
5. **SystemOne disabled** → when `inference.systemone.enabled=false`, `/v1/systemone/*` returns 404/not-registered. Test.
6. **Streaming vs non-streaming** → `stream:true` yields SSE chunks ending `[DONE]`; non-stream yields JSON usage block. Test both against a fake vLLM.

---

## Decomposition into Stacked PRs

Five issues, merged sequentially to `staging`, each independently CI-green. Issue numbers assigned at execution start (create then branch). Parent epic note links them.

- **PR A** — Storage + vLLM backend seams + config loading (foundation)
- **PR B** — User resolver + adapter selection/resolution + `/v1/models` + `/health`
- **PR C** — Chat completions + SystemOne API over fake vLLM + session collector
- **PR D** — Data API: documents (processors + CRUD + dedup + storage)
- **PR E** — Data API: sessions + feedback endpoints; wire full app; final docs/changelog

---

### Task A1: Config loader + backend interfaces (storage, vllm)

**Files:**
- Create: `inference/src/lib/config.ts`
- Create: `inference/src/lib/backends.ts`
- Create: `inference/tests/config.test.ts`
- Create: `inference/tests/backends.test.ts`

**Interfaces:**
- Consumes: `@saip/shared` types (`UserEntry`, `AdapterDefinition`; add a minimal `Message = { role:string; content:string }` type here or reuse from shared if present), node fs/yaml.
- Produces:
  - `loadConfig(path?: string): SaipRuntimeConfig` where `SaipRuntimeConfig = { model: {base:string}, users: UserEntry[], adapters: AdapterDefinition[], inference: { port:number, maxLoras:number, systemone:{enabled:boolean} }, training?: { methods?: { weighted_kto?: { reward_range:[number,number] } } }, storage?: {...} }`
  - `interface StorageProvider { put(key:string, body:string|Uint8Array):Promise<void>; get(key:string):Promise<string|undefined>; list(prefix:string):Promise<string[]>; delete(key:string):Promise<boolean> }`
  - `class MemoryStorage implements StorageProvider` (Map-backed; deterministic; used in tests + MVP local)
  - `interface VllmBackend { chat(req:VllmChatRequest):Promise<VllmChatResponse>; stream?(req):AsyncIterable<string> }`
  - `type VllmChatRequest = { model:string; messages:Message[]; temperature?:number; max_tokens?:number; top_p?:number; stop?:string|string[] }`
  - `type VllmChatResponse = { id:string; created:number; model:string; choices:Array<{index:number;message:Message;finish_reason:string}>; usage:{prompt_tokens:number;completion_tokens:number;total_tokens:number} }`

- [ ] **Step 1: Write failing test** `config.test.ts`: `loadConfig()` pointed at repo `saip.yaml` returns `adapters.length===3`, `users[0].adapters.inference==='default-agent@latest'`, `inference.systemone.enabled===true`. Run `pnpm --filter @saip/inference test tests/config.test.ts` → FAIL (module missing).
- [ ] **Step 2: Implement** `loadConfig` reading YAML from `process.env.SAIP_CONFIG ?? 'saip.yaml'`, mapping snake_case→typed runtime config; tolerate missing file by returning safe defaults `{}`-shaped empty arrays. Keep pure (no side effects).
- [ ] **Step 3: Run config test** → PASS.
- [ ] **Step 4: Write failing test** `backends.test.ts`: MemoryStorage put/get/list/delete round-trips; `list('documents/')` returns only that prefix sorted; get-missing→undefined; delete-missing→false.
- [ ] **Step 5: Implement** `MemoryStorage` + declare `StorageProvider`, `VllmBackend`, request/response types.
- [ ] **Step 6: Run backends test** → PASS.
- [ ] **Step 7: tsc** `pnpm --filter @saip/inference build` → exit 0.
- [ ] **Step 8: Commit** `feat(inference): config loader + storage/vllm backend seams (#<A>)`.

---

### Task A2: Wire createApp to accept injected config + backends

**Files:**
- Modify: `inference/src/index.ts`
- Create: `inference/tests/app-wiring.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `MemoryStorage`, `VllmBackend`, existing `AdapterRegistryService`, `AdapterCompilerService`.
- Produces: `createApp(opts?: { config?, storage?, vllm? }): Promise<Context>` — defaults to `loadConfig()` + `new MemoryStorage()`; stores resolved config + storage on ctx via a lightweight `gatewayState` service so later plugins inject it. Registers `AdapterRegistryService` (existing) and validates the loaded registry via `ctx.adapterRegistry.validate(...)`, throwing on invalid.

- [ ] **Step 1: Failing test** `app-wiring.test.ts`: `const ctx = await createApp(); expect(ctx.adapterRegistry).toBeDefined(); expect(typeof ctx.gatewayState?.storage?.put).toBe('function'); expect(ctx.gatewayState.config.adapters.length).toBe(3)`. Run → FAIL.
- [ ] **Step 2: Implement** a `GatewayStateService extends Service { static provide='gatewayState'; constructor(ctx, cfg){super(ctx,'gatewayState'); this.config=cfg.config; this.storage=cfg.storage; this.vllm=cfg.vllm} }` in `inference/src/plugins/gateway-state.ts`; update `createApp` to `await ctx.plugin(GatewayStateService, {config, storage, vllm})` after registry+compiler; validate registry and throw `Error('invalid adapter registry: ...')` listing codes if invalid.
- [ ] **Step 3: Run test** → PASS. Also assert invalid-registry path throws (add fixture with self-cycle).
- [ ] **Step 4: tsc + full inference suite** green.
- [ ] **Step 5: Commit** `feat(inference): injectable gateway state + registry validation on boot (#<A>)`.

*(PR A merges to staging after CI green.)*

---

### Task B1: user-resolver plugin

**Files:**
- Create: `inference/src/plugins/user-resolver.ts`
- Create: `inference/src/lib/user-resolver.ts` (pure)
- Create: `inference/tests/user-resolver.test.ts`

**Interfaces:**
- Consumes: `UserEntry[]`, `AdapterDefinition[]` from `gatewayState.config`; `parseRef` from `@saip/shared`.
- Produces:
  - pure `resolveAdapterForCaller(users, callerId|undefined): { userId:string, adapterRef:string }` — matches caller to `users[].id`; undefined/no-match → the `id:'default'` entry. Returns the `adapters.inference` ref.
  - `UserResolverService extends Service { static provide='userResolver'; resolve(callerId?:string):{userId,adapterRef}; }` reading config from injected `gatewayState`.

- [ ] **Step 1: Failing unit test** for pure fn: known caller→its inference adapter; unknown→default; no header→default. Run → FAIL.
- [ ] **Step 2: Implement** pure resolver + service (service injects `['gatewayState']`).
- [ ] **Step 3: Run** → PASS.
- [ ] **Step 4: Integration test**: boot app, `ctx.userResolver.resolve('alice')` returns alice's adapter; `resolve(undefined)` returns default. 
- [ ] **Step 5: tsc + suite** green; commit `feat(inference): user-resolver plugin (#<B>)`.

---

### Task B2: adapter-resolution to concrete version + /v1/models + /health

**Files:**
- Create: `inference/src/plugins/api-core.ts` (Hono app service providing `/v1/models`, `/health`)
- Create: `inference/src/lib/serve-resolver.ts` (pure)
- Create: `inference/tests/api-core.test.ts`

**Interfaces:**
- Consumes: `AdapterIndex`/manifests from `gatewayState.storage` (key `adapters/_index.json`), `AdapterRegistryService.resolveVersion`, `AdapterCompilerService.plan` (for composites).
- Produces:
  - pure `serveVersionFor(ref, index, isComposite, latestFor): string` → concrete `name@version`; for a composite, returns the compiled artifact id (the composite's own promoted version) — never component ids.
  - `ApiCoreService extends Service { static provide='apiCore'; readonly app = new Hono(); }` with `GET /health` → `{status:'ok', model:config.model.base}` and `GET /v1/models` → `{object:'list', data:[{id:<adapter name>, ...}]}` listing registry adapters.

- [ ] **Step 1: Failing test** api-core: `GET /health`→200 status ok; `GET /v1/models` lists `general`,`coding`,`default-agent`. Run → FAIL.
- [ ] **Step 2: Implement** ApiCoreService routes; register in createApp.
- [ ] **Step 3: Failing test** serve-resolver: leaf `coding@latest`→`coding@000018` given index; composite `default-agent@latest`→`default-agent@000003` (composite's own version), not any component. Run → FAIL.
- [ ] **Step 4: Implement** serve-resolver using index + compiler awareness; wire into a `resolveServeId(caller)` helper on apiCore or userResolver composition.
- [ ] **Step 5: Run all** → PASS; tsc; commit `feat(inference): models/health + adapter serve-resolution (#<B>)`.

*(PR B merges after CI.)*

---

### Task C1: chat-completions route over VllmBackend + streaming

**Files:**
- Create: `inference/src/plugins/api-chat.ts`
- Create: `inference/tests/api-chat.test.ts`

**Interfaces:**
- Consumes: `VllmBackend` (from gatewayState), `userResolver`, serve-resolver, `apiCore.app` OR a mounted sub-app. Request/response shapes verbatim from api-inference.mdx §POST /v1/chat/completions.
- Produces: `ApiChatService extends Service { static provide='apiChat'; app=new Hono() }` exposing `POST /v1/chat/completions`. Non-stream returns documented JSON with `model` = resolved concrete adapter id. Stream returns SSE `chat.completion.chunk` lines ending `data: [DONE]`. Emits Cordis event `chat/request` (payload caller, adapter, messages) consumed by session collector.

- [ ] **Step 1: Failing test** with a `FakeVllm` backend returning canned completion: POST non-stream → 200, `object==='chat.completion'`, `model` equals resolved `default-agent@...` (or general for default user), `usage.total_tokens` present. Run → FAIL.
- [ ] **Step 2: Implement** non-stream handler: parse auth→caller, resolve adapter serve id, call `vllm.chat({model:serveId,...})`, map to OpenAI envelope.
- [ ] **Step 3: Failing test** stream:true → response content-type `text/event-stream`, contains `data:` lines and terminal `[DONE]`. Run → FAIL.
- [ ] **Step 4: Implement** SSE passthrough from `vllm.stream` (fallback: wrap single chat response into one chunk + [DONE]).
- [ ] **Step 5: Review-Focus test** missing Authorization → resolves to default user (pinned behavior), still 200. Run → PASS.
- [ ] **Step 6: tsc + suite**; commit `feat(inference): OpenAI-compatible chat completions (#<C>)`.

---

### Task C2: SystemOne endpoint (gated) + session-collector

**Files:**
- Create: `inference/src/plugins/api-systemone.ts`
- Create: `inference/src/plugins/session-collector.ts`
- Create: `inference/tests/api-systemone.test.ts`, `inference/tests/session-collector.test.ts`

**Interfaces:**
- Consumes: `VllmBackend` (structured call), `gatewayState.config.inference.systemone.enabled`; session collector consumes `chat/request` events + writes to `StorageProvider` under `sessions/<id>/`.
- Produces:
  - `ApiSystemOneService` mounts `POST /v1/systemone/completions` ONLY when enabled; returns `{object:'systemone.completion', output, valid:true}`. When disabled, route absent (404).
  - `SessionCollectorService extends Service { static provide='sessionCollector' }` listens to `chat/request` (+ optional `chat/response`), assigns `sess_<n>`, persists conversation stub to storage `sessions/sess_<n>/conversation.jsonl` + `manifest.json`, emits `session/complete`.

- [ ] **Step 1: Failing test** systemone enabled: POST returns `valid:true`, `output` echoes FakeVllm structured result. Disabled-fixture boot: same POST → 404. Run → FAIL.
- [ ] **Step 2: Implement** gated route (register conditionally on config flag).
- [ ] **Step 3: Failing test** session-collector: emit `chat/request`, assert `MemoryStorage.list('sessions/')` gains an entry and manifest has caller+adapter. Run → FAIL.
- [ ] **Step 4: Implement** collector subscribing via `ctx.on('chat/request', ...)`.
- [ ] **Step 5: Review-Focus test** SystemOne disabled truly unregisters (not just errors). Run → PASS.
- [ ] **Step 6: tsc + suite**; commit `feat(inference): SystemOne endpoint + session collector (#<C>)`.

*(PR C merges after CI.)*

---

### Task D1: Data API — document processor registry + documents CRUD + dedup

**Files:**
- Create: `inference/src/lib/doc-processors.ts`
- Create: `inference/src/plugins/data-documents.ts`
- Create: `inference/tests/doc-processors.test.ts`, `inference/tests/data-documents.test.ts`

**Interfaces:**
- Consumes: `StorageProvider`, `sha256` via node crypto. Types `KnowledgeManifest` from `@saip/shared`.
- Produces:
  - `interface DocProcessor { name:string; accepts(sourceType, ext?):boolean; process(content:string, meta):{ intermediate:string; processedBy:string } }`
  - `markdownProcessor`, `codeProcessor`, `jsonlProcessor` (real, light); `pdfProcessor` stub that throws `UnsupportedProcessor` unless a Marker backend is injected (documented placeholder).
  - `processorFor(extOrType, registered[]):DocProcessor`
  - `DataDocumentsService extends Service { static provide='dataDocuments'; app=new Hono() }`: `POST /v1/data/documents` (validate UTF-8 + size, sha256 dedup vs stored hashes, run processor, write `knowledge/<id>/content.*` + `manifest.json`, update `knowledge/_index.json`, emit `document/uploaded`+`document/processed`+`data/stored`), `GET /v1/data/documents` (list w/ tag filter + pagination), `DELETE /v1/data/documents/:id`. Response bodies match api-inference.mdx §Data API exactly.

- [ ] **Step 1: Failing test** doc-processors: markdown strips frontmatter & keeps headings; jsonl parses lines & rejects malformed line; processorFor picks by ext. Run → FAIL.
- [ ] **Step 2: Implement** processors + selector; pdf stub throws typed error.
- [ ] **Step 3: Failing test** documents POST happy path → 201 with `processed_by:'markdown-processor'`, storage has manifest; GET lists it; DELETE removes. Run → FAIL.
- [ ] **Step 4: Implement** DataDocumentsService routes writing through StorageProvider; maintain `_index.json`.
- [ ] **Step 5: Review-Focus tests**: (a) duplicate content hash → response flags duplicate, storage count unchanged; (b) unsupported type → 4xx, nothing stored. Run → PASS.
- [ ] **Step 6: tsc + suite**; commit `feat(inference): Data API documents + processors (#<D>)`.

*(PR D merges after CI.)*

---

### Task E1: Data API — sessions + feedback endpoints

**Files:**
- Create: `inference/src/plugins/data-sessions.ts`
- Create: `inference/src/plugins/data-feedback.ts`
- Create: `inference/tests/data-sessions.test.ts`, `inference/tests/data-feedback.test.ts`

**Interfaces:**
- Consumes: `StorageProvider`, `SessionManifest`/`FeedbackRecord` from `@saip/shared`, saip.yaml `training.weighted_kto.reward_range` for reward bounds.
- Produces:
  - `DataSessionsService` (`provide='dataSessions'`): `POST /v1/data/sessions`, `GET /v1/data/sessions`, `GET /v1/data/sessions/:id` — persist conversation.jsonl + manifest under `sessions/`.
  - `DataFeedbackService` (`provide='dataFeedback'`): `POST /v1/data/feedback` (validate reward within `reward_range` else 422; store `feedback/<id>.json`, update index), `GET /v1/data/feedback` (filters session_id/min/max + pagination). Shapes per api-inference.mdx.

- [ ] **Step 1: Failing tests** sessions POST/GET round-trip; feedback POST valid→201, out-of-range reward→422, GET filters. Run → FAIL.
- [ ] **Step 2: Implement** both services.
- [ ] **Step 3: Run** → PASS; tsc; commit `feat(inference): Data API sessions + feedback (#<E>)`.

---

### Task E2: Compose full server, docs, changelog, final verification

**Files:**
- Modify: `inference/src/index.ts` (mount all Hono apps onto one server; add `@hono/node-server` serve when run directly)
- Modify: `inference/README.md` (mark implemented plugins; note in-memory storage/R2-pending + pdf/Marker pending)
- Modify: `docs/src/content/docs/reference/api-inference.mdx` (only if implementation revealed a contract correction; otherwise confirm parity)
- Modify: `CHANGELOG.md`
- Create: `inference/tests/server-e2e.test.ts`

**Interfaces:**
- Consumes: all services above.
- Produces: single `Hono` composed app merging apiCore+chat+systemone+data* routes; `startServer(port)` via @hono/node-server for direct run; health reflects readiness.

- [ ] **Step 1: Failing e2e test**: boot full app with FakeVllm+MemoryStorage seeded with fixtures; exercise `/health`, `/v1/models`, one chat completion (assert session collected), one document upload (assert knowledge stored), one feedback (assert stored + reward bound enforced). Assert cross-cutting: uploaded document appears in `GET /v1/data/documents`. Run → FAIL.
- [ ] **Step 2: Implement** composition root + `startServer`; guard direct-run boot.
- [ ] **Step 3: Run e2e** → PASS.
- [ ] **Step 4: Docs pass** — update inference README statuses + any contract deltas; ensure sidebar/docs accurate. Rebuild docs: `cd docs && pnpm build` → format validation + link check green.
- [ ] **Step 5: Changelog** entries for A–E under `[Unreleased]` Added (one per PR already added incrementally; verify none missing).
- [ ] **Step 6: Full monorepo gate**: `pnpm install` then `pnpm --filter @saip/inference build && pnpm --filter @saip/inference test` → 0 failures; run every other package's test once to confirm no regressions.
- [ ] **Step 7: Commit** `feat(inference): compose full gateway server + docs (#<E>)`.

*(PR E merges after CI.)*

---

### Final: Release candidate (maintainer-gated)

After all five PRs are on `staging` and CI green:
- [ ] Bump all six manifests `0.3.0 → 0.4.0` on staging, commit `0.4.0`.
- [ ] Open RC PR `staging → main` (`Release candidate: 0.4.0`), watch CI green.
- [ ] STOP — maintainer approves/merges/tags/publishes (agents never merge to main). Then sync `main → staging`.
