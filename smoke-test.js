#!/usr/bin/env node
'use strict';

// smoke-test.js — verifies the whole send -> endpoint -> pty -> program path
// WITHOUT needing Claude or an interactive TTY. It launches the eclaude host
// wrapping a plain shell, runs `eclaude send "<echo marker; exit>"`, and checks
// the command actually ran. Runs under the same runtime that invoked it
// (`node smoke-test.js` or `bun smoke-test.js`).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
const RUNTIME = process.execPath; // node or bun, whichever ran this file
const BIN = path.join(__dirname, 'bin', 'eclaude.js');
const PIPE = 'smoke';
const LOG = path.join(__dirname, 'smoke.log');
const MARKER = 'ECLAUDE_OK_' + Date.now();

// Inner shell + a one-shot command that prints the marker then exits the shell.
const INNER_CMD = isWin ? 'cmd.exe' : 'sh';
const RUN_LINE = isWin ? `echo ${MARKER} & exit` : `echo ${MARKER}; exit`;

const childEnv = {
  ...process.env,
  ECLAUDE_CMD: INNER_CMD,
  ECLAUDE_PIPE: PIPE,
  ECLAUDE_LOG: LOG,
};

try {
  fs.unlinkSync(LOG);
} catch {}

const host = spawn(RUNTIME, [BIN, 'start'], {
  env: childEnv,
  stdio: ['ignore', 'ignore', 'inherit'],
});

let done = false;
function finish(ok, msg) {
  if (done) return;
  done = true;
  try {
    host.kill();
  } catch {}
  if (ok) {
    console.log('SMOKE TEST PASSED:', msg);
    process.exit(0);
  } else {
    console.error('SMOKE TEST FAILED:', msg);
    process.exit(1);
  }
}

// Once the host has had a moment to open its endpoint, send the command via the
// real `eclaude send` path. Retry a few times in case the host is still starting.
let attempts = 0;
function trySend() {
  attempts++;
  const s = spawn(RUNTIME, [BIN, 'send', RUN_LINE], { env: childEnv, stdio: 'ignore' });
  s.on('exit', (code) => {
    if (code !== 0 && attempts < 40) setTimeout(trySend, 250);
  });
}
setTimeout(trySend, 600);

// Poll the log for our marker.
const deadline = Date.now() + 15000;
const poll = setInterval(() => {
  let out = '';
  try {
    out = fs.readFileSync(LOG, 'utf8');
  } catch {}
  if (out.includes(MARKER)) {
    clearInterval(poll);
    finish(true, `injected command executed; saw "${MARKER}" in pty output`);
  } else if (Date.now() > deadline) {
    clearInterval(poll);
    finish(false, 'timed out waiting for injected command output');
  }
}, 300);
