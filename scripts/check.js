// Fast static checks: every JavaScript file parses, and the TypeScript scripts typecheck under --strict.
//   npm run check
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const files = ['server.js', ...['api', 'lib', 'public', 'tests', 'scripts/fixtures'].flatMap((dir) =>
  fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)))];
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.log(`✗ ${f}\n${r.stderr.trim()}`); }
}
console.log(`${files.length - failed}/${files.length} JavaScript files parse`);
const tsc = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'scripts'], { cwd: ROOT, encoding: 'utf8' });
if (tsc.status !== 0) { failed++; console.log(tsc.stdout.trim() || tsc.stderr.trim()); }
else console.log('scripts/*.ts typecheck under --strict');
process.exit(failed ? 1 : 0);
