#!/usr/bin/env node
'use strict';

// eclaude — drive a live, interactive Claude Code session from outside.
//   eclaude                  start the interactive session (host Claude in a pty)
//   eclaude start [args...]  same, passing extra args through to `claude`
//   eclaude send <command>   inject a REPL/slash command (e.g. /clear) into it

const USAGE = [
  'eclaude — external control for an interactive Claude Code session',
  '',
  'Usage:',
  '  eclaude                  start the session (host `claude` in a pty)',
  '  eclaude start [args...]  start, passing extra args through to `claude`',
  '  eclaude send <command>   send a REPL/slash command into the session',
  '',
  'Examples:',
  '  eclaude',
  '  eclaude start --model opus',
  '  eclaude send /clear',
  '  eclaude send /compact',
  '',
  'Env:',
  '  ECLAUDE_PIPE         session name (default: "default")',
  '  ECLAUDE_ENTER_DELAY  ms between typed text and Enter (default: 120)',
  '  ECLAUDE_CMD          command to host (default: "claude")',
  '  ECLAUDE_RAW=1        disable Git-Bash slash-arg fixup (Windows)',
].join('\n');

const argv = process.argv.slice(2);
const first = argv[0];

if (first === undefined || first === 'start') {
  require('../lib/host').start(first === 'start' ? argv.slice(1) : []);
} else if (first === 'send') {
  require('../lib/send').send(argv.slice(1));
} else if (first === '--help' || first === '-h') {
  console.log(USAGE);
} else if (first === '--version' || first === '-v') {
  console.log(require('../package.json').version);
} else {
  // Unknown command — error instead of silently starting a session (a typo'd
  // `send` must not launch a host). Pass claude flags via `eclaude start <args>`.
  process.stderr.write(`eclaude: unknown command "${first}"\n\n${USAGE}\n`);
  process.exit(2);
}
