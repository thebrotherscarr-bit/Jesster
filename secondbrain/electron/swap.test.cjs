// The real update hand-over (electron/swap.cjs), end to end: an "old app"
// process, an install folder with old files, a new build folder. The swap
// must wait for the old app, copy the new files over, drop old-only files,
// keep app.asar a file, start the app again, and log every step.
//
// SWAP_RUNNER=<path to SecondBrain.exe> runs the swap the way an update does,
// in the packaged app's own Node mode; without it, plain node runs it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const runner = process.env.SWAP_RUNNER || process.execPath;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swap test '));   // a space, like real paths
const src = path.join(root, 'new build');
const dest = path.join(root, 'installed');
fs.mkdirSync(path.join(src, 'resources'), { recursive: true });
fs.mkdirSync(path.join(dest, 'resources'), { recursive: true });
fs.writeFileSync(path.join(src, 'version.txt'), 'build 2');
fs.writeFileSync(path.join(src, 'resources', 'app.asar'), 'new asar');
fs.writeFileSync(path.join(dest, 'version.txt'), 'build 1');   // same size, same second
fs.writeFileSync(path.join(dest, 'resources', 'app.asar'), 'old asar');
fs.writeFileSync(path.join(dest, 'stale.txt'), 'from build 1 only');
const marker = path.join(root, 'restarted.txt');
const log = path.join(root, 'update.log');

const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
const launch = JSON.stringify(['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'restarted')`]);
(async () => {
const t0 = Date.now();
// async, so this process collects the old app when it exits (a lingering
// zombie would look "alive" on Linux)
const r = await new Promise((resolve) => {
  const c = spawn(runner, [path.join(__dirname, 'swap.cjs'), String(old.pid), src, dest, process.execPath, log, launch], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let stderr = '';
  c.stderr.on('data', (d) => (stderr += d));
  c.on('exit', (status) => resolve({ status, stderr }));
});
const waited = Date.now() - t0;
for (let i = 0; i < 40 && !fs.existsSync(marker); i++) await new Promise((res) => setTimeout(res, 250));
const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';

const checks = [
  [`swap ran (${path.basename(runner)})`, r.status === 0, `${r.status} ${r.stderr}`],
  ['waited for the old app to exit, and no longer', waited >= 2500 && waited < 20000, `${waited} ms`],
  ['new files copied over', fs.readFileSync(path.join(dest, 'version.txt'), 'utf8') === 'build 2', ''],
  ['app.asar copied as a file', fs.readFileSync(path.join(dest, 'resources', 'app.asar'), 'utf8') === 'new asar', ''],
  ['old-only files removed', !fs.existsSync(path.join(dest, 'stale.txt')), ''],
  ['app started again', fs.existsSync(marker), ''],
  ['every step logged', /copied;/.test(text) && /started /.test(text), text],
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
})();
