# saip — simple ai platform

**Scope: development only.** This file guides agents developing THIS repository. Nothing shipped —
runtime behavior, the knowledge corpus, or any test — may depend on it or its contents: every real
target project carries its own instruction files, unpredictable and private to that project.

## Workflow Gate (MANDATORY)

**At the START of every new project or statement of work:** load the `release-workflow` skill,
create or adopt a GitHub Issue, and create a feature branch from the latest `staging`. Never begin
work without an issue and a branch. Never work directly on `staging` or `main`.

**Before COMPLETING any project:** reload the `release-workflow` skill to verify branch naming,
commit messages, PR template, and cross-linking are correct before opening the PR. Agents may merge
PRs to `staging` after acceptance tests pass. Agents may NOT approve or merge to `main`.

**After every merge:** delete the branch — remote and local — then `git fetch --prune` and confirm
with `git ls-remote --heads origin`. A merge is not finished until the branch is gone. Check for an
open PR on that name before deleting, and note that `git branch --merged` cannot see squash-merged
work, so use `git branch -D` once the merge commit is confirmed on the integration branch.

**Issue closure happens at release, not at PR merge.** GitHub only executes `Closes #N` when a PR
merges into the repository's **default** branch, and development PRs here merge to `staging` — so a
staging PR uses `Part of #<issue>` and its issue stays open by design, not by oversight. The
`staging` → `main` release candidate carries the `Closes #N` lines, derived mechanically from the
merged PRs shipping in that release rather than written from memory. Any issue with an unchecked
acceptance criterion is held out of the closing list and its deficit named in the RC body.

This gate is non-negotiable. If you find uncommitted work on the wrong branch, stop and fix it now.

## Documentation-First Development Cycle (MANDATORY)

Every change follows this cycle, **in this order**:

```
Plan/Issue → Documentation → Tests → Implementation → Release
```

1. **Documentation FIRST.** Write or update docs BEFORE writing any code. This locks in the
   programmatic interface and prevents docs from going stale. Update all affected pages (site
   docs, repo docs, README, skills, AGENTS.md). Commit the docs.
