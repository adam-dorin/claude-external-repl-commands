'use strict';
// Standalone check for the native PTY addon: spawn a shell, inject a command once
// the reader is established, confirm its output comes back. Cross-platform.
const assert = require('assert');
const { Pty } = require('./index.js');

const isWin = process.platform === 'win32';
const shell = isWin ? 'cmd.exe' : 'sh';
const line = `echo ADDON_OK${isWin ? ' & exit' : '; exit'}${isWin ? '\r' : '\n'}`;

let out = '';
let exited = null;
const pty = Pty.spawn(
  shell,
  [],
  80,
  30,
  undefined,
  (data) => {
    out += data.toString();
  },
  (code) => {
    exited = code;
  }
);

// Inject after the shell + reader thread are up (avoids the instant-exit race).
setTimeout(() => pty.write(Buffer.from(line)), 500);
setTimeout(() => {
  console.log('exit=' + exited + ' output=' + JSON.stringify(out));
  assert.ok(out.includes('ADDON_OK'), 'native addon did not deliver pty output');
  console.log('ADDON TEST PASS (' + process.platform + '-' + process.arch + ')');
  process.exit(0);
}, 2000);
