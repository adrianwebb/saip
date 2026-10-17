---
name: release-workflow
description: Mandatory Git/GitHub development and release workflow for dsh-chapters — branch model, feature/release/hotfix flows, CI gates, commit conventions, issue/PR templates, and cross-linking rules.
whenToUse: When working on any code change, creating branches, opening PRs, merging, tagging releases, creating issues, commenting, or discussing the development workflow for this project.
---

# dsh-chapters Release Workflow

This skill defines the mandatory Git/GitHub development and release workflow for the dsh-chapters project. Follow these rules in every session. They are non-negotiable unless explicitly overridden by the project maintainer.

## ⚠️ MANDATORY: Starting Any New Work

**Before writing a single line of code or making any change, you MUST:**

1. **Load this skill** (`release-workflow`) at the start of every new project or statement of work.
2. **Create or adopt a GitHub Issue** that describes the work. If no issue exists, create one NOW using the templates below. Every piece of work — feature, fix, refactor, docs — requires an issue.
3. **Create a feature branch from the latest staging.** Never work directly on `staging` or `main`.
   ```bash
   git checkout staging && git pull origin staging
   git checkout -b feature/<issue-number>-short-description
   ```
4. **Commit incrementally.** After completing each logical segment of work (a fix, a sub-feature, a test suite), commit and push to the feature branch. Do not accumulate uncommitted changes across sessions.
5. **Open a PR when complete.** When the project is done, open a PR targeting `staging` with `Closes #<issue>` in the body. Wait for CI green before merging.
6. **Load this skill again before completion.** Re-read this workflow before opening the PR to verify branch naming, commit messages, PR template, and cross-linking are correct.

**Agents may merge PRs to staging after all acceptance tests pass. Agents may NOT approve or merge PRs to main.** Only the project maintainer approves releases to production.

If you find yourself with uncommitted work on `staging` or `main`, stop: create the issue and branch NOW, then move the changes to the proper branch.

## ⚠️ MANDATORY: Documentation-First Development Cycle

**Every change follows this cycle, in this order. No exceptions.**

```
Plan/Issue → Documentation → Tests → Implementation → Release
```

### 1. Plan / Issue
Create or adopt a GitHub Issue. Define what changes, why, and the acceptance criteria.

### 2. Documentation FIRST
**Write or update the documentation BEFORE writing any code.** This locks in the programmatic
interface, forces clarity on what is changing, and prevents docs from going stale. Update all
affected pages: site docs (`site/src/content/docs/`), repo docs (`docs/`), README, skills, and
AGENTS.md as applicable. If the change adds new functionality, write the docs that describe it.
If it changes existing behavior, update the docs that describe that behavior. Commit the docs.

### 3. Tests (outside-in)
Write tests in this order, committing after each layer:
1. **Acceptance / smoke tests** — user-facing behavior, end-to-end flows, CLI commands
2. **Regression tests** — pin the specific bug or edge case being fixed
3. **Integration tests** — component boundaries, service interactions, host wiring
4. **Unit tests** — pure logic, isolated functions, data transformations

Testing outside-in ensures the interface is stable before internals are built. A test that cannot
be written because the interface does not exist yet is a signal that step 2 (documentation) is
incomplete.

### 4. Implementation
Write the code that makes the tests pass. Commit incrementally — each logical unit of work gets
its own commit referencing the issue number.

### 5. Release
Open PR, wait for CI green, merge to staging. For production releases, follow the Release
Candidate workflow below.

**Why this order matters:** Documentation written after code describes what was built, not what
should be built — it captures implementation details instead of intent, and it is perpetually
behind. Tests written after code verify the implementation, not the specification. The cycle
forces specification-driven development: the docs ARE the spec, the tests validate the spec,
and the code satisfies the tests.

## Branch Model

| Branch | Purpose | Protection |
|--------|---------|------------|
| `main` | Production. Tags and releases are cut ONLY from main. | All merges require a PR from staging with green CI. |
| `staging` | Integration branch. All feature work lands here first. | Never behind main except during hotfix windows. |
| `feature/*`, `fix/*` | Feature or bugfix branches, created FROM staging. | Merged back to staging via PR. |
| `hotfix/*` | Emergency fixes, created FROM main. | Bypasses staging when speed is critical. |

