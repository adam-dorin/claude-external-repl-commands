'use strict';
// Standalone check for the native PTY addon: spawn a shell, inject a command once
// the reader is established, confirm its output comes back AND the exit fires.
const assert = require('assert');
const { Pty } = require('./index.js');

const isWin = process.platform === 'win32';
const shell = isWin ? 'cmd.exe' : 'sh';
const line = `echo ADDON_OK${isWin ? ' & exit' : '; exit'}${isWin ? '\r' : '\n'}`;

let out = '';
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
    console.log('exit=' + code + ' output=' + JSON.stringify(out));
    assert.ok(out.includes('ADDON_OK'), 'native addon did not deliver pty output');
    console.log('ADDON TEST PASS (' + process.platform + '-' + process.arch + ')');
    process.exit(0);
  }
);

// Inject after the shell + reader thread are up (avoids the instant-exit race).
setTimeout(() => pty.write(Buffer.from(line)), 500);
setTimeout(() => {
  console.log('TIMEOUT: exit never fired; output=' + JSON.stringify(out));
  process.exit(1);
}, 6000);
