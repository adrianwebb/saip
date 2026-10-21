# Spike #154 — can an Ink `InputEngine` replace `ttyEngine` without losing the terminal guarantees?

**Verdict: no, not as a drop-in — and the reason is not the one #106 predicted.**

An Ink instance terminates cleanly, respects the guidance-before-prompt ordering, and can carry
typed-ahead bytes to the next question. All three were unknown; all three are now measured green.
What sinks it is narrower and more specific: **Ink 8's input model cannot distinguish "this `\r`
ended my question" from "this `\r` was inside the text I was handed"**, because it never tells the
engine which of the two happened. Every guarantee this CLI bought with a bug report — #73, #78, #99,
#86 — has to be re-implemented on top of that blind channel, and at that point Ink is no longer
supplying the input engine; it is supplying a character feed that we parse ourselves. That is
`promptTTY` with extra steps and a rendering dependency, and it is a worse version of the thing we
already have.

Per #154: *"If the spike says don't, that is a successful outcome."* This says don't. `ttyEngine`
stays the default; `promptTTY`'s reducer is **not** deleted; no silent fallback was added.

Reproduce: `pnpm --filter @saip/cli test` (harness self-tests, the gate suite, the screen model) and
`npx tsx tests/spikes/run-all.ts` / `run-control.ts` / `run-artifact.ts` for the raw pty evidence.
Environment: Linux x86-64, Node v22.22.1, `ink@8.0.0`, `react@19.3.1`, `node-pty@1.1.0`,
vitest 3.2.7. Every probe ran under `isolatedEnv()` — fresh temp `HOME`, `SAIP_SECRETS_FILE`,
`SAIP_ENV_FILE`, `SAIP_HOSTS_FILE`, `SAIP_CONFIG`; the real `~/.saip` was not written (verified).

---

## The four unknowns

### 1. Does an Ink instance release the event loop on unmount? — **YES**

The #151 hang class was the primary risk: a prompt that prints its result and never returns. It is
not a risk. After answering, the child process exits by itself, with the terminal handed back:

```
P1-once-visible   code=0 signal=0 hung=false clean=true
  STATE[after-answer] readable=0 data=0 isRaw=false total=5
                      resources=["TTYWrap","TTYWrap","TTYWrap","Timeout","Immediate"]
```

`readable=0` is Ink's single `'readable'` stdin listener detached; `isRaw=false` is raw mode
released. `getActiveResourcesInfo()` still lists handles, but the process exits anyway — those are
the stdio `TTYWrap`s plus Ink's throttle timer, none of which hold the loop. The long-lived shape is
the same once it is stopped: `readable=1 isRaw=true` while it owns the terminal, `readable=0
isRaw=false` after `stop()`. Mechanism, read from the shipped build: raw mode is refcounted
(`App.js:256-290`) and `disableRawMode()` does `setRawMode(false)` + `stdin.unref?.()`; `unmount()`
never calls `process.exit`.

**Also measured, and worth keeping in mind for the next time a "hang" is reported:** the shipped CLI
terminates correctly under a pty. `config set` prompted exits 0 after printing `stored …`; so do
`--stdin`, `config list` and `status` (`tests/spikes/evidence/artifact-run.txt`). This is the
result of PR #151's ref/unref work holding up under a real terminal.

### 2. Do live-render cursor/erase codes break the #78 ordering? — **NO**

The concern was real: our one-shot `inkRenderer` uses `debug: true` and emits zero escapes, whereas a
live instance emits `\u1b[?2026h` (synchronised output), `\u1b[?25l` (hide cursor) and, between
questions, the erase sequence `\u1b[2K\u1b[1A\u1b[2K\u1b[G`. Screen state after the prompt was
re-rendered and answered, reconstructed by a self-tested terminal model:

```
  0| EXPLAIN-ONE: SAIP_R2_BUCKET holds the R2 bucket name.
  1| EXPLAIN-TWO: create it at dash.cloudflare.com → R2 Object Storage.
  2| SAIP_R2_BUCKET:
  3| ANSWERED=bucket-name
  4| AFTER-PROMPT: the next line must start at column zero.
```

Explanation is intact on rows 0–1, the prompt on row 2, and output after the prompt starts at column
zero. The ordering survives because Ink's `eraseLines(n)` only ever erases rows it previously drew —
`previousLineCount` starts at 0 for a fresh instance, so nothing above it is touched. The hidden
prompt behaves identically (`EXPLAIN-ONE` then the passphrase prompt, and `pass` never on screen).

