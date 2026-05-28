#!/usr/bin/env node

// Download the CI-built native addon binaries into native/ before publishing.
// The .node files are not committed; CI (build-addon job) uploads them as artifacts.
//
// Usage:
//   node scripts/fetch-prebuilds.mjs [runId]
// Defaults to the latest successful CI run on main. Requires `gh` (authenticated).

import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'adam-dorin/claude-external-repl-commands';
const ARTIFACTS = [
  'eclaude_pty-ubuntu-latest',
  'eclaude_pty-macos-latest',
  'eclaude_pty-windows-latest',
];
const nativeDir = path.join(__dirname, '..', 'native');

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...opts });
}

let runId = process.argv[2];
if (!runId) {
  runId = gh([
    'run', 'list', '--repo', REPO, '--workflow', 'ci.yml',
    '--branch', 'main', '--status', 'success',
    '--limit', '1', '--json', 'databaseId', '-q', '.[0].databaseId',
  ]).trim();
}
if (!runId) {
  console.error('No successful CI run found. Push first, let CI build, then retry.');
  process.exit(1);
}

console.log(`Fetching prebuilt addons from run ${runId} into native/ ...`);
// gh refuses to overwrite; clear any locally-built .node first.
for (const f of readdirSync(nativeDir).filter((f) => f.endsWith('.node'))) {
  rmSync(path.join(nativeDir, f));
}
for (const name of ARTIFACTS) {
  gh(['run', 'download', runId, '--repo', REPO, '-n', name, '-D', nativeDir], {
    stdio: 'inherit',
  });
}

const got = readdirSync(nativeDir).filter((f) => f.endsWith('.node'));
console.log('native/ now contains:', got.join(', ') || '(none!)');
if (got.length < ARTIFACTS.length) {
  console.error(`Expected ${ARTIFACTS.length} .node files, got ${got.length}.`);
  process.exit(1);
}
