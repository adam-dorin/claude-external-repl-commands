'use strict';

// Resolve the IPC endpoint the host listens on and `send` connects to.
// Windows uses a named pipe; POSIX uses a unix-domain socket inside a per-user
// 0700 directory (access control by directory — robust across platforms, unlike
// chmod on the socket file itself). One well-known path per session name gives
// cross-terminal discovery for free: `eclaude send` (any cwd) connects to it.

const os = require('os');
const path = require('path');

function sessionName() {
  return process.env.ECLAUDE_PIPE || 'default';
}

function uidPart() {
  try {
    return typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  } catch {
    return 'user';
  }
}

function pipePath(name = sessionName()) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\eclaude-${name}`;
  return path.join(os.tmpdir(), `eclaude-${uidPart()}`, `${name}.sock`);
}

module.exports = { pipePath, sessionName };