## The Golden Rules

1. **All merges to main go through staging.** No direct commits or feature-branch merges to main.
2. **Tags and releases are cut from main only.** Never tag staging or a feature branch.
3. **All CI must be green before merging to main.** The release workflow (npm publish) is triggered by pushing a tag on main; if CI isn't green, don't tag.
4. **Staging is never behind main** except during a hotfix window. After a hotfix merges to main, the next release candidate PR must merge main back into staging to catch up.
5. **Every feature/fix branch tracks a GitHub Issue.** Either adopt an existing issue or create one before starting work. Reference it in the branch name and PR.
6. **Merge staging INTO your feature branch before merging TO staging.** Resolve conflicts on the feature branch, not on staging.

## Version & Tag Format

Tags and package versions MUST follow strict **semantic versioning** with NO `v` prefix:

```
Format:  <major>.<minor>.<patch>           (stable release)
         <major>.<minor>.<patch>-dev.<N>   (development/prerelease)
```

```
0.1.19        ✅ correct
0.1.19-dev.1  ✅ correct (development prerelease)
v0.1.19       ❌ WRONG — no 'v' prefix, ever
0.1           ❌ WRONG — all three components required
1.0           ❌ WRONG — patch component required
0.1.19-beta   ❌ WRONG — only -dev.<N> suffix allowed
```

**Rules:**
- Tags are bare semver: `<major>.<minor>.<patch>` — **NO `v` prefix**
- The `package.json` version field matches exactly: `"version": "0.1.19"`
- Development/prerelease tags use `-dev.<N>` suffix: `0.2.0-dev.1`, `0.2.0-dev.2`
- Bump rules: breaking change → major, new feature → minor, fix/chore/docs → patch
- Never reuse a tag. If a tag was pushed incorrectly, delete it (`git tag -d X.Y.Z && git push origin :refs/tags/X.Y.Z`) before creating the correct one.
- Always verify the tag format BEFORE pushing: `git tag -l | tail -5`

## Issue Guidelines

### Creating Issues

Every piece of work starts with an issue. **All issue types require acceptance criteria** — even refactors and chores. Acceptance criteria are living checkboxes that MUST be updated as work progresses (see Progress Comments below).

**Bug Report:**
```bash
gh issue create --title "fix: <short description>" --label "bug" --body '
## Problem
<What is broken? What behavior did you expect vs what happened?>

## Reproduction
<Steps to reproduce, or "N/A" if discovered through code inspection>

## Environment
- DSH version: <version>
- Node version: <version>
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
- [ ] Documented in site docs / README / AGENTS.md as applicable
- [ ] Unit tests covering the new behavior
- [ ] Integration or e2e test verifying end-to-end flow (if user-facing)

## Related
<Link to related issues, PRs, discussions, or external references>
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
- [ ] TypeCheck clean
- [ ] Documentation updated if public API surface changed
'
```

### ⚠️ MANDATORY: Acceptance Criteria Are Living Checkboxes

Acceptance criteria are NOT write-once. They are a **progress tracker**:

1. **At issue creation:** Write all criteria as unchecked `- [ ]` items
2. **During work:** Edit the issue body to check off items as they are completed: `- [x]`
3. **Before opening PR:** ALL acceptance criteria must be checked. If any cannot be met, comment explaining why and update the criterion
4. **At PR review:** Reviewer verifies each checked criterion is actually satisfied

Use `gh issue edit <number> --body '...'` or the GitHub web UI to update checkboxes. A PR that closes an issue with unchecked acceptance criteria is incomplete.

### Issue Hygiene

- **Title format:** `<type>: <imperative description>` — mirrors commit convention (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)
- **Labels:** Apply at creation. At minimum one of: `bug`, `enhancement`, `refactor`, `docs`, `chore`. Add `priority` for urgent work.
- **Related links:** Always link related issues, PRs, or external references in the body or comments using `#<number>` or full URLs.
- **Close keywords:** PRs should use `Closes #<issue>` or `Fixes #<issue>` in the body to auto-close on merge.
- **Update, don't duplicate:** If an issue evolves, edit it or comment. Don't create a new one for the same concern.

