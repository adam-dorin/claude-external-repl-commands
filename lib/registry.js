'use strict';

// Tracks live sessions so they can be listed, targeted, and killed. Each host
// writes ~/.eclaude/sessions/<name>.json on start and removes it on exit. The
// file is just a hint — liveness is confirmed by probing the endpoint, and stale
// entries (crashed hosts) are pruned on read.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { pipePath } = require('./pipe');

function dir() {
  return path.join(os.homedir(), '.eclaude', 'sessions');
}
function fileFor(name) {
  return path.join(dir(), encodeURIComponent(name) + '.json');
}

function register(name) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(
      fileFor(name),
      JSON.stringify({
        name,
        pipe: pipePath(name),
        pid: process.pid,
        cwd: process.cwd(),
        startedAt: Date.now(),
      })
    );
  } catch {}
}

function deregister(name) {
  try {
    fs.unlinkSync(fileFor(name));
  } catch {}
}

function readAll() {
  let files = [];
  try {
    files = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')));
    } catch {}
  }
  return out;
}

// Connect to the endpoint with no payload to confirm a host is listening.
function probe(pipe, ms = 600) {
  return new Promise((resolve) => {
    const s = net.connect(pipe);
    let done = false;
    const finish = (live) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {}
      resolve(live);
    };
    s.on('connect', () => {
      s.end();
      finish(true);
    });
    s.on('error', () => finish(false));
    setTimeout(() => finish(false), ms);
  });
}

// Live sessions, sorted by start time; prunes entries whose host is gone.
async function liveSessions() {
  const live = [];
  for (const s of readAll()) {
    if (await probe(s.pipe || pipePath(s.name))) live.push(s);
    else deregister(s.name);
  }
  return live.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// Pick a session for send/kill. explicit wins; else a single live session; else
// "default" if present; else report none/ambiguous.
async function resolveTarget(explicit) {
  if (explicit) return { name: explicit };
  const live = await liveSessions();
  if (live.length === 1) return { name: live[0].name };
  if (live.some((s) => s.name === 'default')) return { name: 'default' };
  if (live.length === 0) return { error: 'none', live };
  return { error: 'ambiguous', live };
}

async function killByName(name) {
  const live = await liveSessions();
  const s = live.find((x) => x.name === name);
  if (!s) return { ok: false };
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(s.pid, 'SIGTERM');
    } catch {}
  }
  deregister(name);
  return { ok: true, pid: s.pid };
}

module.exports = { register, deregister, liveSessions, resolveTarget, killByName };
