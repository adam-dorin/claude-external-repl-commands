#!/usr/bin/env node
'use strict';

// eclaude — drive live, interactive Claude Code sessions from outside.

const USAGE = [
  'eclaude — external control for interactive Claude Code sessions',
  '',
  'Usage:',
  '  eclaude [start] [-s <name>] [claude args]   start a session (host `claude` in a pty)',
  '  eclaude send [-s <name>] <command>          send a REPL/slash command into a session',
  '  eclaude list                                list running sessions',
  '  eclaude kill [<name>]                       stop a session (the only one, if unnamed)',
  '  eclaude --help | --version',
  '',
  'Sessions:',
  '  Name a session with -s/--session (or ECLAUDE_PIPE); the default name is "default".',
  '  `send`/`kill` auto-target the sole running session; with several, pass -s <name>.',
  '',
  'Examples:',
  '  eclaude',
  '  eclaude -s work',
  '  eclaude start -s work --model opus',
  '  eclaude send /clear',
  '  eclaude send -s work /compact',
  '  eclaude list',
  '  eclaude kill work',
  '',
  'Env:',
  '  ECLAUDE_PIPE         session name (default: "default"; -s overrides)',
  '  ECLAUDE_ENTER_DELAY  ms between typed text and Enter (default: 120)',
  '  ECLAUDE_CMD          command to host (default: "claude")',
  '  ECLAUDE_RAW=1        disable Git-Bash slash-arg fixup + input sanitization',
].join('\n');

// Pull -s/--session (and =forms) out of an arg list, returning {session, rest}.
function extractSession(args) {
  let session;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '--session') session = args[++i];
    else if (a.startsWith('--session=')) session = a.slice('--session='.length);
    else if (a.startsWith('-s=')) session = a.slice('-s='.length);
    else rest.push(a);
  }
  return { session, rest };
}

function list() {
  require('../lib/registry').liveSessions().then((live) => {
    if (!live.length) {
      console.log('No running sessions.');
      return;
    }
    const now = Date.now();
    for (const s of live) {
      const up = Math.max(0, Math.round((now - (s.startedAt || now)) / 1000));
      console.log(`${s.name}\tpid ${s.pid}\tup ${up}s\t${s.cwd}`);
    }
  });
}

function doKill(name) {
  require('../lib/registry').killByName(name).then((r) => {
    if (r.ok) console.log(`killed session "${name}" (pid ${r.pid})`);
    else {
      console.error(`eclaude: no running session named "${name}".`);
      process.exit(1);
    }
  });
}

function kill(name) {
  if (name) return doKill(name);
  require('../lib/registry').liveSessions().then((live) => {
    if (live.length === 1) doKill(live[0].name);
    else if (live.length === 0) {
      console.error('eclaude: no running session to kill.');
      process.exit(1);
    } else {
      console.error(
        'eclaude: multiple sessions — name one: eclaude kill <name>\n' +
          live.map((s) => '  ' + s.name).join('\n')
      );
      process.exit(1);
    }
  });
}

const argv = process.argv.slice(2);
const first = argv[0];
const tail = argv.slice(1);

if (first === '--help' || first === '-h') {
  console.log(USAGE);
} else if (first === '--version' || first === '-v') {
  console.log(require('../package.json').version);
} else if (first === 'send') {
  const { session, rest } = extractSession(tail);
  require('../lib/send').send(rest, session);
} else if (first === 'start') {
  const { session, rest } = extractSession(tail);
  require('../lib/host').start(rest, session);
} else if (first === 'list') {
  list();
} else if (first === 'kill') {
  const { session, rest } = extractSession(tail);
  kill(rest[0] || session);
} else if (first === undefined || first.startsWith('-')) {
  // Bare start: only -s/--session is accepted here. Stray flags must go through
  // `eclaude start <flags>`, so a typo can't silently launch Claude with bad args.
  const { session, rest } = extractSession(argv);
  if (rest.length === 0) {
    require('../lib/host').start([], session);
  } else {
    process.stderr.write(
      `eclaude: unknown option(s): ${rest.join(' ')}\n` +
        `  to pass args to claude, use: eclaude start ${rest.join(' ')}\n\n${USAGE}\n`
    );
    process.exit(2);
  }
} else {
  // Unknown non-flag word — error instead of silently starting (typo'd `send`, etc.).
  process.stderr.write(`eclaude: unknown command "${first}"\n\n${USAGE}\n`);
  process.exit(2);
}
