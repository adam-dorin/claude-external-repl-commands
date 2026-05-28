'use strict';

// Send a command (typed + Enter) into a running `eclaude` session.
// Used for REPL/slash commands like /clear, /compact — but any text works.

const net = require('net');
const { pipePath } = require('./pipe');
const registry = require('./registry');

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

async function send(argv = [], explicitName) {
  const text = argv.join(' ');
  if (!text) {
    process.stderr.write('usage: eclaude send [-s <session>] <command>\n');
    process.exit(2);
  }

  // Explicit target (‑s flag or ECLAUDE_PIPE) wins; otherwise auto-route.
  let name = explicitName || process.env.ECLAUDE_PIPE;
  if (!name) {
    const t = await registry.resolveTarget();
    if (t.error === 'none') {
      process.stderr.write('eclaude: no running session. Start one with `eclaude` first.\n');
      process.exit(1);
    }
    if (t.error === 'ambiguous') {
      process.stderr.write(
        'eclaude: multiple sessions running — pick one with -s <name>:\n' +
          t.live.map((s) => `  ${s.name}  (pid ${s.pid}, ${s.cwd})`).join('\n') +
          '\n'
      );
      process.exit(1);
    }
    name = t.name;
  }

  const sock = net.connect(pipePath(name));
  sock.on('connect', () => sock.end(normalizeCommand(text)));
  sock.on('error', (e) => {
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      process.stderr.write(
        `eclaude: no running session named "${name}". Start one with \`eclaude\` first.\n`
      );
    } else {
      process.stderr.write(`eclaude send failed: ${e.message}\n`);
    }
    process.exit(1);
  });
}

module.exports = { send, normalizeCommand };
