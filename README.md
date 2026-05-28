# eclaude

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
Windows / a pty on POSIX, using [node-pty]) and opens a small IPC endpoint. Anything
sent there is "typed" into the session followed by Enter. That's your `send-keys`.

## Disclosure

This utility was built with [Claude Code](https://claude.com/claude-code).

## Install

```sh
npm install -g eclaude      # or: bun add -g eclaude
```

Ships a prebuilt `node-pty`, so no C++ toolchain is needed.

> **Bun note:** the native pty postinstall must be allowed. This package declares
> `trustedDependencies`, so `bun install` runs it automatically. If pty fails to
> load, run `bun pm trust @homebridge/node-pty-prebuilt-multiarch`.

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

## Commands

| Command | Does |
|---------|------|
| `eclaude` / `eclaude start [args]` | Start the session; extra args pass through to `claude`. |
| `eclaude send <command>` | Inject `<command>` (+ Enter) into the running session. |
| `eclaude --help` / `--version` | Usage / version. |

## Runtimes: Node and Bun

Both are supported; Bun is fine for day-to-day use.

- **`eclaude send`** runs natively under Node and Bun on all platforms.
- **The host** writes to the pty, and Bun can't drive node-pty's fd-backed I/O on
  **any** platform (Windows throws, POSIX silently drops writes). So under Bun the host
  **transparently re-execs under Node** — automatic, but it requires `node` on PATH.
  Under Node the host runs directly.

> **Platform status:** developed and manually verified on **Windows** (including against
> a live Claude session). macOS/Linux are exercised by CI (`win/linux/mac × node/bun`,
> running the regression suite) but not yet hand-tested against live Claude — please
> report issues.

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
- The POSIX socket is `chmod 0600` (owner-only); the Windows named pipe is same-user
  only. So another **local user** can't inject — but any process **running as you** can.
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

[node-pty]: https://github.com/microsoft/node-pty
