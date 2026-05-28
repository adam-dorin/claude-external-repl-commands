# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.1.1] - 2026-05-28

### Changed
- Docs only: README badges (npm / CI / license), a "Why" use-case section, and a
  Troubleshooting table; added this changelog. Republished so the npm package page
  reflects the updated README. No code changes.

## [0.1.0] - 2026-05-28

Initial release.

### Added
- `eclaude` / `eclaude start [args]` — host an interactive Claude Code session in a pty
  (ConPTY on Windows), passing extra args through to `claude`.
- `eclaude send <command>` — inject a REPL/slash command (e.g. `/clear`, `/compact`) into
  the running session from any terminal or working directory.
- `eclaude --help` / `--version`.
- Cross-platform: Windows, macOS, Linux; runs under Node and Bun. Under Bun the host
  transparently re-execs under Node (Bun can't drive node-pty's fd-backed I/O); `send`
  runs natively under Bun.
- Input sanitization (strips control chars / embedded Enter / ANSI escapes by default;
  `ECLAUDE_RAW=1` to bypass).
- POSIX socket isolated in a per-user `0700` directory; Windows named pipe is same-user.
- Regression suite (`npm test` / `bun regression.js`) and CI across
  `win/linux/mac × node/bun`.

[0.1.1]: https://github.com/adam-dorin/claude-external-repl-commands/releases/tag/v0.1.1
[0.1.0]: https://github.com/adam-dorin/claude-external-repl-commands/releases/tag/v0.1.0
