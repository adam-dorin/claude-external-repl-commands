#!/usr/bin/env node
'use strict';

// Regression suite for eclaude. Covers every behavior fixed/hardened so far:
//   - CLI dispatch (start/send/meta) + strict unknown-command handling
//   - `send` errors (no host, no args)
//   - host end-to-end injection (the core feature)
//   - NaN ECLAUDE_ENTER_DELAY guard (host must not break/crash)
//   - duplicate-session detection (no stray Claude, clean exit 1)
//   - pipe-path resolution
//   - Git-Bash slash fixup (send.normalizeCommand)
//   - input sanitization (host.sanitizeInput)
//   - POSIX socket perms (0600)
// Runs identically under Node and Bun: `node regression.js` / `bun regression.js`.
// Children are spawned with the SAME runtime, and only ever killed by their own PID.

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const RUNTIME = process.execPath; // node or bun, whichever ran this file
const BIN = path.join(__dirname, 'bin', 'eclaude.js');
const isWin = process.platform === 'win32';
const VERSION = require('./package.json').version;
const { pipePath } = require('./lib/pipe');
const { normalizeCommand } = require('./lib/send');
const { sanitizeInput } = require('./lib/host');

const QUICK_CMD = isWin ? 'hostname' : 'true'; // exits immediately -> host exits 0
let seq = 0;
const uid = () => Date.now().toString(36) + '_' + seq++;

// ---- tiny harness ------------------------------------------------------------
let pass = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ', name);
  } catch (e) {
    failures.push([name, e]);
    console.log('  FAIL ', name, '\n          ' + (e && e.message));
  }
}

// ---- helpers -----------------------------------------------------------------
function cli(args, env = {}) {
  return spawnSync(RUNTIME, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...env },
  });
}

function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch {}
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function waitReady(name, ms = 8000) {
  const target = pipePath(name);
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const s = net.connect(target);
      s.on('connect', () => {
        s.destroy();
        resolve();
      });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error('host never became ready'));
        else setTimeout(attempt, 150);
      });
    })();
  });
}

function waitMarker(log, marker, ms = 10000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const t = setInterval(() => {
      let out = '';
      try {
        out = fs.readFileSync(log, 'utf8');
      } catch {}
      if (out.includes(marker)) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() > deadline) {
        clearInterval(t);
        resolve(false);
      }
    }, 200);
  });
}

// Start a host wrapping a shell, send a marker command, return whether it landed.
async function e2eSend(extraEnv = {}) {
  const name = 'e2e' + uid();
  const log = path.join(os.tmpdir(), 'eclaude-test-' + name + '.log');
  const marker = 'RX_' + uid();
  const runLine = isWin ? `echo ${marker} & exit` : `echo ${marker}; exit`;
  try {
    fs.unlinkSync(log);
  } catch {}
  const env = {
    ...process.env,
    ECLAUDE_PIPE: name,
    ECLAUDE_CMD: isWin ? 'cmd.exe' : 'sh',
    ECLAUDE_LOG: log,
    ...extraEnv,
  };
  const host = spawn(RUNTIME, [BIN, 'start'], { env, stdio: 'ignore' });
  try {
    await waitReady(name);
    const r = spawnSync(RUNTIME, [BIN, 'send', runLine], { env, timeout: 15000, encoding: 'utf8' });
    const seen = await waitMarker(log, marker);
    return { seen, sendStatus: r.status };
  } finally {
    killTree(host.pid);
    try {
      fs.unlinkSync(log);
    } catch {}
  }
}

