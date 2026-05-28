'use strict';

// Resolve the IPC endpoint the host listens on and `send` connects to.
// Windows uses a named pipe; POSIX uses a unix-domain socket in the temp dir.
// One well-known path per session name = cross-terminal discovery for free:
// `eclaude send` (run from any cwd) just connects to the known path.

const os = require('os');
const path = require('path');

function sessionName() {
  return process.env.ECLAUDE_PIPE || 'default';
}

function pipePath(name = sessionName()) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\eclaude-${name}`;
  return path.join(os.tmpdir(), `eclaude-${name}.sock`);
}

module.exports = { pipePath, sessionName };
