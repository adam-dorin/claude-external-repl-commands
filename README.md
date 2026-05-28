# eclaude

[![npm](https://img.shields.io/npm/v/eclaude)](https://www.npmjs.com/package/eclaude)
[![CI](https://github.com/adam-dorin/claude-external-repl-commands/actions/workflows/ci.yml/badge.svg)](https://github.com/adam-dorin/claude-external-repl-commands/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/eclaude)](LICENSE)

Drive a **live, interactive Claude Code session** from outside it. Host `claude`
inside a pseudo-terminal you own, then push REPL/slash commands — like `/clear` or
`/compact` — into the running session from any other terminal.

```
  eclaude send /clear ─▶ endpoint ─▶ eclaude host (pty) ─▶ claude
   (any terminal)        (pipe/sock)      ▲                  │
                                          └──── pty I/O ──────┘
                                                   ▼
                                              your screen
```

`claude` can't be cleared programmatically: `/clear` is interactive-only, and no
hook/flag invokes it. `eclaude` *owns the terminal* Claude runs in (via a ConPTY on
Windows / a pty on POSIX, using a small first-party native addon) and opens a small IPC
endpoint. Anything sent there is "typed" into the session followed by Enter. That's your
`send-keys`.

## Disclosure

This utility was built with [Claude Code](https://claude.com/claude-code).

## Install

```sh
npm install -g eclaude      # or: bun add -g eclaude
```

The pty is a **first-party native addon** bundled as a prebuilt `.node` per platform —
no third-party dependency, no postinstall, and no compiler/toolchain needed at install
time. (`claude` itself must be on your PATH.)

## Use

**1. Start a session** (run this instead of `claude`):

```sh
eclaude                     # or: eclaude start --model opus  (extra args go to claude)
```

You'll see `[eclaude] session "default" live …`, then Claude's normal UI.

**2. Send a REPL command** — from any other terminal, any working directory:

```sh
eclaude send /clear
eclaude send /compact
eclaude send "summarize what we just did"
```

The command lands in the live session and submits.

## Why

Claude's slash commands are interactive-only — no flag, setting, or hook can invoke
`/clear`, `/compact`, etc. `eclaude` lets an **external trigger** drive them: anything
that can run a command can now steer the live session. For example, clear it whenever a
trigger file changes:

```sh
# Linux/macOS: clear the session each time ./trigger is touched
while inotifywait -qe modify ./trigger; do eclaude send /clear; done
```

Other triggers: a Claude Code **Stop hook**, a file watcher, a CI step, an editor task,
or a cron job — all just shell out to `eclaude send`.

## Commands

| Command | Does |
|---------|------|
| `eclaude` / `eclaude start [args]` | Start the session; extra args pass through to `claude`. |
| `eclaude send <command>` | Inject `<command>` (+ Enter) into the running session. |
| `eclaude --help` / `--version` | Usage / version. |

## Runtimes: Node and Bun

Both run the host **natively** — no re-exec, no runtime dependency.

- The pty is a **first-party native addon** (`native/`, Rust + N-API: `forkpty` on POSIX,
  ConPTY on Windows), bundled as a prebuilt `.node` per platform. N-API is built into Node
  and supported by Bun, so the same binary loads under both.
- The host does **raw** read/write on the pty (no fd-backed streams), which is what lets
  it run under Bun — where node-pty's stream wrapping could not.

> **Platform status:** developed and verified on **Windows** (incl. a live Claude session)
> and Linux, under both Node and Bun. macOS is exercised by CI (`win/linux/mac × node/bun`)
> but not yet hand-tested against live Claude — please report issues.

```sh
bun regression.js     # full suite (no Claude/TTY needed)
node regression.js
bun smoke-test.js     # quick end-to-end check
```

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `ECLAUDE_PIPE` | `default` | Session name. Use distinct names to run parallel sessions. |
| `ECLAUDE_ENTER_DELAY` | `120` | ms between typed text and the Enter keystroke (paste-vs-submit tuning). |
| `ECLAUDE_CMD` | `claude` | Command to host inside the pty. |
| `ECLAUDE_RAW` | _(off)_ | `1` disables the Git-Bash leading-slash fixup in `send` (Windows) and, on the host, disables input sanitization (sends raw bytes). |
| `ECLAUDE_LOG` | _(off)_ | Tee pty output to a file (used by the smoke test). |

## Security / trust model

`eclaude send` doesn't shell-execute anything — it types your text into Claude's TTY
and presses Enter. The trust boundary is **who can reach the endpoint**: anyone able to
open the pipe/socket gets full keyboard control of your session (and Claude may then
edit files or run commands on your behalf).

- The endpoint is **local only** — Windows named pipes reject remote clients; the POSIX
  socket is a filesystem socket, not a network port.
- The POSIX socket lives in a per-user `0700` directory (`$TMPDIR/eclaude-<uid>/`), so
  other local users can't traverse to it; the Windows named pipe is same-user only.
  So another **local user** can't inject — but any process **running as you** can.
- Injected text is **sanitized** by default (C0 control chars / embedded Enter / ANSI
  escapes stripped) so a single `send` can't smuggle Ctrl-C, multi-submit, or terminal
  escapes. Only the Enter `eclaude` adds submits. Set `ECLAUDE_RAW=1` on the host to send
  raw bytes.
- **Don't run `eclaude` on a shared/multi-user machine** expecting isolation beyond the
  same-user boundary above.

## Gotchas

- **`claude` must be on PATH** — `eclaude` spawns it. `eclaude send` errors clearly if
  no host is running.
- **One session per name.** A second `eclaude` on the same name fails (endpoint in
  use); set `ECLAUDE_PIPE` for another.
- **Enter is `\r`** in a pty (Claude's Ink TUI expects it), sent as a discrete keystroke
  after `ECLAUDE_ENTER_DELAY` so text isn't treated as a multiline paste.
- **Git Bash mangles `/clear`.** MSYS rewrites a leading-slash arg into a path; `send`
  collapses it back on Windows (disable with `ECLAUDE_RAW=1`). PowerShell is unaffected.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `no running session named "default"` | No host is running (or a different `ECLAUDE_PIPE`). Start `eclaude` first; use the same `ECLAUDE_PIPE` for host and `send`. |
| Host exits immediately / `claude` not found | `claude` isn't on PATH. Install Claude Code, or point `ECLAUDE_CMD` at the right command. |
| `native PTY addon not available for <platform>` | The prebuilt `.node` for your platform/arch isn't present. From a checkout, build it: `npm run build:native` (needs the Rust toolchain). |
| Sent text appears but doesn't submit (or pastes as multiline) | Tune the Enter timing: raise `ECLAUDE_ENTER_DELAY` (e.g. `250`). |
