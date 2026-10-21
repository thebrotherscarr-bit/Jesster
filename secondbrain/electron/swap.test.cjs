// Runs the real update hand-over on Windows (CI): a stand-in "old app"
// process, an install folder with old files, a new build folder. The script
// must wait for the old process to end, mirror the new files over, and start
// the app again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// updater.cjs requires electron; give it a stand-in so it loads under node.
const Module = require('module');
const load = Module._load;
Module._load = (req, ...rest) => (req === 'electron' ? { app: {} } : load(req, ...rest));
const { writeSwapScript } = require('./updater.cjs');

if (process.platform !== 'win32') {
  console.log('swap test: Windows only, skipped');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swap test '));   // a space, like real paths
const src = path.join(root, 'new build');
const dest = path.join(root, 'installed');
fs.mkdirSync(src);
fs.mkdirSync(dest);
fs.writeFileSync(path.join(src, 'version.txt'), 'build 2');
fs.writeFileSync(path.join(dest, 'version.txt'), 'build 1');
fs.writeFileSync(path.join(dest, 'stale.txt'), 'from build 1 only');
const marker = path.join(root, 'restarted.txt');
// the "app" that gets started again: a .cmd that leaves a marker
fs.writeFileSync(path.join(src, 'SecondBrain.cmd'), `@echo restarted> "${marker}"\r\n`);

// the old app: a process that lives a few seconds
const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore' });
const script = writeSwapScript(path.join(root, 'swap.ps1'), {
  pid: old.pid,
  src,
  dest,
  exe: path.join(dest, 'SecondBrain.cmd'),
});

const t0 = Date.now();
const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
  encoding: 'utf8',
  timeout: 120000,
});
const waited = Date.now() - t0;
for (let i = 0; i < 40 && !fs.existsSync(marker); i++) spawnSync('powershell.exe', ['-Command', 'Start-Sleep -Milliseconds 250']);

const checks = [
  ['script ran', r.status === 0, `${r.status} ${r.stderr}`],
  ['waited for the old app to exit', waited >= 3000, `${waited} ms`],
  ['new files copied over', fs.readFileSync(path.join(dest, 'version.txt'), 'utf8') === 'build 2', ''],
  ['old-only files removed', !fs.existsSync(path.join(dest, 'stale.txt')), ''],
  ['app started again', fs.existsSync(marker), marker],
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
