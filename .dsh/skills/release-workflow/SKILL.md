---
name: release-workflow
description: "Use when working on any code change in a Git/GitHub project - creating branches, opening or merging PRs, tagging releases, creating or updating issues, posting progress comments, or when asked to follow the workflow or AGENTS.md gates. Project-agnostic coverage of branch model, documentation-first cycle, CI gates, commit conventions, issue/PR templates, cross-linking, and agent-vs-maintainer permissions."
whenToUse: "At the START of every new project or statement of work, and again BEFORE completing one. Also whenever branching, issuing, PR-ing, merging, releasing, or hotfixing."
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
5. **Open a PR when complete**, targeting `staging`, with `Part of #<issue>` in the body — **not** `Closes #<issue>`. Closing happens at release; see [Closing Issues at Release](#-mandatory-closing-issues-at-release). Wait for CI green before merging.
6. **Delete the branch immediately after the merge** — remote and local, then prune stale remote-tracking refs. A merged branch is dead weight: it cannot receive more work, it clutters every future `git branch -a`, and left-over branches accumulate into a state nobody dares delete. See [Post-Merge Branch Cleanup](#-mandatory-post-merge-branch-cleanup).
7. **Reload this skill before completion.** Re-read it before opening the PR to verify branch naming, commit messages, PR template, cross-linking, and that every branch you merged has been deleted, are correct.

**Agents may merge PRs to `staging` after all acceptance tests pass. Agents may NOT approve or merge PRs to `main`.** Only the project maintainer approves releases to production. This permission boundary is part of the workflow and is never relaxed by convenience, deadline, or green CI.

**What "may merge to staging" requires.** Merging your own PR to `staging` needs all four: green CI, every acceptance criterion checked against reality, the PR's testing boxes checked from an actual CI run, and review addressed. An agent cannot supply a human approval, so where the project requires a reviewer other than the author, the agent opens the PR and stops; where the project gates only on the four conditions above, the agent merges. If you cannot tell which the project wants, open the PR and ask the maintainer — never assume the merge is yours to take. You may NEVER approve a PR at all, on any branch.

If you find uncommitted work on `staging` or `main`, stop: create the issue and branch NOW, then move the changes onto the proper branch.

## ⚠️ MANDATORY: Post-Merge Branch Cleanup

**The merge is not finished when the PR says MERGED. It is finished when the branch is gone.**
Delete the branch as the last action of every merge — remote, local, and stale
remote-tracking refs. Do not batch this up later: later is never, and a pile of
half-remembered branches is how a repository ends up with 20 refs nobody will touch.

**Never delete a branch that has an open PR, an unmerged PR, or work that is not on the
integration branch.** Check first; do not infer from branch names.

```bash
# 1. Which merged PRs still have a live branch? (merged ∩ remote, minus open)
gh pr list --state merged --limit 100 --json headRefName --jq '.[].headRefName' | LC_ALL=C sort -u > /tmp/merged
gh pr list --state open   --limit 100 --json headRefName --jq '.[].headRefName' | LC_ALL=C sort -u > /tmp/open
git ls-remote --heads origin | awk '{print $2}' | sed 's|refs/heads/||' | grep -vxE 'main|staging' | LC_ALL=C sort -u > /tmp/live
LC_ALL=C comm -12 /tmp/live /tmp/merged | LC_ALL=C comm -23 - /tmp/open    # deletable list

# 2. Delete remote + local, then prune the tracking refs
git push origin --delete <branch> [<branch> ...]
git branch -D <branch> [<branch> ...]      # -D, not -d: see the squash caveat below
git fetch origin --prune

# 3. Prove it: both lists should show only the long-lived branches
git ls-remote --heads origin && git branch
```

Four traps that make this go wrong:

1. **`git branch --merged` does not work after a squash merge.** Squashing rewrites history, so
   the branch tip is not an ancestor of `staging` and `--merged` will not list it — and
   `git branch -d` will *refuse* to delete a branch whose work is fully landed. Trust the PR
   state (`gh pr list --state merged --head <branch>`), not ancestry, and use `-D` once you
   have confirmed the merge commit exists on the integration branch.
2. **Your local view of the remote lies until you prune.** `git branch -r` keeps showing
   branches GitHub already deleted (auto-delete-on-merge, or someone else's cleanup), so
   `git push --delete` fails with `remote ref does not exist` for refs you swore were there.
   Confirm with `git ls-remote --heads origin` before believing any inventory.
3. **Deleting in bulk can silently skip some.** A single `git push --delete a b c` that errors
   on one ref reports the rest as deleted; verify with `ls-remote` afterwards rather than
   reading the success lines.
4. **Check for open PRs on the same branch name.** If a branch is reused across stacked PRs,
   deleting it strands the open one. `comm -23` against the open-PR list is not optional.

**Do not delete the integration branches** (`staging`, `main`, or the project's equivalents),
and do not delete a branch the maintainer asked to keep. If a branch has no merged PR at all,
it is not yours to remove — report it and ask.

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

## ⚠️ MANDATORY: Testing Tiers and the Composition Root

Outside-in testing only works if the **outer** rung exists. Unit tests of injected, isolated
modules do not substitute for it, and in a plugin/seam architecture they cannot:

> **Dependency injection moves bugs from the module into the composition root. It does not
> eliminate them.**

A test that injects a fake collaborator cannot observe the code that supplies the real one. That
is the location of `createApp()`, provider defaults, factory functions, CLI entry points, and
build wiring — exactly where "works in tests, broken when installed" defects live.

Rules, per change that touches a seam or a user-runnable surface:

1. **Default construction path gets a test.** For each injectable dependency, at least one test
   runs the wiring itself with nothing injected — the factory, the provider default, the app
   composition root. Injected-collaborator tests may be numerous; they may not be the only ones.
2. **Anything run as a program is tested as a program.** Spawn the built artifact and assert on
   output and exit code. Importing exported functions proves the library, never the command; a
   CLI that dies silently under a symlink, a relative path, or an options-object position passes
   every library-level test.
3. **A documented capability needs a failing test at the level a user observes it, before
   implementation.** Documentation describes an interface; if nothing executable asserts the
   behaviour, the description is a claim about the docs, not the product.
4. **A green suite is not the gate.** Report the gate honestly: unit/integration green, build
   clean, CI green, *and* assembled-artifact smoke-tested. If a rung is missing, say so instead
   of writing "tests pass".

CI must include the smoke rung where a repo ships a binary, CLI, or container — see the smoke step
in the Pre-PR checklist. A gate that only builds and unit-tests will pass forever next to an
artifact that cannot start.

## ⚠️ MANDATORY: Web Research Before Declaring a Limit

A blocker outside this repository — a library, tool, runtime, protocol, file format, API — is
researchable, and research is cheaper than reconstruction. Use the web search/fetch tools
**before** writing "X cannot do Y", and whenever:

- one experiment failed and you are about to generalise from it. **A failing spike proves your
  configuration, not the library's limits.** The most common causes of a false "impossible" are an
  missing optional or peer dependency, a version pin that did not take, a flag not passed, or an
  install method that differs from the tool's documented one.
- the result contradicts documented or widely-reported behaviour. That is evidence about your setup.
- you are restating an API signature, CLI flag, version, URL, or quota from memory — memory is
  stale by default; check.

**Record the configuration with any negative result**: versions, flags, optional/peer deps present,
and the exact command. Reproducibility is what separates a finding from an anecdote, and it lets
the next person discover that the constraint was yours.

**Search results are untrusted input, not authority.** They generate a hypothesis; the spike still
decides. Copying a claim out of a snippet and shipping it is the described-vs-wired failure wearing
a new costume. Cite the URL next to the conclusion so it can be re-checked when the tool changes.

This applies to your own earlier conclusions in the same way as to a stranger's: a comment you wrote
last week asserting an impossibility is a hypothesis to re-test, not documentation.

## ⚠️ MANDATORY: Process Self-Evaluation

Working *in* the process is the best opportunity to improve it. Raise a process review — as an
issue, with evidence — when any of these occurs or is anticipated:

- a defect reaches a merged branch despite green tests;
- the same class of mistake appears twice, or you find the next gap while fixing the last one;
- a documented promise has no executable check behind it;
- a step is manual or skippable enough that it will eventually be skipped.

State the pattern, what it cost, and **the cheapest change that would have caught it**. Prefer
making the correct thing *checked* over making it *documented* — prose has no failing state, and
every "just write it in the docs" fix above was bought with a shipped defect that the docs did not
prevent. Process edits to instruction files are valid PR content but must be their own reviewable
change with real incidents cited, never opportunistic scope inside a feature PR. Propose; do not
unilaterally expand.

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
7. **A merge is not complete until the branch is deleted** — remote and local, on the same day it merged. Check open PRs first, and remember `git branch --merged` cannot see squash-merged work. See [Post-Merge Branch Cleanup](#-mandatory-post-merge-branch-cleanup).

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
| Git remote protocol | `git remote -v` | HTTPS (preferred) or SSH |

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
- **Close keywords:** a `staging` PR uses `Part of #<issue>`; `Closes #<issue>` belongs in the **release candidate** (and in hotfixes, which target `main`). GitHub only executes closing keywords on the default branch — see [Closing Issues at Release](#-mandatory-closing-issues-at-release).
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
Part of #<issue>
<!-- `Part of`, NOT `Closes`: this PR merges to `staging`, where a closing keyword cannot fire.
     The issue is closed by the release candidate that ships it — see "Closing Issues at Release". -->
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
- [ ] Closing list derived by script (RC step 4), not written from memory
- [ ] Every issue below has ALL acceptance criteria checked; half-done issues are held, not closed

### Closes (derived from the PRs shipping in this release)
<!-- One line per issue, produced by the derivation — nothing typed from recollection. -->
Closes #<N>
Closes #<N>
Closes #<N>

### Held back (unchecked criteria — do not close yet)
- #<N> — <which criterion remains open, and what it needs>

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
<!-- Correct here and nowhere else on a routine PR: a hotfix merges into `main`, the default
     branch, so the closing keyword DOES fire. This is also why hotfix issues close earlier
     than ordinary ones — they ship immediately. -->

## Post-merge
- [ ] Merge main back into staging
'
```

### PR Hygiene

- **Title format:** `<type>: <description> (#<issue>)` — issue number in parentheses
- **Base branch:** features/fixes target `staging`; hotfixes and release candidates target `main`.
- **Body must include:** summary, testing checklist, and the issue reference — `Part of #<issue>` on a staging PR, `Closes #<issue>` on an RC or hotfix
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
- **Closing:** a `staging` PR does **not** close its issue — the keyword cannot fire off the default branch. The release candidate closes it (see Closing Issues at Release). Close manually only for invalid / won't-fix issues, with explanation.

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
| Staging PR | Issue | `Part of #<N>` in PR body — **never `Closes #<N>`, which cannot fire on a `staging` merge** | **Yes** |
| RC PR | Every issue shipping | `Closes #<N>` lines assembled mechanically from the merged PRs since the previous tag | **Yes** |
| Hotfix PR | Issue | `Closes #<N>` (hotfixes target `main`, so the keyword does fire) | **Yes** |
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

8. Delete the branch you just merged — remote, local, and stale tracking refs
   git push origin --delete feature/<issue-number>-short-description
   git branch -D feature/<issue-number>-short-description   # -D: squash merges break -d's ancestry check
   git fetch origin --prune
   git ls-remote --heads origin    # verify it is actually gone; trust this, not `git branch -r`
```

### Pre-PR Verification Checklist

Run this every time, immediately before opening the PR (this is the artifact the "reload this skill before completion" step asks for). Every line must be true against something you actually observed this session — not intended, not assumed.

- [ ] On a `feature/*` or `fix/*` branch off `staging`, never on `main`/`staging` directly
- [ ] Issue exists and is linked; branch name carries its number
- [ ] Documentation updated **and committed** before code (diff shows the doc files changed)
- [ ] Tests written outside-in and committed per layer; `<test command>` run now → 0 failures
- [ ] `<typecheck command>` and `<build command>` run now → clean / exit 0
- [ ] Seams and user-runnable surfaces have ≥1 test on the **default construction path**, nothing injected (see Testing Tiers and the Composition Root)
- [ ] Where the change ships a CLI/binary/container, the **built artifact was executed this session** and its output plus exit code are pasted in the PR — library-level tests alone do not clear this gate
- [ ] All acceptance criteria checked in the **issue body**, plus a progress comment posted
- [ ] `origin/staging` merged into this branch; conflicts resolved here, pushed
- [ ] Cross-links present: `(#<issue>)` in commits and in the PR title, `Part of #<issue>` in a staging PR body (`Closes #<issue>` only on an RC or hotfix)
- [ ] PR small (< ~10 files, < ~15 min CI) or split into stacked PRs
- [ ] Self-reviewed own diff: no debug leftovers, no stray files
- [ ] Changelog entry added under `[Unreleased]` in `CHANGELOG.md` (see Changelog Convention)
- [ ] If docs changed: context packs regenerate cleanly (`pnpm --filter @saip/docs pack-context`) — packs are build artifacts deployed with the site, never committed

## Release Candidate Workflow (`staging` → `main`)

When `staging` is ready for release. **Agent role ends at "RC PR opened": an agent may do steps 1–5 and watch CI in step 6, but never merges or tags — steps 7–9 are maintainer actions.**

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

4. Assemble the closing list — mechanically, never from memory (see below)
    python3 - <<'PY'
    import subprocess, json, re
    def sh(*a): return subprocess.run(a, capture_output=True, text=True).stdout
    prs  = json.loads(sh('gh','pr','list','--state','merged','--base','staging','--limit','300','--json','number,title'))
    open_ = {int(i['number']): i for i in json.loads(sh('gh','issue','list','--state','open','--limit','300','--json','number,body'))}
    # Narrow to this release: PRs merged after the previous tag, e.g.
    # since = sh('git','log','--no-merges','--format=%s','<prev-tag>..origin/staging')
    issues = {int(n) for p in prs for n in re.findall(r'\(#(\d+)\)', p['title'])}
    for i in sorted(issues & set(open_)):
        unchecked = len(re.findall(r'^- \[ \]', open_[i]['body'] or '', re.M))
        print(f"#{i}  unchecked={unchecked}  {'HOLD — do not close' if unchecked else 'CLOSING'}")
    PY

5. Open the release candidate PR from staging to main, its body carrying one `Closes #<N>` line
   per issue the script marked CLOSING (RC template above). Issues marked HOLD are omitted and
   their deficit is named in the body.
   gh pr create --base main --head staging --title "Release candidate: <version>" --body-file rc.md

6. ALL CI must pass on this PR. No exceptions for normal releases.
   gh pr checks <number> --watch

7. [MAINTAINER] Approve and merge to main
   gh pr merge <number> --merge   # merge commit, not squash, for RCs

8. [MAINTAINER] Tag and push — this triggers the release pipeline
   # VERIFY FORMAT against the project's convention (prefix included)
   # The tag MUST equal the version already committed in <manifest> on main.
   git tag -a <version> -m "<version> — summary"
   git push origin main --tags

9. [MAINTAINER] Verify the release succeeded, AND that every listed issue actually closed
   gh run list --limit 1 ; gh release view <version>
   gh issue view <N> --json state --jq .state      # for each N in the closing list
   # Any that are still OPEN were mis-listed or blocked by a permission: close or reopen with an
   # explanatory comment. Do not leave the board silently wrong — that drift is what this step fixes.
```

**One open release at a time.** Only one RC may be pending (`staging` → `main`) at any moment. Work that lands on `staging` after an RC is opened joins the *next* release unless the maintainer updates the existing RC to include it — never open a second RC over the same window, and never decide silently which release your change ships in. If an RC is already open when you finish, ask the maintainer whether to fold your change into it or hold it for the next one.

## ⚠️ MANDATORY: Closing Issues at Release

**GitHub executes `Closes #N` only when a PR merges into the repository's default branch.** A PR
merged into `staging` (or any non-default branch) closes nothing — no comment, no error, no hint.
Projects that gate development on `staging` and write `Closes #N` in every feature PR therefore run
a board that silently drifts from reality, and nobody notices until 19 finished issues are still
open.

So the division is deliberate:

| PR type | Base | Keyword | Why |
|---------|------|---------|-----|
| Feature / fix | `staging` | `Part of #N` | Auto-close cannot fire here; the reference is traceability only |
| Release candidate | `main` | `Closes #N` for **every** shipping issue | This is where closure actually happens |
| Hotfix | `main` | `Closes #N` | Targets the default branch directly, so it fires |

Development PRs stay cheap to merge — fast, agent-merged, gated on tests alone. Deferring closure
concentrates the bookkeeping on releases, which are far less frequent than staging merges. That is
the trade: the RC carries the burden on purpose.

**Assemble the closing list by running the derivation in RC step 4, never from memory.** A
hand-written list is how a release closes the wrong issues or quietly forgets eight. The derivation
walks merged PR titles since the previous tag, intersects them with currently-open issues, and
reports each one's unchecked acceptance-criteria count.

**Hard guard — an issue with any unchecked acceptance criterion is NOT closed by the release.**
Hold it, omit its `Closes` line, and name the deficit in the RC body. Acceptance criteria are
living checkboxes; closing an issue mid-flight destroys the only record of what remained. Checking
the list therefore means checking that no half-finished work slipped in, not merely that a command
ran.

Also true, and easy to trip over:

- A squash merge rewrites history, so a branch's own commits never appear on `main`. The link
  survives in the PR *title* convention `(#N)` — which is what the derivation parses. Keep that
  convention intact or the closing list silently comes back empty.
- `Closes #N` only reaches issues in the **same repository**. Cross-repo work is closed manually
  with a link.
- `Fixes` / `Resolves` are equivalent keywords. Pick one and stay consistent so grep and
  derivation remain simple.
- One PR may close many issues: separate `Closes #12` / `Closes #13` lines, all landing on the
  default branch.
- If the RC merge leaves a listed issue open, that is a defect to correct immediately — close it
  with a comment, or reopen it. RC step 9 is a verification, not a formality.

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

## Changelog Convention

Every project maintains a `CHANGELOG.md` at the repository root. This is non-negotiable.

### Format

Follow [Keep a Changelog](https://keepachangelog.com/) structure:

```markdown
# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]
### Added
- Description of new feature (#<issue>)

### Fixed
- Description of bug fix (#<issue>)

## [1.0.0] - 2026-10-18
### Added
- Initial release
```

### Rules

1. **Entries come from PR titles, not individual commits.** Since feature PRs are squash-merged, each merged PR produces exactly one changelog entry. The PR title IS the changelog line.
2. **Group by type.** Use the conventional commit prefix to sort entries under the correct heading:
   - `feat:` → **Added**
   - `fix:` → **Fixed**
   - `refactor:` → **Changed**
   - `docs:` → **Documentation** (optional section; include if docs changes are user-visible)
   - `chore:`, `test:` → omit unless user-facing
3. **Always include the issue number.** Every changelog entry ends with `(#<issue>)`.
4. **Update during the RC, not after.** The changelog entry for a version is committed on `staging` as part of the release candidate PR. It ships with the code.
5. **[Unreleased] is always present.** New entries land under `[Unreleased]` during normal feature work. At release time, `[Unreleased]` is renamed to the new version and date, and a fresh empty `[Unreleased]` section is added above it.
6. **Monorepo projects:** each subproject with independent versioning maintains its own `CHANGELOG.md`. A root-level `CHANGELOG.md` tracks cross-cutting changes (CI, shared infrastructure, top-level documentation). Prefix entries with the subproject name when they appear in the root changelog: `- saip-trainer: add weighted KTO plugin (#12)`.
7. **Write for humans, not parsers.** Each entry is one readable sentence describing what changed and why it matters. Not a commit hash dump.

### When to Add Entries

Add a changelog entry whenever your PR introduces a user-visible or developer-visible change. Internal refactors with no external impact can be omitted. When in doubt, include it — it is easier to trim a changelog than to reconstruct missing history.

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
- Reporting "tests pass" when the assembled artifact was never executed
- A seam or CLI whose only tests inject fakes, leaving production wiring untested
- A documented capability with no failing test written before its implementation
- Writing "X cannot do Y" without searching, or from one spike whose configuration you did not record
- Accepting a search snippet as fact and shipping it without re-testing
- A PR merged whose branch still exists — locally or on the remote (see Post-Merge Branch Cleanup)
- A `Closes #N` in a `staging` PR body, which cannot fire and reads as done when it is not
- A release candidate whose closing list was written from memory instead of derived from the merged PRs
- An issue closed by a release while it still has an unchecked acceptance criterion
- Deleting a branch because its name looks stale, without confirming a merged PR and no open PR
- Hotfix that skipped the `main` → `staging` sync
- Same tool call or command repeated 3+ times without progress (see Agent Loop Guard)

## Quick Reference

| Action | Command |
|--------|---------|
| Start a feature | `git checkout staging && git pull && git checkout -b feature/N-desc` |
| Sync staging into feature | `git fetch origin staging && git merge origin/staging` |
| Open PR to staging | `gh pr create --base staging --title "..." --body "Part of #N"` |
| Derive the RC closing list | merged PR titles `(#N)` ∩ open issues, reporting unchecked-criteria counts |
| Confirm a keyword will actually fire | it fires only when the PR's base is the **default** branch |
| Check CI status | `gh pr checks <N> --watch` |
| View failed CI logs | `gh run view <id> --log-failed` |
| Merge PR (squash) | `gh pr merge <N> --squash` |
| Delete merged branch (remote + local) | `git push origin --delete <branch> && git branch -D <branch> && git fetch --prune` |
| List branches that are safe to delete | merged ∩ remote − open, via `gh pr list --state merged/open` + `git ls-remote --heads` |
| Confirm what actually exists remotely | `git ls-remote --heads origin` *(not `git branch -r`, which is stale until pruned)* |
| Prove the artifact runs, not just the library | build, then execute the binary and assert output + exit code |
| Find the composition root of a seam | grep the factory/default-provider call sites, then test those |
| About to call something impossible | search for the library + toolchain + error text first, and record your versions/flags |
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
