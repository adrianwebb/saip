---
name: release-workflow
description: Use when working on any code change in a Git/GitHub project — creating branches, opening or merging PRs, tagging releases, creating or updating issues, posting progress comments, or when asked to follow "the workflow" / AGENTS.md gates. Project-agnostic: branch model, documentation-first cycle, CI gates, commit conventions, issue/PR templates, cross-linking, and agent-vs-maintainer permissions.
whenToUse: At the START of every new project or statement of work, and again BEFORE completing one. Also whenever branching, issuing, PR-ing, merging, releasing, or hotfixing.
---

# Release Workflow (General Purpose)

The mandatory Git/GitHub development and release workflow for any software project. Non-negotiable unless explicitly overridden by the project maintainer.

**Project-specific values are placeholders.** Wherever this skill shows `<...>` or says *configure*, read the project's own configuration first (see [Per-Project Configuration](#per-project-configuration)) and substitute it. Never invent commands the project does not have.

## ⚠️ MANDATORY: Starting Any New Work

**Before writing a single line of code or making any change, you MUST:**

1. **Load this skill** at the start of every new project or statement of work.
2. **Create or adopt an Issue** describing the work. Every piece of work — feature, fix, refactor, docs — requires an issue. If none exists, create one NOW from the templates below.
3. **Create a feature branch from the latest integration branch.** Never work directly on `main` or `staging`.
   ```bash
   git checkout staging && git pull origin staging
   git checkout -b feature/<issue-number>-short-description
   ```
4. **Commit incrementally.** After each logical segment of work (a fix, a sub-feature, a test suite), commit and push to the feature branch. Do not accumulate uncommitted changes across sessions.
5. **Open a PR when complete**, targeting `staging`, with `Closes #<issue>` in the body. Wait for CI green before merging.
6. **Reload this skill before completion.** Re-read it before opening the PR to verify branch naming, commit messages, PR template, and cross-linking are correct.

**Agents may merge PRs to `staging` after all acceptance tests pass. Agents may NOT approve or merge PRs to `main`.** Only the project maintainer approves releases to production. This permission boundary is part of the workflow and is never relaxed by convenience, deadline, or green CI.

**What "may merge to staging" requires.** Merging your own PR to `staging` needs all four: green CI, every acceptance criterion checked against reality, the PR's testing boxes checked from an actual CI run, and review addressed. An agent cannot supply a human approval, so where the project requires a reviewer other than the author, the agent opens the PR and stops; where the project gates only on the four conditions above, the agent merges. If you cannot tell which the project wants, open the PR and ask the maintainer — never assume the merge is yours to take. You may NEVER approve a PR at all, on any branch.

If you find uncommitted work on `staging` or `main`, stop: create the issue and branch NOW, then move the changes onto the proper branch.

## ⚠️ MANDATORY: Documentation-First Development Cycle

**Every change follows this cycle, in this order. No exceptions.**

```
Plan/Issue → Documentation → Tests → Implementation → Release
```

### 1. Plan / Issue
Create or adopt an Issue. Define what changes, why, and the acceptance criteria.

### 2. Documentation FIRST
**Write or update the documentation BEFORE writing any code.** This locks in the programmatic interface, forces clarity on what is changing, and prevents docs from going stale. Update every affected surface — user docs, API/reference docs, repo docs, README, skills, and agent instruction files (`AGENTS.md` / `CLAUDE.md`) as applicable. If the change adds functionality, write the docs that describe it; if it changes behavior, update the docs that describe that behavior. Commit the docs.

### 3. Tests (outside-in)
Write tests in this order, committing after each layer:
1. **Acceptance / smoke tests** — user-facing behavior, end-to-end flows, CLI commands
2. **Regression tests** — pin the specific bug or edge case being fixed
3. **Integration tests** — component boundaries, service interactions, host wiring
4. **Unit tests** — pure logic, isolated functions, data transformations

Outside-in testing ensures the interface is stable before internals are built. A test you cannot write because the interface does not exist yet means step 2 is incomplete.

### 4. Implementation
Write the code that makes the tests pass. Commit incrementally — each logical unit gets its own commit referencing the issue number.

### 5. Release
Open PR, wait for CI green, merge to `staging`. For production, follow the Release Candidate workflow.

