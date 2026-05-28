'use strict';
// Copy the cargo build output to the platform-named .node the loader expects.
const fs = require('fs');
const path = require('path');

const src = {
  win32: 'eclaude_pty.dll',
  darwin: 'libeclaude_pty.dylib',
  linux: 'libeclaude_pty.so',
}[process.platform];
if (!src) throw new Error('unsupported platform: ' + process.platform);

const from = path.join(__dirname, 'target', 'release', src);
const to = path.join(__dirname, `eclaude_pty.${process.platform}-${process.arch}.node`);
fs.copyFileSync(from, to);
console.log('staged', path.basename(to));
