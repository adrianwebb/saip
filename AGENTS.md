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
   be stable before internals are built.
3. **Implementation.** Write code that makes the tests pass. Commit incrementally with issue refs.
4. **Release.** PR → CI green → merge to staging.

Why: docs written after code describe what was built, not what should be built. Tests written
after code verify the implementation, not the specification. This cycle forces spec-driven
development. See the `release-workflow` skill for full details.

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
the release-workflow skill is loaded.