// Temporarily set env vars around a fn, restoring previous values.
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ---- tests -------------------------------------------------------------------
async function main() {
  console.log(`regression: runtime=${path.basename(RUNTIME)} platform=${process.platform}\n`);

  // -- unit: pipe-path resolution --
  await test('pipePath formats per platform', () => {
    const p = pipePath('xyz');
    if (isWin) assert.strictEqual(p, '\\\\.\\pipe\\eclaude-xyz');
    else {
      assert.ok(p.startsWith(os.tmpdir()), p);
      assert.ok(p.endsWith('eclaude-xyz.sock'), p);
    }
  });

  // -- unit: send.normalizeCommand (Git-Bash slash fixup) --
  await test('normalizeCommand leaves plain text alone', () => {
    assert.strictEqual(normalizeCommand('hello world'), 'hello world');
    assert.strictEqual(normalizeCommand('/clear'), '/clear');
  });
  if (isWin) {
    await test('normalizeCommand collapses MSYS-mangled slash command (win)', () => {
      assert.strictEqual(normalizeCommand('C:/Program Files/Git/clear'), '/clear');
    });
    await test('normalizeCommand respects ECLAUDE_RAW (win)', () => {
      withEnv({ ECLAUDE_RAW: '1' }, () => {
        assert.strictEqual(
          normalizeCommand('C:/Program Files/Git/clear'),
          'C:/Program Files/Git/clear'
        );
      });
    });
  } else {
    await test('normalizeCommand is a no-op off Windows', () => {
      assert.strictEqual(
        normalizeCommand('C:/Program Files/Git/clear'),
        'C:/Program Files/Git/clear'
      );
    });
  }

  // -- unit: host.sanitizeInput --
  await test('sanitizeInput strips control chars but keeps printable', () => {
    assert.strictEqual(sanitizeInput('a\x03b'), 'ab'); // Ctrl-C
    assert.strictEqual(sanitizeInput('line1\nline2'), 'line1line2'); // embedded Enter
    assert.strictEqual(sanitizeInput('\x1b[31mred\x1b[0m'), '[31mred[0m'); // ANSI ESC
    assert.strictEqual(sanitizeInput('/clear'), '/clear');
    assert.strictEqual(sanitizeInput('summarize this'), 'summarize this');
  });

  // -- CLI dispatch: meta flags --
  await test('--version / -v print the package version', () => {
    for (const flag of ['--version', '-v']) {
      const r = cli([flag]);
      assert.strictEqual(r.status, 0, `${flag} status`);
      assert.strictEqual(r.stdout.trim(), VERSION, `${flag} stdout`);
    }
  });
  await test('--help / -h print usage', () => {
    for (const flag of ['--help', '-h']) {
      const r = cli([flag]);
      assert.strictEqual(r.status, 0, `${flag} status`);
      assert.ok(/Usage:/.test(r.stdout) && /eclaude send/.test(r.stdout), `${flag} body`);
    }
  });

  // -- CLI dispatch: strict unknown-command (the footgun fix) --
  await test('unknown verb errors (exit 2), does NOT start a host', () => {
    const r = cli(['sedn']);
    assert.strictEqual(r.status, 2);
    assert.ok(/unknown command "sedn"/.test(r.stderr), r.stderr);
    assert.ok(!/session .* live/.test(r.stderr + r.stdout), 'must not have started a session');
  });
  await test('unknown flag errors (exit 2)', () => {
    const r = cli(['--bogus']);
    assert.strictEqual(r.status, 2);
    assert.ok(/unknown command/.test(r.stderr), r.stderr);
  });

  // -- send errors --
  await test('send with no args errors (exit 2)', () => {
    const r = cli(['send']);
    assert.strictEqual(r.status, 2);
    assert.ok(/usage: eclaude send/.test(r.stderr), r.stderr);
  });
  await test('send with no running host errors clearly (exit 1)', () => {
    const r = cli(['send', '/clear'], { ECLAUDE_PIPE: 'nohost' + uid() });
    assert.strictEqual(r.status, 1);
    assert.ok(/no running session/.test(r.stderr), r.stderr);
  });

  // -- CLI dispatch: start routing exits cleanly with a fast inner command --
  await test('`start` routes to host and exits 0 when inner exits', () => {
    const r = cli(['start'], { ECLAUDE_PIPE: 'st' + uid(), ECLAUDE_CMD: QUICK_CMD });
    assert.strictEqual(r.status, 0, r.stderr);
  });
  await test('bare `eclaude` (no args) routes to host', () => {
    const r = cli([], { ECLAUDE_PIPE: 'st' + uid(), ECLAUDE_CMD: QUICK_CMD });
    assert.strictEqual(r.status, 0, r.stderr);
  });

  // -- host end-to-end: the core feature --
  await test('e2e: send delivers a command into the live session', async () => {
    const { seen, sendStatus } = await e2eSend();
    assert.strictEqual(sendStatus, 0, 'send exit code');
    assert.ok(seen, 'marker did not appear in pty output');
  });

  // -- regression: NaN ENTER_DELAY must not crash the host / break submit --
  await test('e2e: garbage ECLAUDE_ENTER_DELAY still submits (NaN guard)', async () => {
    const { seen } = await e2eSend({ ECLAUDE_ENTER_DELAY: 'oops' });
    assert.ok(seen, 'host broke or did not submit with bad ENTER_DELAY');
  });

  // -- regression: duplicate session -> clean exit 1, no stray Claude --
  await test('duplicate session is refused (exit 1), spawns no Claude', async () => {
    const name = 'dup' + uid();
    const p = pipePath(name);
    if (!isWin) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    const occ = net.createServer();
    await new Promise((res, rej) => {
      occ.once('error', rej);
      occ.listen(p, res);
    });
    if (!isWin) {
      try {
        fs.chmodSync(p, 0o600);
      } catch {}
    }
    try {
      const r = cli(['start'], { ECLAUDE_PIPE: name, ECLAUDE_CMD: QUICK_CMD });
      assert.strictEqual(r.status, 1, 'duplicate should exit 1');
      assert.ok(/already running/.test(r.stderr), r.stderr);
    } finally {
      occ.close();
      if (!isWin) {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }
  });

  // -- hardening: POSIX socket is owner-only (0600) --
  if (!isWin) {
    await test('POSIX socket is chmod 0600', async () => {
      const name = 'perm' + uid();
      const log = path.join(os.tmpdir(), 'eclaude-test-' + name + '.log');
      const env = { ...process.env, ECLAUDE_PIPE: name, ECLAUDE_CMD: 'sleep 5', ECLAUDE_LOG: log };
      const host = spawn(RUNTIME, [BIN, 'start'], { env, stdio: 'ignore' });
      try {
        await waitReady(name);
        const mode = fs.statSync(pipePath(name)).mode & 0o777;
        assert.strictEqual(mode, 0o600, 'mode is 0' + mode.toString(8));
      } finally {
        killTree(host.pid);
        try {
          fs.unlinkSync(log);
        } catch {}
        try {
          fs.unlinkSync(pipePath(name));
        } catch {}
      }
    });
  }

  // ---- summary ----
  const total = pass + failures.length;
  console.log(`\n${pass}/${total} passed.`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const [name] of failures) console.log('  - ' + name);
    process.exit(1);
  }
  console.log('ALL REGRESSION TESTS PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('regression runner crashed:', e);
  process.exit(1);
});
