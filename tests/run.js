// Runs gather's browser test suites against a fresh local server (in-memory store, no database needed).
//
//   npm test                 # every suite
//   npm test -- round6 mod   # just these
//   GATHER_URL=https://… npm test   # against a running deployment instead of a local server
//
// A suite fails if it exits non-zero, prints a FAIL line, or reports a page/console error that isn't
// known network noise (Twitch's chat socket being blocked in a sandbox).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const ALL = ['e2e', 'feat', 'mod', 'twitch', 'round', 'round4', 'round5', 'round6'];
const NOISE = /irc-ws\.chat\.twitch\.tv|tunnel via proxy|ERR_TUNNEL|ERR_PROXY/;
const pick = process.argv.slice(2).filter((a) => ALL.includes(a));
const suites = pick.length ? pick : ALL;

function waitFor(url, ms) {
  const until = Date.now() + ms;
  return new Promise((res, rej) => {
    const tick = () => fetch(url).then((r) => (r.ok ? res() : retry())).catch(retry);
    const retry = () => (Date.now() > until ? rej(new Error(`server did not answer at ${url}`)) : setTimeout(tick, 250));
    tick();
  });
}
function run(file) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [file, OUT], { env: process.env, cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += '\nFAIL timed out after 240s'; }, 240_000);
    child.on('close', (code) => { clearTimeout(timer); res({ code, out }); });
  });
}
function verdict({ code, out }) {
  if (code !== 0) return `exited with code ${code}`;
  const fail = out.split('\n').find((l) => l.startsWith('FAIL'));
  if (fail) return fail;
  const errText = out.slice(out.search(/^errors /m));
  const errors = out.search(/^errors /m) < 0 ? [] : [...errText.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]).filter((e) => e && !NOISE.test(e));
  return errors.length ? `page errors: ${errors.slice(0, 3).join(' | ')}` : '';
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of ['deck.pdf', 'logo.png']) fs.copyFileSync(path.join(ROOT, 'scripts', 'fixtures', f), path.join(OUT, f));
  let server = null;
  if (!process.env.GATHER_URL) {
    const port = process.env.TEST_PORT || '8090';
    process.env.GATHER_URL = `http://localhost:${port}`;
    const env = { ...process.env, PORT: port };
    for (const k of ['REDIS_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete env[k];
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
    await waitFor(process.env.GATHER_URL + '/', 15_000);
  }
  const failures = [];
  for (const name of suites) {
    const t0 = Date.now();
    const result = await run(path.join(__dirname, `${name}.test.js`));
    const why = verdict(result);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`${why ? '✗' : '✓'} ${name.padEnd(7)} ${secs.padStart(3)}s${why ? '  ' + why : ''}`);
    if (why) { failures.push(name); fs.writeFileSync(path.join(OUT, `${name}.log`), result.out); }
  }
  server?.kill();
  console.log(failures.length ? `\n${failures.length} of ${suites.length} failed. Logs: tests/out/<suite>.log` : `\nAll ${suites.length} suites passed. Screenshots: tests/out/`);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