**Why this order:** documentation written after code describes what *was* built, not what *should* be — it captures implementation detail instead of intent and is perpetually behind. Tests written after code verify the implementation, not the specification. The docs ARE the spec, the tests validate the spec, the code satisfies the tests.

## Branch Model

| Branch | Purpose | Protection |
|--------|---------|------------|
| `main` | Production. Tags and releases are cut ONLY from main. | Merge only via PR from `staging` with green CI. |
| `staging` | Integration branch. All feature work lands here first. | Never behind `main` except during a hotfix window. |
| `feature/*`, `fix/*` | Feature or bugfix branches, created FROM `staging`. | Merged back to `staging` via PR. |
| `hotfix/*` | Emergency fixes, created FROM `main`. | Bypasses `staging` when speed is critical. |

Some projects name these differently (`master`/`develop`, `release/*`). Map the roles, not the names, and record the mapping in the project config.

**Which prefix for a bug?** Use `fix/<issue>-desc` for a bug fix and `feature/<issue>-desc` for new capability. Both follow the identical workflow — branch off `staging`, PR to `staging`, squash-merge; only the word in the name differs. Choose it from the issue type and never mix them for the same work.

## The Golden Rules

1. **All merges to `main` go through `staging`.** No direct commits, no feature-branch merges to `main`.
2. **Tags and releases are cut from `main` only.** Never tag `staging` or a feature branch.
3. **All CI must be green before merging to `main`.** If the project publishes on tag-push, don't tag red CI.
4. **`staging` is never behind `main`** except during a hotfix window. After a hotfix merges to `main`, the next release candidate PR must merge `main` back into `staging` to catch up.
5. **Every feature/fix branch tracks an Issue.** Adopt or create one before starting work; reference it in the branch name, commits, and PR.
6. **Merge `staging` INTO your feature branch before merging TO `staging`.** Resolve conflicts on the feature branch, never on `staging`.

## Per-Project Configuration

Read these once per project — from its manifest, CI workflows, and existing tags — and use them everywhere `<...>` appears. Ask the maintainer only when the project genuinely has no answer.

| Setting | Where to find it | Example |
|---------|------------------|---------|
| Version format (prefix? prerelease scheme?) | `git tag -l \| tail -5`, manifest file | `v1.4.2` / `1.4.2` |
| Manifest holding the version field | `package.json`, `pyproject.toml`, `Cargo.toml`, `*.csproj`, `pom.xml`, `gradle.properties` | `package.json` |
| Test command | CI workflow, `Makefile`, README | `npm test` / `pytest` / `make test` |
| Static-check / typecheck command | CI workflow | `npm run typecheck` / `mypy` / `cargo clippy` |
| Build command | CI workflow | `npm run build` / `go build ./...` |
| Release trigger | CI workflow `on:` block | tag push on `main` |
| Docs locations | repo tree | `docs/`, `README.md`, site content dir |
| Changelog file + how it is generated | repo root, release tooling | `CHANGELOG.md` (hand-written) / auto from PR list |
| Merge style for feature PRs | branch protection settings, maintainer | squash (changelog from PR titles) |
| Required labels / issue templates | `.github/ISSUE_TEMPLATE`, `gh label list` | `bug`, `enhancement` |
| Integration + production branch names | `git branch -r` | `staging` + `main` |

**No GitHub / no `gh`?** The flow is identical; only the tool layer changes. Substitute per forge:

| Intent | GitHub (`gh`) | GitLab (`glab`) | Gitea (`tea`) | Fallback |
|--------|---------------|-----------------|---------------|----------|
| Create issue | `gh issue create` | `glab issue create` | `tea issues create` | web UI / `git push -o` options |
| Comment on issue | `gh issue comment N` | `glab issue note N` | `tea issues comment N` | web UI |
| Open PR/MR | `gh pr create --base B` | `glab mr create --target-branch B` | `tea pulls create --base B` | web UI |
| Watch CI | `gh pr checks N --watch` | `glab ci status --branch <mr-source>` (repeat until green/red) | `tea pulls checks N` | forge CI page |
| Merge (squash) | `gh pr merge N --squash` | `glab mr merge N --squash` | `tea pulls merge --squash N` | web UI |
| Merge (no squash) | `gh pr merge N --merge` | `glab mr merge N` | `tea pulls merge N` | web UI |

