# Changelog — @saip/cli

## [Unreleased]
### Added
- `probeHost()` returns a host's `HostStatus` to the caller and `saip status` renders mode, uptime, bucket and adapter count from it; `HostStatus.uptime` is read from docker's `{{.Status}}` field (#114)
- `materialiseKey`, `publicPath` and `writePublicKeypair` require the key directory; `storeKeyDir()` derives it from the store in hand; `sshKeyDir(env)` reads `env.HOME` before falling back to `homedir()` (#159)
- `tests/ssh-key-location.test.ts` pins the rule at command, library and assembled-artifact level, including a check that the real `~/.saip/keys` is unchanged by a full run (#159)
- pty harness (`tests/support/pty.ts`), screen model (`tests/support/screen.ts`) and a protocol-faithful fake tty (`tests/support/fake-tty.ts`), each with self-tests that prove they can fail — known exit code 7, a known hang, signal death reported as a signal and not as `code 0`, verbatim capture above the 64 KB pipe-buffer size, and isolation that refuses a path resolving inside the real `$HOME` (#154)
- `tests/ink-gate.test.ts` runs #154's gate rows against two candidate Ink engines; `tests/spikes/` holds the engines and the probe driver that produced the spike's evidence (#154)
- fixed in the harness itself: a child that exited before `finish()` was called was reported as **hung**, which briefly produced a false claim that the shipped CLI's `config set` never returned; the case is now pinned by a test that fails when the fix is reverted (#154)
- CLI skeleton with awake, sleep, down, status commands (#1)
### Fixed
- unknown-host errors carry the role and flag that fixes them (`unknown deploy source host … — set --source <name>`), and the known-host list truncates at eight with `+N more` (#117)
- `saip status` placeholders (`TODO (awake / asleep / down)`, `TODO`, `TODO (R2 bucket name)`, a zero adapter count rendered as `TODO`) are replaced by real values or explained absences; an unreachable host reports `unknown` with its reason rather than `down`; `--adapter-resolution` had been documented while the flag never existed and is removed from the CLI reference (#114)