Caveat, since it is the one place the naive port bites: the value only *appears* on the prompt line
if a frame gets painted before the answer terminates. Typing `mybucket` and Enter as one chunk
settles before the 30 fps frame flush, so the value is never drawn (`P6-echo-chunk` row 0 shows
`SAIP_R2_BUCKET:` with nothing after it); typing it in two events does show it. That is a live-
renderer property, not a bug, but it means an Ink prompt's visible behaviour depends on how fast the
user types — which is a UX property `promptTTY` does not have.

### 3. One instance per question, or one for the wizard? — **per question, and the difference is measurable**

Answered in the gate suite by running both shapes against the same 16 rows (`cli/tests/ink-gate.test.ts`,
32 cases plus 3 controls). The long-lived instance passes 13 of the 16 and fails three, all for one
reason: Ink enables raw mode and
bracketed paste when the first input hook mounts and releases them when the **instance** unmounts.
A wizard that spans five questions therefore owns the terminal for the whole session, whereas
#73/#86/#99 specify handback **per read** (`prompt.ts:88-92` acquires, `:108-115` releases before the
next question exists):

| gate row | ink-once | ink-wizard |
|---|---|---|
| `?2004h … ?2004l` bracketed around the read | pass | **fail — held for the session** |
| Ctrl+C rejects *and restores the terminal* | pass | **fail — raw mode still on** |
| raw mode handed back after the answer | pass | **fail — held until `stop()`** |
| the other 13 rows (paste, carry, masking, Ctrl+D, backspace) | pass | pass |

Duplicate stdin listeners are **not** a problem in either shape: Ink registers exactly one
`'readable'` listener, self-guarded (`App.js:240-247`), and fans out to N `useInput` hooks through an
internal `EventEmitter` with `setMaxListeners(Infinity)`. Measured `readable=1` across a five-question
wizard, never higher. Leftover typed-ahead bytes work in both shapes — once the carry is keyed by the
**stream** rather than by the question object (see the defect below).

I also tried the obvious third shape — one instance, with `suspendTerminal()` wrapping each question
so Ink's own refcounts release raw + paste modes per read. It made things **worse**: 8 gate failures
instead of 3. The suspended window has no Ink input channel, so reading the answer means installing a
raw `'data'` listener by hand, i.e. re-creating `promptTTY` inside the engine, and it desynchronised
from Ink's parser state. Not the report's conclusion, but recorded so nobody re-attempts it.

### 4. Masked input with paste intact? — **YES, and this part Ink genuinely does better**

The strongest result in the spike. `ink@8.0.0` `build/input-parser.js` treats bracketed paste as a
first-class event and routes it to `usePaste` on a **separate channel** from `useInput` — so a paste's
embedded newline is content by construction, with no reducer:

```
P4-paste-newline  code=0 hung=false   ANSWERED="very-long-secret-value\n"
                  (paste's \n preserved; the following Enter, not the paste, ended the read)
P4-ctrl-d         code=0 hung=false   ANSWERED="value-then-eof"
P4-ctrl-c         code=130            (cancelled, exit 130, terminal restored)
```

Masking holds under a real terminal: with `secret: true`, no probed case ever put the typed value on
screen (`never echoes a secret value onto the stream` passes for both shapes), and with `echo: true`
the value is visible on the prompt line, which is #87's requirement.

---

## What the probes found about my own code (four real defects, all now pinned by tests)

Reported because they are the interesting part — three of them are in `promptTTY`'s territory, not
Ink's, and each was invisible until a pty looked.

1. **The harness lied about termination.** `finish()` registered an `onExit` waiter but ignored an
   exit that had already happened, so any child that died during `waitFor`/`settle` was reported as
   **hung**. This produced a confident false claim that the shipped CLI's `config set` never returns
   — contradicted only when I checked the same command with an independent Python `pty.fork` oracle.
   Fourth instance of the session's theme: *green tooling, wrong conclusion.* Now pinned by
   "reports the code of a child that exited BEFORE finish() was called", which I mutation-tested:
   reverting the fix makes it fail.
2. **`os.kill(pid, 0)` on a zombie is a broken liveness oracle.** My first Python checker reported
   every command as hung, including ones node-pty saw exit in 200 ms, because the unreaped child
   still responded to signal 0. `waitpid(WNOHANG)` is the only correct check.