`N` is the issue/PR/MR number. On GitLab, confirm the auto-close keyword actually fires for your project (`Closes #<issue>` closes same-project issues only); if it does not, link the issue manually rather than assuming closure.

Where no CLI exists, do the same actions in the forge's web UI and keep every discipline rule intact. **The permission boundary does not change with the forge:** agents still may merge to `staging` under the four conditions above and may never approve or merge to `main`. If your work predates any issue tracker at all, create one before starting — the workflow requires an issue, not specifically a GitHub issue.

## Version & Tag Format

Follow strict semantic versioning in **whatever prefix convention the project's existing tags already use** — do not introduce or remove a `v` prefix mid-stream.

```
Stable:       <major>.<minor>.<patch>            e.g. v1.4.2 or 1.4.2
Prerelease:   <major>.<minor>.<patch>-<pre>.<N>  e.g. v2.0.0-dev.3
```

**Rules:**
- All three components required; never `1.0` or `1`.
- Prerelease suffix format follows the project's established scheme (`-dev.N`, `-rc.N`, `-beta.N`).
- The version in the manifest matches the tag exactly.
- **If `<manifest>` and the newest tag disagree** (e.g. manifest says `0.8.0`, latest tag is `v0.7.3`), do not pick one yourself. Ask the maintainer which is authoritative, then record the answer in the project config so it never recurs.
- Bump rules: breaking change → major, new feature → minor, fix/chore/docs → patch.
- **Never reuse a tag.** If one was pushed wrong, delete it before creating the correct one:
  ```bash
  git tag -d <tag> && git push origin :refs/tags/<tag>
  ```
- Verify format BEFORE pushing: `git tag -l | tail -5`.

## Issue Guidelines

Every piece of work starts with an issue. **All issue types require acceptance criteria** — even refactors and chores. Acceptance criteria are living checkboxes that MUST be updated as work progresses.

**Bug Report:**
```bash
gh issue create --title "fix: <short description>" --label "bug" --body '
## Problem
<What is broken? Expected vs actual behavior?>

## Reproduction
<Steps to reproduce, or "N/A" if found by code inspection>

## Environment
- Version: <app version>
- Runtime: <language/runtime version>
- OS: <os>

## Impact
<Who/what is affected? How severe?>

## Acceptance Criteria
- [ ] Bug no longer reproduces under the original conditions
- [ ] Regression test added that pins the specific failure
- [ ] Existing tests still pass
'
```

**Feature/Enhancement:**
```bash
gh issue create --title "feat: <short description>" --label "enhancement" --body '
## Goal
<What should this achieve? Why does it matter?>

## Proposed Approach
<High-level design, if known. "TBD" is fine.>

## Acceptance Criteria
- [ ] <functional requirement 1>
- [ ] <functional requirement 2>
- [ ] Documented in user/repo docs and README as applicable
- [ ] Unit tests covering the new behavior
- [ ] Integration or e2e test verifying end-to-end flow (if user-facing)

## Related
<Link to related issues, PRs, discussions, external references>
'
```

**Refactor/Chore:**
```bash
gh issue create --title "refactor: <short description>" --label "refactor" --body '
## Motivation
<Why restructure? What pain does this address?>

## Scope
<What changes? What stays the same?>

## Risk
<What could break? How do we verify safety?>

## Acceptance Criteria
- [ ] Refactoring complete — no behavioral change
- [ ] All existing tests pass without modification
- [ ] Typecheck / static analysis clean
- [ ] Documentation updated if public API surface changed
'
```

### ⚠️ MANDATORY: Acceptance Criteria Are Living Checkboxes

They are NOT write-once. They are the progress tracker:

1. **At creation:** all criteria unchecked `- [ ]`
2. **During work:** edit the issue body to check items off `- [x]` as they are met
3. **Before opening the PR:** ALL criteria checked. If one cannot be met, comment explaining why and revise the criterion.
4. **At review:** the reviewer verifies each checked criterion is actually satisfied.

Use `gh issue edit <number> --body '...'` or the web UI. A PR closing an issue with unchecked acceptance criteria is incomplete.