## Pull Request Guidelines

### PR Templates

**Feature/Fix PR (targeting staging):**
```bash
gh pr create --base staging \
  --title "feat: <description> (#<issue>)" \
  --body '
## Summary
<One paragraph: what changed and why>

## Changes
- <bullet list of concrete changes>

## Acceptance Criteria (from #<issue>)
<!-- Copy the acceptance criteria from the issue. Check each one as verified. -->
- [ ] <criterion 1>
- [ ] <criterion 2>

## Testing
<!-- Fill these AFTER CI runs, not at PR creation. Update via gh pr edit or web UI. -->
- [ ] CI green (typecheck + build + unit/integration)
- [ ] E2E replay passed (if applicable)
- [ ] New tests added for new behavior
- [ ] Existing tests pass without modification (for refactors)

## Related
Closes #<issue>
<Links to related PRs, issues, docs, or external references>
'
```

**Release Candidate PR (staging → main):**
```bash
gh pr create --base main --head staging \
  --title "Release candidate: <major>.<minor>.<patch>" \
  --body '
## Release <major>.<minor>.<patch>

### Changes since <previous>
- <bullet list from merged PRs/issues since last tag>

### Verification
- [ ] All CI checks green
- [ ] Deterministic suite passes (unit + integration)
- [ ] E2E replay passes (if tapes updated)
- [ ] Version bumped in package.json

### Tag after merge
`<major>.<minor>.<patch>`
'
```

**Hotfix PR (targeting main):**
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
- [ ] Deterministic suite passes (`npm test`)
- [ ] TypeCheck clean (`npm run typecheck`)
- [ ] Manual verification: <describe>

## Related
Closes #<issue>

