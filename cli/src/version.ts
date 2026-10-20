/**
 * The version and build provenance this binary reports.
 *
 * Deliberately constants rather than a runtime read of `package.json`: a distributed single-file binary
 * (#71) may be the only copy of the application on a server, with no package file next to it, so "read
 * the manifest" is not an option there. The cost of an embedded literal is drift, and drift is not left
 * to discipline — `tests/version.test.ts` asserts this equals `package.json`, and
 * `scripts/build-binaries.mjs` refuses to compile when it does not.
 */
export const SAIP_VERSION = '0.5.0'

/**
 * Which commit this artifact was compiled from, and for what platform (#119).
 *
 * Defaults are literal placeholders rather than something computed at runtime, for the same reason as
 * the version above: a compiled binary has no `.git`, and reading a path that does not exist inside
 * `/$bunfs/` would either fail or — worse, because it looks plausible — report the machine's checkout.
 * `scripts/install-dev.mjs` substitutes these three lines before compiling the dev build, so a dev
 * binary knows its own provenance while a plain `tsc` build honestly says "unknown".
 *
 * This is the audit trail a bare artifact leaves on a server: `--version` says which release,
 * `--built` says which commit, for which target, and when.
 */
export const SAIP_BUILD_COMMIT = 'unknown-commit'
export const SAIP_BUILD_TARGET = 'unknown-target'
export const SAIP_BUILD_DATE = 'unknown-date'
