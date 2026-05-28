'use strict';

// Loads the first-party PTY addon for this platform. The .node files are prebuilt
// and shipped in the package (no runtime npm dependency — N-API is built into Node).

const path = require('path');

const file = `eclaude_pty.${process.platform}-${process.arch}.node`;
try {
  module.exports = require(path.join(__dirname, file));
} catch (e) {
  throw new Error(
    `eclaude: native PTY addon not available for ${process.platform}-${process.arch} ` +
      `(${file}). ${e.message}`
  );
}