## Post-merge
- [ ] Merge main back into staging
'
```

### PR Hygiene

- **Title format:** `<type>: <description> (#<issue>)` — include the issue number in parentheses
- **Base branch:** Features/fixes target `staging`. Hotfixes and release candidates target `main`.
- **Body must include:** Summary, testing checklist, and `Closes #<issue>` (or `Fixes #<issue>`)
- **Link everything:** Reference related issues (`#<number>`), prior PRs, docs, and external resources
- **Keep PRs small:** If a PR touches >10 files or takes >15 min of CI, split it into stacked PRs
- **Self-review before requesting review:** Read your own diff. Catch typos, leftover debug code, missing tests.

## Commenting Conventions

### On Issues

- **Progress updates (MANDATORY):** When completing a logical segment of work, post a comment updating the acceptance criteria state. Use this format:

  ```
  ## Progress Update
  
  Completed:
  - [x] <criterion that was just met>
  - [x] <another completed criterion>
  
  Remaining:
  - [ ] <what is left>
  
  <Brief note on what was done, any decisions made, or blockers encountered>
  ```

  Also **edit the issue body** to check off the completed criteria there. The comment provides context; the issue body is the source of truth.

- **Work started:** Comment when beginning work: "Starting implementation on `feature/N-desc`."
- **Blocked:** Comment immediately when blocked. Name the blocker and what is needed to unblock.
- **Scope change:** Comment explaining what changed and why before modifying acceptance criteria.
- **Decisions:** Record architectural or scope decisions as comments so future readers understand the "why."
- **Cross-references:** Link to related PRs, commits, or other issues: "Addressed in #<pr>", "See also #<issue>"
- **Closing:** Let the PR auto-close via `Closes #<issue>`. Only close manually if the issue is invalid or won't-fix (with explanation).

### On PRs

- **Testing verification (MANDATORY):** After CI completes, **edit the PR body** to check off the testing checkboxes based on actual CI results. Do not leave them as unchecked from creation. Use `gh pr edit <number> --body '...'` or the web UI.
- **CI failures:** Comment on the PR with the failure diagnosis and fix plan. Don't leave red CI unexplained. After fixing, update the testing checkboxes.
- **Review comments:** Be specific. Reference line numbers. Suggest fixes, not just problems.
- **Author responses:** Reply to every review comment. Resolve threads when addressed. If disagreeing, explain why.
- **Post-merge:** No need to comment "merged" — GitHub shows this automatically. Comment only if there is follow-up work.

### General

- **Be concise.** One thought per comment. Use bullet points for lists.
- **Use markdown.** Code blocks for snippets, links for references, checkboxes for action items.
- **@mention sparingly.** Only when someone needs to see it. Don't @mention for FYI.
- **Never edit others' comments.** Reply instead.

## Cross-Linking Requirements

Linking creates traceability. These are REQUIRED, not optional:

| From | To | How | Required? |
|------|----|-----|-----------|
| PR | Issue | `Closes #<N>` or `Fixes #<N>` in PR body | **Yes** |
| Feature branch | Issue | Issue number in branch name: `feature/42-desc` | **Yes** |
| Commit | Issue | `(#<N>)` in commit message | **Yes** |
| Issue | Related issue/PR | `#<N>` or full URL in body/comment | **Yes** |
| RC PR | Previous tag | `Changes since <X.Y.Z>` in RC body | **Yes** |
| Hotfix PR | Staging sync reminder | Checklist item in hotfix PR body | **Yes** |
| Comment | Code/file | Permalink or file:line reference | Encouraged |
| Comment | External resource | Full URL with description | Encouraged |

## Feature/Fix Workflow

```
1. Create or adopt a GitHub Issue (with acceptance criteria checkboxes)
   gh issue create --title "feat: ..." --label "enhancement" --body '...'
   # or: gh issue list --state open  (find existing)

2. Branch from staging
   git checkout staging && git pull origin staging
   git checkout -b feature/<issue-number>-short-description

3. Work, commit, push — update issue checkboxes after each segment
   git add ... && git commit -m "feat: description (#<issue>)"
   git push origin feature/<issue-number>-short-description
   # Edit issue body: check off completed acceptance criteria
   # Post progress comment with what was done and what remains

4. Before opening PR: sync staging in, verify ALL acceptance criteria checked
   git fetch origin staging
   git merge origin/staging
   # Resolve conflicts if any, then:
   git push origin feature/<issue-number>-short-description

5. Open PR targeting staging (copy acceptance criteria from issue into PR body)
   gh pr create --base staging --title "feat: description (#<issue>)" \
     --body "..."

6. After CI completes: edit PR body to check off testing checkboxes
   gh pr edit <number> --body '...'   # update based on actual CI results

7. Address review, merge to staging
   gh pr merge <number> --squash   # after approval + green CI + all checkboxes checked
```

## Release Candidate Workflow (staging → main)

When staging is ready for release:

```
1. Determine the next version: <major>.<minor>.<patch>
   # Check current: grep '"version"' package.json
   # Bump: patch for fixes, minor for features, major for breaking changes

2. Open a release candidate PR from staging to main (use RC template above)
   gh pr create --base main --head staging \
     --title "Release candidate: <major>.<minor>.<patch>" \
     --body "..."

3. ALL CI must pass on this PR. No exceptions for normal releases.
   gh pr checks <number> --watch

4. After green CI + review approval, merge to main
   gh pr merge <number> --merge   # use merge commit, not squash, for RCs

5. Bump version in package.json, commit, push
   # Edit package.json version field to "<major>.<minor>.<patch>"
   git add package.json && git commit -m "<major>.<minor>.<patch>"
   git push origin main

6. Tag and push — this triggers the release workflow
   # VERIFY FORMAT: must be <major>.<minor>.<patch> — NO 'v' PREFIX
   git tag -a <major>.<minor>.<patch> -m "<major>.<minor>.<patch> — summary"
   git push origin main --tags

7. Verify the release succeeded
   gh run list --workflow=Release --limit 1
   gh release view <major>.<minor>.<patch>
```

## Hotfix Workflow (Emergency Only)

Hotfixes bypass staging when waiting for full CI would cause unacceptable delay.

```
1. Branch from main
   git checkout main && git pull origin main
   git checkout -b hotfix/<issue-number>-short-description

2. Fix, commit, push
   git add ... && git commit -m "fix: urgent description (#<issue>)"
   git push origin hotfix/<issue-number>-short-description

3. Open PR targeting main (NOT staging, use hotfix template above)
   gh pr create --base main --title "HOTFIX: description (#<issue>)" \
     --body "..."

4. Run ONLY the deterministic suite (fast gate), not full e2e
   # The CI workflow runs this automatically on PRs to main.
   # If you need to verify locally: npm test && npm run typecheck

5. Merge to main after fast-gate green + maintainer approval
   gh pr merge <number> --merge

6. Tag and release as normal (steps 5-7 of Release Candidate above)
   # Remember: <major>.<minor>.<patch> format — NO 'v' prefix

7. AFTER the hotfix is on main: sync staging
   git checkout staging && git pull origin staging
   git merge origin/main
   git push origin staging
   # This ensures staging catches up and the next RC includes the fix.
```

## Large Changes: Avoiding CI Bottlenecks

When a change is too large for a single PR (huge refactor, major feature):

1. **Decompose into stacked PRs.** Each PR is independently mergeable to staging and passes CI on its own. Later PRs build on earlier ones.
   ```
   PR 1: refactor(core): extract module X (no behavior change)
   PR 2: refactor(core): update callers of X (depends on PR 1)
   PR 3: feat: new capability using refactored X (depends on PR 2)
   ```

2. **Each PR targets staging.** Merge sequentially as each goes green.

3. **Reference the parent issue in all PRs.** Use GitHub's task lists or link them in the body.

4. **Never hold a long-lived branch that diverges from staging.** Rebase or merge staging in frequently (at least daily for multi-day work).

5. **If a single PR would take >15 minutes of CI, split it.** The goal is rapid feedback loops, not batching.

## Staging Hygiene

- **Staging should always be deployable.** If it's broken, fixing it is the top priority.
- **After every hotfix to main, merge main into staging immediately.** Don't let staging drift.
- **Before starting any feature work, pull staging.** `git checkout staging && git pull origin staging` is step zero.
- **Never force-push to staging or main.** If history needs rewriting, discuss with the maintainer first.

## Commit Message Conventions

Follow conventional commits for automated changelog extraction:

```
feat: add CodeGraph integration (#42)
fix: correct search scoring when symbols absent (#38)
refactor: extract codegraph resolver into own module (#45)
test: add unit tests for codegraphBoost (#42)
docs: update AGENTS.md with CodeGraph integration notes (#42)
chore: bump tsx devDependency for build fix (#46)
0.1.19  ← version bump commit (no v prefix)
```

The type prefix (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`) drives release notes grouping. Always reference the issue number in parentheses.

## Quick Reference

| Action | Command |
|--------|---------|
| Start a feature | `git checkout staging && git pull && git checkout -b feature/N-desc` |
| Sync staging into feature | `git fetch origin staging && git merge origin/staging` |
| Open PR to staging | `gh pr create --base staging --title "..." --body "Closes #N"` |
| Check CI status | `gh pr checks <N> --watch` |
| Merge PR (squash) | `gh pr merge <N> --squash` |
| Open release candidate | `gh pr create --base main --head staging --title "RC: X.Y.Z"` |
| Merge RC to main | `gh pr merge <N> --merge` |
| Tag a release | `git tag -a X.Y.Z -m "message" && git push origin main --tags` |
| Delete a bad tag | `git tag -d X.Y.Z && git push origin :refs/tags/X.Y.Z` |
| Emergency hotfix | Branch from main → PR to main → fast-gate → merge → tag → sync staging |
| View failed CI logs | `gh run view <id> --log-failed` |
| List open issues | `gh issue list --state open` |
| Create an issue | `gh issue create --title "..." --body "..." --label "..."` |
| Comment on issue/PR | `gh issue comment <N> --body "..."` / `gh pr comment <N> --body "..."` |
