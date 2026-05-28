'use strict';

// Host: run this instead of `claude`. It spawns Claude Code inside a pty it owns,
// passes your terminal through both directions, and opens an IPC endpoint so an
// external process can "type" into the live session — including REPL/slash
// commands like /clear. See lib/pipe.js for the endpoint path.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { pipePath, sessionName } = require('./pipe');

// Strip C0 control chars and DEL from injected text. The endpoint hands raw bytes
// to the pty, so without this a single `send` could smuggle Ctrl-C, an embedded
// Enter (multi-submit), or ANSI/mode-switch escapes. We add the submitting Enter
// ourselves. Bypass with ECLAUDE_RAW=1 on the host.
function sanitizeInput(s) {
  return s.replace(/[\x00-\x1F\x7F]/g, '');
}

function loadPty() {
  try {
    return require('@homebridge/node-pty-prebuilt-multiarch');
  } catch (e) {
    try {
      return require('node-pty');
    } catch (e2) {
      process.stderr.write(
        '[eclaude] node-pty is not installed/built.\n' +
          '          Run `bun install` (or `npm install`) first.\n' +
          `          ${e.message}\n`
      );
      process.exit(1);
    }
  }
}

function start(passthroughArgs = []) {
  // Bun can't drive node-pty's I/O on any platform: node-pty wraps the pty fd in
  // an fd-backed stream (`net.Socket({ fd })` for ConPTY input on Windows,
  // `tty.ReadStream(fd)` on POSIX), and Bun's writes to those don't reach the pty
  // (Windows throws ERR_SOCKET_CLOSED; POSIX silently drops them). Spawn + read
  // work, write doesn't — so the host can't type. Transparently re-exec under Node
  // (where the write path works); `eclaude send` still runs natively under Bun.
  if (process.versions.bun) {
    const { spawn } = require('child_process');
    const child = spawn('node', [process.argv[1], 'start', ...passthroughArgs], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', (e) => {
      process.stderr.write(
        e.code === 'ENOENT'
          ? '[eclaude] Bun needs Node to host the session (node-pty write path), ' +
              'but `node` was not found on PATH. Install Node, then retry.\n'
          : `[eclaude] failed to start host under node: ${e.message}\n`
      );
      process.exit(1);
    });
    child.on('exit', (code) => process.exit(code == null ? 0 : code));
    return;
  }

  const CMD = process.env.ECLAUDE_CMD || 'claude';
  const LOG = process.env.ECLAUDE_LOG; // tee pty output to a file (testing)
  const name = sessionName();
  const PIPE_PATH = pipePath(name);
  const isWin = process.platform === 'win32';

  const RAW = !!process.env.ECLAUDE_RAW; // bypass input sanitization

  // A bad ECLAUDE_ENTER_DELAY (NaN) would make setTimeout fire immediately and
  // re-trigger the paste-vs-submit bug, so fall back to the default.
  let enterDelay = parseInt(process.env.ECLAUDE_ENTER_DELAY || '120', 10);
  if (!Number.isFinite(enterDelay) || enterDelay < 0) enterDelay = 120;

  let term; // set once the endpoint is bound and the pty is spawned
  let bound = false; // true only once we own the endpoint (gates cleanup unlink)

  // Writes to the pty can throw synchronously if the inner process already exited
  // (ERR_SOCKET_CLOSED / EPIPE). Never let that crash the host.
  function safeWrite(data) {
    try {
      if (term) term.write(data);
    } catch {}
  }

  // Injection: write text to the endpoint and it gets "typed" + Enter.
  // Claude's Ink TUI treats text + Enter in one write as a *paste* and inserts the
  // newline instead of submitting. So write the text, then send Enter as a separate,
  // slightly-delayed keystroke. ECLAUDE_ENTER_DELAY tunes the gap.
  function inject(text) {
    const line = RAW ? text.replace(/\r?\n$/, '') : sanitizeInput(text);
    if (line.length) safeWrite(line);
    setTimeout(() => safeWrite('\r'), enterDelay); // discrete Enter = submit
  }

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => (buf += d.toString('utf8')));
    sock.on('end', () => {
      if (buf.length) inject(buf);
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      alreadyRunning();
    } else {
      process.stderr.write(`[eclaude] endpoint error: ${e.message}\n`);
      process.exit(1);
    }
  });

  function cleanup() {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {}
    try {
      server.close();
    } catch {}
    // Only remove the socket file if we actually own it — otherwise a refused
    // duplicate would delete the live session's endpoint.
    if (!isWin && bound) {
      try {
        fs.unlinkSync(PIPE_PATH);
      } catch {}
    }
  }
  process.on('exit', cleanup);

  function alreadyRunning() {
    process.stderr.write(
      `[eclaude] a session named "${name}" is already running ` +
        `(endpoint ${PIPE_PATH} in use).\n` +
        `          Set ECLAUDE_PIPE to a different name to run another.\n`
    );
    process.exit(1);
  }

  // Bind the endpoint FIRST. Only spawn Claude once we know this session is unique,
  // so a duplicate `eclaude` never briefly launches a second Claude.
  function bindNow() {
    if (!isWin) {
      // Put the socket in a per-user 0700 directory: other local users can't even
      // traverse into it, so they can't connect. This is more reliable than chmod
      // on the socket file. mkdir mode 0700 is unaffected by a typical umask; chmod
      // covers the case where the dir already existed with looser perms.
      const dir = path.dirname(PIPE_PATH);
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
      } catch {}
      // A stale socket file (crashed prior session) would block listen with
      // EADDRINUSE; we've already confirmed nothing is listening, so remove it.
      try {
        fs.unlinkSync(PIPE_PATH);
      } catch {}
    }
    server.listen(PIPE_PATH, onListen);
  }

  if (isWin) {
    // Named pipes never leave stale files and give a true EADDRINUSE when live.
    bindNow();
  } else {
    // On POSIX a leftover socket file is ambiguous: stale, or a live session?
    // Probe it — if something answers, it's live; if the connection is refused,
    // it's stale and safe to replace. This avoids hijacking a running session.
    const probe = net.connect(PIPE_PATH);
    probe.on('connect', () => {
      probe.destroy();
      alreadyRunning();
    });
    probe.on('error', () => bindNow());
  }

  function onListen() {
    bound = true;
    const pty = loadPty();

    // On Windows `claude` is a .cmd shim CreateProcess can't run directly — route it
    // through the command shell. On POSIX spawn it as-is.
    let file, args;
    if (isWin) {
      file = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', [CMD, ...passthroughArgs].join(' ')];
    } else {
      file = CMD;
      args = passthroughArgs;
    }

    term = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 30,
      cwd: process.cwd(),
      env: process.env,
    });

    const logStream = LOG ? fs.createWriteStream(LOG, { flags: 'a' }) : null;

    // pty output -> our screen (and optional log)
    term.onData((d) => {
      process.stdout.write(d);
      if (logStream) logStream.write(d);
    });

    // our keystrokes -> pty. Raw mode so keys arrive char-by-char, not line-buffered.
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => safeWrite(d.toString('utf8')));

    // keep the pty's size in sync with the real terminal
    process.stdout.on('resize', () => {
      try {
        term.resize(process.stdout.columns || 80, process.stdout.rows || 30);
      } catch {}
    });

    process.stderr.write(
      `[eclaude] session "${name}" live; send with: eclaude send <command> ` +
        `(pid ${process.pid})\n`
    );

    term.onExit(({ exitCode }) => {
      cleanup();
      process.exit(exitCode || 0);
    });
  }
}

module.exports = { start, sanitizeInput };