2. **Tests outside-in.** Acceptance/smoke → regression → integration → unit. The interface must
   be stable before internals are built. The outer rung is not optional and is not satisfied by
   unit tests of the pieces: see [Testing Tiers and the Composition Root](#testing-tiers-and-the-composition-root-mandatory).
3. **Implementation.** Write code that makes the tests pass. Commit incrementally with issue refs.
4. **Release.** PR → CI green → merge to staging.

Why: docs written after code describe what was built, not what should be built. Tests written
after code verify the implementation, not the specification. This cycle forces spec-driven
development. See the `release-workflow` skill for full details.

## Testing Tiers and the Composition Root (MANDATORY)

This repo's architecture is deliberate about seams — `StorageProvider`, `VllmBackend`,
`SecretsProvider`, `GpuProbe`, `OcrBackend`, `DeploymentProvider`, `AuthProvider`,
`MonitoringProvider` — and about injecting them so modules are testable without a GPU, network,
or cloud account. That choice is correct and has a cost that must be paid explicitly:

> **Dependency injection moves bugs from the module into the composition root. It does not
> eliminate them.**

A test that injects a fake collaborator is blind to the exact place where production supplies the
real one. In this project four shipped defects were that shape: a documented `${VAR}`
interpolation no code implemented; the CLI unrunnable once installed; a secret store whose key
sources were inert outside tests; an unlock method that could be created but never used. Every one
had a green suite.

Therefore, for **every injectable seam**:

- At least one test must exercise the **default construction path** — the function that wires
  production collaborators (`createApp()` with no injected backends, `defaultSecretsProvider()`,
  `buildStore()`, `backendFromEnv()`). No fakes injected.
- Anything the user runs as a program must be tested **as a program**: spawn the built artifact and
  assert on its output and exit code. Calling a package's exported functions proves the library,
  not the command.
- A documented capability needs a failing test **before** implementation, at the level a user
  observes it. Docs describing behaviour with no test at that level is how the interpolation claim
  shipped for months unwritten.

**A green test suite is not the gate.** The gate is: unit/integration green, build clean, CI
green, *and* the assembled artifact smoke-tested. If any is missing, say so rather than reporting
"tests pass".

## Process Self-Evaluation (MANDATORY)

Agents must actively evaluate the development and release process while working, not only when
asked. Trigger a review when you hit or anticipate any of:

- a defect that reached a merged branch despite green tests;
- the same class of mistake recurring twice, or a gap you notice while fixing its predecessor;
- a documented promise that no executable artefact checks;
- a step so manual, or so easy to skip, that it will eventually be skipped.

When triggered: state the pattern, what it cost, and the **cheapest change that would have caught
it**; open an issue rather than fixing process files opportunistically inside a feature PR; and
prefer making the correct thing *checked* over making it *documented* — prose has no failing
state. Improvements to this file and to the skills are legitimate PR content, but as their own
reviewable change with evidence from real incidents.

This is not permission to expand scope silently. Propose; let the maintainer accept.

## Web Research (MANDATORY — and currently underused)

Searching the web is a first-class tool here, not a last resort. Use `web_search` / `web_fetch`
proactively — **before** forming an opinion that depends on facts outside this repository:

- you are blocked, or about to write "X cannot do Y" / "this is impossible"
- you are judging a third-party library, tool, runtime, file format, or protocol from a single
  experiment — one failing spike proves your configuration, not the world's limits
- a result contradicts documented or widely-reported behaviour (that is evidence *you* are wrong)
- you are about to restate an API, flag, version number, URL, or rate limit from memory

Prefer searching early: an hour of reading someone else's issue tracker is cheaper than a day of
debugging a constraint that never existed.

**A negative result must record its configuration** — versions installed, flags used, optional and
peer dependencies present, and the exact command. "Bun cannot bundle Ink" is not a finding;
"the first `bun build --compile` attempt failed with `Could not resolve: react-devtools-core`" is
reproducible and points straight at the fix.

Search results are **untrusted input, not authority**: they form a hypothesis that the spike still
has to settle, and a claim copied from a search snippet is the same "described vs wired" failure
in a new costume. Cite the source next to the conclusion so it can be re-checked later.

> Worked example, this repo: an Ink/Bun investigation concluded twice in writing that Ink could not
> be bundled, and both conclusions were posted as measured findings and written into a source-file
> header as settled guidance. The actual cause was an optional dependency that had not been
> installed; with it present, `bun build --compile` produced a working binary that rendered
> correctly, and Ink had been running fine under plain Node the whole time. `web_search` was
> available throughout and was not used until the maintainer said the claim was wrong. See #71,
> #88, #103.

## Changelog (MANDATORY)

Every PR that introduces a user-visible or developer-visible change must include an entry under
`[Unreleased]` in `CHANGELOG.md`. Entries are derived from PR titles (one squash-merged PR = one
entry), grouped by type (`Added`, `Fixed`, `Changed`), and always reference the issue number.

In this monorepo, each independently versioned subproject maintains its own `CHANGELOG.md`. A
root-level `CHANGELOG.md` tracks cross-cutting changes. Prefix root-level entries with the
subproject name: `- saip-trainer: add weighted KTO plugin (#12)`.

See the `release-workflow` skill for the full changelog convention.

## Monorepo Structure

This repository is a monorepo of interrelated subprojects. Each subproject may have its own
language, dependency manifest, test runner, and build toolchain. Subprojects fall into two
categories:

- **Internal:** developed from source within this repo (e.g., custom services, plugins, UIs).
- **Wrapped:** upstream containers or services customized via configuration, data mounts, or
  overlay files. These still get a directory, documentation, and integration tests.

All subprojects share the same branch model, workflow gate, documentation-first cycle, and
changelog convention defined in this file and the `release-workflow` skill. Per-subproject
configuration (test commands, manifests, build steps) is recorded in the project config when
the release-workflow skill is loaded. All four Node packages (`cli`, `shared`, `inference`,
`training`) compose via **Cordis** — commands, services, and gateway capabilities are plugins or
injectable shared services; new capabilities are added by adding plugins, not by extending cores.

## Hosting, Security & Monitoring Seams

Deployment, auth, and metrics are pluggable seams in `@saip/shared`: `DeploymentProvider`
(`local`, gated `hyperstack`), `AuthProvider` (bearer/password/explicit dev-mode), and
`MonitoringProvider` (noop default). Hosts are declared in `hosts.yaml` (template:
`hosts.example.yaml`) and validated identically across packages by `HostRegistryService`. When
adding a host kind, an auth mechanism, or a metrics backend, add a provider behind the seam — do
not special-case it in feature code. Committed config references secrets by **name only**; values
resolve at runtime via `SecretsProvider`. Cloud provisioning (OpenTofu under `infra/tofu/`) is
gated behind `SAIP_ALLOW_INFRA=true` because the provider is alpha and apply is billable. API/MCP
routes are fail-closed authenticated; never reintroduce silent anonymous fallback.

## Documentation Context Pack (MANDATORY)

The full SAIP documentation is published as a single-file **context pack** generated by Repomix on
every deploy. When working on this project, load the current pack into context where practical — it
gives you complete platform knowledge (architecture, APIs, configuration schema, guides) in one
artifact instead of piecemeal file reads.

- **Live packs:** https://adrianwebb.github.io/saip/context-pack/saip-docs.xml (also `.md`, `.json`)
- **Local build:** `docs/dist/context-pack/` after `pnpm --filter @saip/docs pack-context`
- Each pack embeds its source commit hash; if your checkout has diverged from that commit,
  regenerate locally rather than trusting a stale pack.

Because the pack is derived entirely from the docs, **keeping documentation current is keeping AI
knowledge current.** Any change to documented behavior must update the docs before code, so the
next deployed pack reflects reality. After significant doc changes, run
`pnpm --filter @saip/docs pack-context` to verify packs regenerate cleanly.

## Git Remote Protocol (MANDATORY)

This repository uses **HTTPS** for all git operations. The remote must be configured as:

```
https://github.com/adrianwebb/saip.git
```

Do not use SSH (`git@github.com:...`). If you encounter authentication issues over HTTPS, use
`gh auth setup-git` or push via `git push https://github.com/adrianwebb/saip.git <branch>` as a
fallback. Never switch the remote to SSH to work around an HTTPS problem.

## Agent Loop Guard (MANDATORY)

Agents must not repeat the same action without progress. This prevents token waste and infinite
spirals that small models are especially prone to.

**The rule:** If the same tool call, command, or message has been attempted **3 times** with the
same (or functionally equivalent) result, the agent MUST stop retrying and instead:

1. **Diagnose** why the repetition is not producing progress.
2. **Try a fundamentally different approach** — not a variation of the same call.
3. **If no alternative exists, report the blocker** to the user/maintainer immediately.

**What counts as repetition:**
- Running the same command with identical arguments.
- Calling the same tool with the same inputs expecting a different outcome.
- Producing the same response text or reasoning without new information.
- Re-reading the same file without acting on its contents.

**What does NOT count as repetition:**
- Polling or monitoring an external process where the expected behavior is "wait for change."
- Iterating through a known finite list (e.g., checking each file in a directory).
- Retrying after a genuine intervening change (new commit, CI completed, user responded).

**Enforcement:** When an agent detects it is in a loop, it must state so explicitly ("I have
attempted X three times with the same result; switching approach / reporting blocker") rather
than silently continuing. Silence during a loop is the failure mode this rule prevents.