### Issue Hygiene

- **Title format:** `<type>: <imperative description>` — mirrors commit convention (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)
- **Labels:** apply at creation, using the labels the project actually defines. At minimum one of `bug` / `enhancement` / `refactor` / `docs` / `chore`; add priority labels for urgent work.
- **Related links:** always link related issues, PRs, or external references with `#<number>` or full URLs.
- **Close keywords:** PR bodies use `Closes #<issue>` / `Fixes #<issue>` to auto-close on merge.
- **Update, don't duplicate:** if an issue evolves, edit or comment. Don't open a second issue for the same concern.

## Pull Request Guidelines

**Feature/Fix PR (targeting `staging`):**
```bash
gh pr create --base staging \
  --title "feat: <description> (#<issue>)" \
  --body '
## Summary
<One paragraph: what changed and why>

## Changes
- <bullet list of concrete changes>

## Acceptance Criteria (from #<issue>)
<!-- Copy from the issue; check each as verified -->
- [ ] <criterion 1>
- [ ] <criterion 2>

## Testing
<!-- Fill AFTER CI runs, not at creation -->
- [ ] CI green (<typecheck> + <build> + <tests>)
- [ ] Manual verification: <describe, if user-facing>
- [ ] New tests added for new behavior
- [ ] Existing tests pass unmodified (for refactors)

## Related
Closes #<issue>
<Links to related PRs, issues, docs, external references>
'
```

**Release Candidate PR (`staging` → `main`):**
```bash
gh pr create --base main --head staging \
  --title "Release candidate: <version>" \
  --body '
## Release <version>

### Changes since <previous version>
- <bullet list from merged PRs/issues since last tag>

### Verification
- [ ] All CI checks green
- [ ] Deterministic suite passes (<test command>)
- [ ] Static analysis clean (<typecheck command>)
- [ ] Version bumped in <manifest> (committed on staging, part of this diff)
- [ ] Changelog updated for this version (if the project keeps one)
- [ ] <main-back-merge-into-staging done, if a hotfix landed since the last release>

### Tag after merge
`<version>`
'
```

**Hotfix PR (targeting `main`):**
```bash
gh pr create --base main \
  --title "HOTFIX: <description> (#<issue>)" \
  --body '
## ⚠️ Emergency Hotfix

Bypassing staging due to urgency.

## Problem
<What is broken in production?>

## Fix
<What changed and why it is safe>

## Testing
- [ ] Deterministic suite passes (`<test command>`)
- [ ] Static analysis clean (`<typecheck command>`)
- [ ] Manual verification: <describe>

## Related
Closes #<issue>

## Post-merge
- [ ] Merge main back into staging
'
```

### PR Hygiene

- **Title format:** `<type>: <description> (#<issue>)` — issue number in parentheses
- **Base branch:** features/fixes target `staging`; hotfixes and release candidates target `main`.
- **Body must include:** summary, testing checklist, `Closes #<issue>`
- **Link everything:** related issues (`#<number>`), prior PRs, docs, external resources
- **Keep PRs small:** touching >10 files or >15 min of CI → split into stacked PRs
- **Self-review before requesting review:** read your own diff; catch typos, leftover debug code, missing tests.

## Commenting Conventions

### On Issues

- **Progress updates (MANDATORY):** when completing a logical segment of work, post a comment updating acceptance-criteria state:

  ```
  ## Progress Update

  Completed:
  - [x] <criterion just met>
  - [x] <another completed criterion>

  Remaining:
  - [ ] <what is left>

  <Brief note on what was done, decisions made, or blockers encountered>
  ```

  Also **edit the issue body** to check off completed criteria there. The comment provides context; the issue body is the source of truth.

- **Work started:** comment when beginning: "Starting implementation on `feature/N-desc`."
- **Blocked:** comment immediately; name the blocker and what is needed to unblock.
- **Scope change:** comment explaining what changed and why BEFORE modifying acceptance criteria.
- **Decisions:** record architectural/scope decisions as comments so future readers get the "why."
- **Cross-references:** "Addressed in #<pr>", "See also #<issue>".
- **Closing:** let the PR auto-close via `Closes #<issue>`. Close manually only for invalid / won't-fix issues, with explanation.

