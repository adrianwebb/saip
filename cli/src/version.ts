/**
 * The version this build reports.
 *
 * Deliberately a constant rather than a runtime read of `package.json`: a distributed single-file
 * binary (#71) may be the only copy of the application on a server, with no package file next to
 * it, so "read the manifest" is not an option there. The cost of an embedded literal is drift, and
 * drift is not left to discipline — `tests/version.test.ts` asserts this equals `package.json`, and
 * `scripts/build-binaries.mjs` refuses to compile if it does not match.
 */
export const SAIP_VERSION = '0.5.0'
