'use strict';

// Send a command (typed + Enter) into a running `eclaude` session.
// Used for REPL/slash commands like /clear, /compact — but any text works.

const net = require('net');
const { pipePath, sessionName } = require('./pipe');

// Git Bash / MSYS (Windows) rewrites a leading-slash arg like `/clear` into an
// absolute path such as `C:/Program Files/Git/clear` before we see it. You never
// send a bare filesystem path here, so collapse that back to `/command`.
// Set ECLAUDE_RAW=1 to disable. No-op off Windows.
function normalizeCommand(text) {
  if (process.platform === 'win32' && !process.env.ECLAUDE_RAW) {
    const m = text.match(/^[A-Za-z]:[\\/].*[\\/]([A-Za-z][\w-]*)$/);
    if (m) return '/' + m[1];
  }
  return text;
}

function send(argv = []) {
  const text = argv.join(' ');

  if (!text) {
    process.stderr.write('usage: eclaude send <command>\n');
    process.exit(2);
  }

  const name = sessionName();
  const sock = net.connect(pipePath(name));
  sock.on('connect', () => sock.end(normalizeCommand(text)));
  sock.on('error', (e) => {
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      process.stderr.write(
        `eclaude: no running session named "${name}". ` +
          `Start one with \`eclaude\` first.\n`
      );
    } else {
      process.stderr.write(`eclaude send failed: ${e.message}\n`);
    }
    process.exit(1);
  });
}

module.exports = { send, normalizeCommand };