### On PRs

- **Testing verification (MANDATORY):** after CI completes, **edit the PR body** to check off testing boxes based on actual CI results. Never leave them unchecked from creation, and never check them without having seen the run.
- **CI failures:** comment with diagnosis and fix plan. Don't leave red CI unexplained. After fixing, update the checkboxes.
- **Review comments:** be specific; reference lines; suggest fixes, not just problems.
- **Author responses:** reply to every review comment; resolve threads when addressed; explain disagreements.
- **Post-merge:** no "merged" comment needed — GitHub shows it. Comment only about follow-up work.

### General

- Be concise; one thought per comment; bullets for lists.
- Use markdown: code blocks for snippets, links for references, checkboxes for action items.
- @mention sparingly — only when someone must see it, never for FYI.
- Never edit others' comments. Reply instead.

## Cross-Linking Requirements

Traceability. These are REQUIRED, not optional:

| From | To | How | Required? |
|------|----|-----|-----------|
| PR | Issue | `Closes #<N>` / `Fixes #<N>` in PR body | **Yes** |
| Feature branch | Issue | Issue number in branch name: `feature/42-desc` | **Yes** |
| Commit | Issue | `(#<N>)` in commit message | **Yes** |
| Issue | Related issue/PR | `#<N>` or full URL in body/comment | **Yes** |
| RC PR | Previous tag | `Changes since <version>` in RC body | **Yes** |
| Hotfix PR | Staging sync | Checklist item in hotfix PR body | **Yes** |
| Comment | Code/file | Permalink or `file:line` reference | Encouraged |
| Comment | External resource | Full URL with description | Encouraged |

## Feature/Fix Workflow

```
1. Create or adopt an Issue (acceptance criteria as unchecked checkboxes)
   gh issue create --title "feat: ..." --label "enhancement" --body '...'
   # or: gh issue list --state open

2. Branch from staging
   git checkout staging && git pull origin staging
   git checkout -b feature/<issue-number>-short-description

3. Docs first, then tests outside-in, then implementation — commit each layer,
   update issue checkboxes after each segment
   git add ... && git commit -m "feat: description (#<issue>)"
   git push origin feature/<issue-number>-short-description
   # Edit issue body: check off completed criteria; post a progress comment

4. Before opening PR: sync staging in, verify ALL acceptance criteria checked
   git fetch origin staging && git merge origin/staging
   # resolve conflicts on the feature branch, then push

5. Open PR targeting staging (copy acceptance criteria into the PR body)
   gh pr create --base staging --title "feat: description (#<issue>)" --body "..."

6. After CI completes: edit PR body to check off testing boxes from real results
   gh pr edit <number> --body '...'

7. Address review, then merge to staging (or stop for the maintainer if a non-author approval is required)
   gh pr merge <number> --squash   # only after: green CI + all boxes checked from real results + review addressed
```

### Pre-PR Verification Checklist

Run this every time, immediately before opening the PR (this is the artifact the "reload this skill before completion" step asks for). Every line must be true against something you actually observed this session — not intended, not assumed.

- [ ] On a `feature/*` or `fix/*` branch off `staging`, never on `main`/`staging` directly
- [ ] Issue exists and is linked; branch name carries its number
- [ ] Documentation updated **and committed** before code (diff shows the doc files changed)
- [ ] Tests written outside-in and committed per layer; `<test command>` run now → 0 failures
- [ ] `<typecheck command>` and `<build command>` run now → clean / exit 0
- [ ] All acceptance criteria checked in the **issue body**, plus a progress comment posted
- [ ] `origin/staging` merged into this branch; conflicts resolved here, pushed
- [ ] Cross-links present: `(#<issue>)` in commits, `Closes #<issue>` ready in PR body
- [ ] PR small (< ~10 files, < ~15 min CI) or split into stacked PRs
- [ ] Self-reviewed own diff: no debug leftovers, no stray files
- [ ] Changelog entry added, if the project keeps one

## Release Candidate Workflow (`staging` → `main`)

When `staging` is ready for release. **Agent role ends at "RC PR opened": an agent may do steps 1–4 and watch CI in step 5, but never merges or tags — steps 6–8 are maintainer actions.**

