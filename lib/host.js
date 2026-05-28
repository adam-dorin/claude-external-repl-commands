'use strict';

// Host: run this instead of `claude`. Spawns Claude inside a pty (via the first-party
// native addon in ../native), passes your terminal through both directions, and opens
// an IPC endpoint so `eclaude send` can "type" into the live session. See lib/pipe.js.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { pipePath, sessionName } = require('./pipe');
const registry = require('./registry');

// Strip C0 control chars and DEL from injected text. The endpoint hands raw bytes to
// the pty, so without this a single `send` could smuggle Ctrl-C, an embedded Enter
// (multi-submit), or ANSI/mode-switch escapes. We add the submitting Enter ourselves.
// Bypass with ECLAUDE_RAW=1 on the host.
function sanitizeInput(s) {
  return s.replace(/[\x00-\x1F\x7F]/g, '');
}

function loadPty() {
  try {
    return require('../native'); // first-party addon, exports { Pty }
  } catch (e) {
    process.stderr.write(
      `[eclaude] native PTY addon not available for ${process.platform}-${process.arch}.\n` +
        '          Build it: cargo build --release --manifest-path native/Cargo.toml ' +
        '&& node native/stage.cjs\n' +
        `          ${e.message}\n`
    );
    process.exit(1);
  }
}

function start(passthroughArgs = [], explicitName) {
  const CMD = process.env.ECLAUDE_CMD || 'claude';
  const LOG = process.env.ECLAUDE_LOG; // tee pty output to a file (testing)
  const name = explicitName || sessionName();
  const PIPE_PATH = pipePath(name);
  const isWin = process.platform === 'win32';

  const RAW = !!process.env.ECLAUDE_RAW; // bypass input sanitization

  // A bad ECLAUDE_ENTER_DELAY (NaN) would make setTimeout fire immediately and
  // re-trigger the paste-vs-submit bug, so fall back to the default.
  let enterDelay = parseInt(process.env.ECLAUDE_ENTER_DELAY || '120', 10);
  if (!Number.isFinite(enterDelay) || enterDelay < 0) enterDelay = 120;

  let term; // set once the endpoint is bound and the pty is spawned
  let bound = false; // true only once we own the endpoint (gates cleanup unlink)

  // The addon's write() takes a Buffer. Writes can throw if the child already exited;
  // never let that crash the host.
  function safeWrite(data) {
    try {
      if (term) term.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
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
    if (bound) registry.deregister(name);
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
      // traverse into it, so they can't connect.
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

  // Detect a live session by probing the endpoint, not by interpreting listen()
  // errors — `connect` behaves the same across Node and Bun, while their listen
  // error codes differ (Node: EADDRINUSE; Bun: a generic message). If something
  // answers, a session is live; if the connection is refused/absent, bind.
  // (On POSIX this also distinguishes a live socket from a stale leftover file.)
  const probe = net.connect(PIPE_PATH);
  probe.on('connect', () => {
    probe.destroy();
    alreadyRunning();
  });
  probe.on('error', () => bindNow());

  function onListen() {
    bound = true;
    registry.register(name);
    const { Pty } = loadPty();

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

    const logStream = LOG ? fs.createWriteStream(LOG, { flags: 'a' }) : null;

    // The child inherits our environment (incl. TERM); the addon spawns it on a real
    // pty so Claude's TUI works. onData/onExit are passed at spawn time.
    term = Pty.spawn(
      file,
      args,
      process.stdout.columns || 80,
      process.stdout.rows || 30,
      process.cwd(),
      (data) => {
        process.stdout.write(data);
        if (logStream) logStream.write(data);
      },
      (code) => {
        cleanup();
        process.exit(code || 0);
      }
    );

    // our keystrokes -> pty. Raw mode so keys arrive char-by-char, not line-buffered.
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => safeWrite(d));

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
  }
}

module.exports = { start, sanitizeInput };
