/**
 * Run every check in sequence.
 *
 *   node test/run-all.mjs
 *
 *   selftest.mjs  headless algorithm + georeferencing checks (offline)
 *   dom-smoke.mjs headless UI check against a stubbed DOM (offline)
 *   overlay.mjs   OSM-vs-heatmap alignment proof (network, cached to test/out)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const tests = [
  ['selftest.mjs', 'algorithm + georeferencing'],
  ['dom-smoke.mjs', 'UI against a stubbed DOM'],
  ['overlay.mjs', 'tile scale proof (OSM alignment)'],
];

const failed = [];

for (const [file, what] of tests) {
  console.log(`\n=== ${file} — ${what} ${'='.repeat(Math.max(0, 40 - file.length - what.length))}`);
  const r = spawnSync(process.execPath, [path.join(HERE, file)], {
    stdio: 'inherit',
    cwd: path.join(HERE, '..'),
  });
  if (r.status !== 0) failed.push(file);
}

console.log('\n' + '='.repeat(64));
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
} else {
  console.log('ALL TEST FILES PASSED');
}
console.log('='.repeat(64) + '\n');
process.exit(failed.length ? 1 : 0);