```
1. Determine the next version
   # current: grep the version field in <manifest>; git tag -l | tail -5
   # bump: patch for fixes, minor for features, major for breaking changes
   # If <manifest> and the newest tag disagree, do NOT guess — ask the maintainer which is authoritative.

2. If a hotfix landed since the last release, merge main into staging first
   git checkout staging && git pull origin staging
   git merge origin/main && git push origin staging

3. Bump the version in <manifest> on staging, and update the changelog if the project keeps one.
   Commit on staging (or a short-lived release/<version> branch merged to staging), then push.
   # The bump belongs to the RC so that "Version bumped in <manifest>" is verifiable BEFORE merge.
   git add <manifest> CHANGELOG.md && git commit -m "<version>"

4. Open the release candidate PR from staging to main (RC template above)
   gh pr create --base main --head staging --title "Release candidate: <version>" --body "..."

5. ALL CI must pass on this PR. No exceptions for normal releases.
   gh pr checks <number> --watch

6. [MAINTAINER] Approve and merge to main
   gh pr merge <number> --merge   # merge commit, not squash, for RCs

7. [MAINTAINER] Tag and push — this triggers the release pipeline
   # VERIFY FORMAT against the project's convention (prefix included)
   # The tag MUST equal the version already committed in <manifest> on main.
   git tag -a <version> -m "<version> — summary"
   git push origin main --tags

8. [MAINTAINER] Verify the release succeeded
   gh run list --limit 1 ; gh release view <version>
```

**One open release at a time.** Only one RC may be pending (`staging` → `main`) at any moment. Work that lands on `staging` after an RC is opened joins the *next* release unless the maintainer updates the existing RC to include it — never open a second RC over the same window, and never decide silently which release your change ships in. If an RC is already open when you finish, ask the maintainer whether to fold your change into it or hold it for the next one.

## Hotfix Workflow (Emergency Only)

For production-breaking fixes where waiting on the full staging cycle causes unacceptable delay. Everything else goes through `staging`.

**Is this a hotfix?** Only if production is broken *now* and the fix cannot wait for the next scheduled release. A crash, data loss, security hole, or outage qualifies; a bug that only affects unreleased code does not — that is a normal `feature/*` or `fix/*` branch off `staging`. **The maintainer declares hotfix status.** If you are an agent and no one has declared it, default to the staging path and ask; do not self-authorize bypassing `staging`.

```
1. Branch from main
   git checkout main && git pull origin main
   git checkout -b hotfix/<issue-number>-short-description

2. Fix, commit, push
   git commit -m "fix: urgent description (#<issue>)"
   git push origin hotfix/<issue-number>-short-description

3. Open PR targeting main (NOT staging; hotfix template above)
   gh pr create --base main --title "HOTFIX: description (#<issue>)" --body "..."

4. Run ONLY the deterministic fast gate, not the full suite
   # CI runs it automatically on PRs to main. Locally: <test command> && <typecheck command>

5. [MAINTAINER] Merge to main after fast-gate green + approval
   gh pr merge <number> --merge

6. [MAINTAINER] Bump version + tag as in RC steps 3 and 7–8 (project tag format).
   # The hotfix patch bump goes on main here, then main is merged back to staging (step 7).

7. Sync staging IMMEDIATELY after the hotfix is on main
   git checkout staging && git pull origin staging
   git merge origin/main && git push origin staging
   # Otherwise the next RC silently reverts the fix.
```

## Large Changes: Avoiding CI Bottlenecks

When a change is too large for one PR (huge refactor, major feature):

1. **Decompose into stacked PRs.** Each is independently mergeable to `staging` and passes CI alone; later PRs build on earlier ones.
   ```
   PR 1: refactor(core): extract module X (no behavior change)
   PR 2: refactor(core): update callers of X        (depends on PR 1)
   PR 3: feat: new capability using refactored X    (depends on PR 2)
   ```
2. **Each PR targets `staging`.** Merge sequentially as each goes green.
3. **Reference the parent issue in all PRs** (task lists or links in the body).
4. **Never hold a long-lived branch that diverges from `staging`.** Merge `staging` in at least daily for multi-day work.
5. **If one PR would take >15 minutes of CI, split it.** Rapid feedback beats batching.