3. **Ink's `key` object has no `name` field, and control chords arrive as `input: 'c'` with
   `key.ctrl`.** My first cut tested `key.name === 'c'`, so Ctrl+C became the letter "c" and the
   prompt hung forever. Same class: backspace arrives as `input: ''` with `key.backspace` — an
   `input.length === 1 && key.backspace` guard is dead code, and the edit is silently lost. Caught
   only by printing what Ink delivers (`SPIKE_DEBUG=1`).
4. **Carry must be keyed by the stream, not the question.** Keying typed-ahead leftovers per question
   loses them, reproducing #99 exactly: `one\rtwo\r` answered Q1, then Q2 waited for input that had
   already arrived. `promptTTY` gets this right for the reason now written into its header.

Also: `node-pty@1.1.0` ships **no Linux prebuild** (only `darwin-*`/`win32-*`), contrary to the note
in #154; on this host it compiled from source via `allowBuilds`. Worth knowing before CI meets it.

---

## Why "no" rather than "yes with caveats"

The seam #153 built is what makes this decision cheap, and the comparison is between two engines,
not between good and bad ideas:

- **`promptTTY` is 175 lines with zero dependencies**, and its reducer is a direct transcription of
  the guarantees: bracketed paste stripped, control bytes dropped, `\r`/`\n`/Ctrl+D terminating with
  the remainder carried, Ctrl+C cancelling, raw mode acquired and released around one read.
- **The Ink port needs all of that anyway.** Because the parser hands over a chunk whose newlines may
  be content or may be Enter, the engine must decide — so my `feed()` scans character by character,
  exactly like the reducer, plus `usePaste` plumbing, plus React state, plus frame-timing handling.
  The spike's engine is 342 lines, still fails three gate rows, and adds `ink` + `react` to the
  input path of a command whose only job is to read one line.
- **The one thing Ink genuinely provides** — native bracketed-paste classification on its own channel
  — is precisely what we cannot rely on it for, because it does not solve the harder half: knowing
  whether a `\r` outside a paste ended the question or belongs to the next one.

So Ink earns its keep where it renders continuously (a dashboard, `watch`, a progress screen — which
is what #106 wanted it for), and the input seam should stay honest about that: `ttyEngine` is the
engine, `inkRenderer` is the screen. Both are already swappable behind #153 without touching a
command.

## What is landed by this branch, and what is not

**Landed** (devDependency + CI-runnable tests, no product behaviour changed):

- `node-pty@1.1.0` as a `@saip/cli` devDependency, compiled from source on Linux (`allowBuilds`).
- `cli/tests/support/pty.ts` — the pty harness, with a falsifiable self-test (16 cases: known exit
  code, known hang, signal-vs-clean death, real `isTTY`/`/dev/tty`, 200 KB verbatim capture, escape
  passthrough, and the isolation rules enforced rather than promised).
- `cli/tests/support/screen.ts` — a small VT model so "the explanation is ABOVE the prompt" is an
  assertion instead of an opinion; 11 self-tests, including one that proves it records sequences it
  does not model rather than swallowing them.
- `cli/tests/support/fake-tty.ts` — a fake that satisfies *both* input styles (Ink pulls
  `read()`/`'readable'`; `promptTTY` pushes `'data'`), because a fake that only does one makes the
  other engine look broken.
- `cli/tests/ink-gate.test.ts` — #154's gate rows, run against both Ink shapes, with the three
  wizard gaps recorded as `it.fails` so they turn red if Ink ever fixes the behaviour.
- `cli/tests/spikes/` — the candidate engines and the probe driver that produced this evidence.

**Not landed**: `promptTTY`'s reducer stays; `ttyEngine` stays the default; no `InkInputEngine` is
registered; `inputKind` still reports `tty`. #106 slice 3's input half should be closed as
*evaluated and rejected*, with the rendering half kept for the dashboard case.

One follow-up worth its own issue, flagged rather than fixed here because it is out of scope for a
spike: `tests/ssh-keys.test.ts` and `tests/ssh-command.test.ts` call `materialiseKey` without
pointing `SAIP_SECRETS_FILE` at a temp dir, so they write into the real `~/.saip/keys`. They fail
where `$HOME` is read-only — which is how this session noticed. That is the same class of leak #154
calls non-negotiable, in a file that predates it.
