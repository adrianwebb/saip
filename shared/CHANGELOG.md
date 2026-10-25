# Changelog — @saip/shared

## [Unreleased]
### Added
- *(nothing changed in `shared` for #156, recorded deliberately.)* The issue said the profile report's prose was assembled in `shared/src/profiles.ts`. It was not — `shared` returned data, and the string was built in `cli/src/commands/profiles.ts`. Checked by reading the file rather than editing the place the ticket named, because "fix what the issue says" and "fix what the code does" are different changes
- `SecretAccess.write()` and `storedNames()` (#169): writes have a route through the gateway, are recorded in the access audit like reads, and share its cached key — a store that exists but cannot be unlocked refuses the write instead of half-writing, and an absent store is not an error because creating it is the one legitimate moment the passphrase belongs. Forwarded on the `SecretAccessService` plugin alongside `readStored()`
- Creating a secret store is now its own unlock: `SecretStore.persist()` seeds `kekCache` from the file it just wrote (#169). Before, the KEK derived during provisioning was discarded, so the next read re-derived it — `saip config init` asked for the passphrase twice in one command, and anything the creating instance was asked afterwards (`storedNames()`, `activeWrap()`) cost a second unlock. The seeded signature is taken from the object that reached disk, so the cache cannot claim validity against a wrap set the file does not contain
- Shared type definitions (AdapterManifest, SessionManifest, FeedbackRecord, etc.) (#1)