## Staging Hygiene

- **`staging` must always be deployable.** If it breaks, fixing it is the top priority.
- **After every hotfix to `main`, merge `main` into `staging` immediately.** Don't let it drift.
- **Pull `staging` before starting any feature work.** `git checkout staging && git pull origin staging` is step zero.
- **Never force-push to `staging` or `main`.** History rewriting needs the maintainer first.

## Commit Message Conventions

Conventional commits, for automated changelog extraction:

```
feat: add pluggable provider registry (#42)
fix: correct search scoring when symbols absent (#38)
refactor: extract resolver into its own module (#45)
test: add unit tests for scoring boost (#42)
docs: update README with provider setup notes (#42)
chore: bump build toolchain dependency (#46)
1.4.2   ← version-bump commit (matches the project's tag format)
```

The type prefix (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`) drives release-notes grouping. Always reference the issue number in parentheses. Keep the subject imperative and ≤ ~72 chars; put detail in the body.

**Squash-merge vs. per-layer commits — how both survive.** Feature branches keep incremental conventional commits (docs, test, fix) for reviewability *during* development. On squash-merge to `staging`, those collapse into one commit, so the changelog is written from **the PR title and merged PR list, not from individual branch commits** — which is why the PR title must itself be a valid conventional-commit subject (`fix: ... (#91)`). If a project extracts its changelog from raw `git log` on `main` instead of the PR list, use a merge commit rather than squash for that PR and confirm with the maintainer before choosing. Never let the two mechanisms disagree silently: pick one, record it in the project config.

## Evidence Before Claims

This workflow's gates are claims until verified. Apply `verification-before-completion` at every one of them:

| About to say | Requires (run it, read the output) | Not sufficient |
|---|---|---|
| "Tests pass" | `<test command>` output showing 0 failures, this session | Last run, "should pass" |
| "CI green" | `gh pr checks <N>` showing all pass | Assuming the push fixed it |
| "Docs updated" | Diff showing the doc file changed | Intent to do it later |
| "Acceptance criteria met" | Each checkbox re-checked against reality | Copying them over from the issue |
| "Ready to merge" | Green CI **+** all boxes checked **+** review addressed | Green CI alone |
| "Release published" | `gh release view <version>` / pipeline run succeeded | Tag pushed |

Checking a PR's testing box before reading the CI result is a false claim, not a shortcut.

## Red Flags — STOP

These mean you have left the workflow; fix it before continuing:

- Writing code with no issue, or on `staging`/`main`
- Code committed before its docs or tests
- Uncommitted work carried across a session
- About to merge while CI is red, or with unchecked acceptance criteria
- About to check a testing box you have not verified against a real run
- Approving or merging a PR to `main` as an agent
- Tagging anything other than `main`, or reusing an existing tag
- Long-lived branch that has not synced `staging` recently
- Hotfix that skipped the `main` → `staging` sync

## Quick Reference

| Action | Command |
|--------|---------|
| Start a feature | `git checkout staging && git pull && git checkout -b feature/N-desc` |
| Sync staging into feature | `git fetch origin staging && git merge origin/staging` |
| Open PR to staging | `gh pr create --base staging --title "..." --body "Closes #N"` |
| Check CI status | `gh pr checks <N> --watch` |
| View failed CI logs | `gh run view <id> --log-failed` |
| Merge PR (squash) | `gh pr merge <N> --squash` |
| Open release candidate | `gh pr create --base main --head staging --title "RC: <version>"` |
| Merge RC to main | `gh pr merge <N> --merge` *(maintainer)* |
| Tag a release | `git tag -a <version> -m "msg" && git push origin main --tags` *(maintainer)* |
| Delete a bad tag | `git tag -d <version> && git push origin :refs/tags/<version>` |
| Emergency hotfix | branch from main → PR to main → fast gate → merge → tag → sync staging |
| List open issues | `gh issue list --state open` |
| Create an issue | `gh issue create --title "..." --body "..." --label "..."` |
| Comment on issue/PR | `gh issue comment <N> --body "..."` / `gh pr comment <N> --body "..."` |
| Update issue body | `gh issue edit <N> --body "..."` |
| Update PR body | `gh pr edit <N> --body "..."` |
