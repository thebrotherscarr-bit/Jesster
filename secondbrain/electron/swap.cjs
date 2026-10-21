/**
 * The update hand-over, run by the NEW build's own SecondBrain.exe in Node
 * mode (ELECTRON_RUN_AS_NODE=1) from the download folder:
 *
 *   SecondBrain.exe swap.cjs <old pid> <new build dir> <install dir> <exe> <log> [launch args JSON]
 *
 * Wait for the old app to exit (and stop any of its helper processes left
 * behind), copy the new build over the install folder, remove files the new
 * build no longer has, start the app. No PowerShell, no cmd: on a real PC a
 * hidden PowerShell script from %TEMP% never ran, so the app closed and did
 * not come back. Every step is logged.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

process.noAsar = true; // app.asar is a file to copy, not a folder

const [pidArg, src, dest, exe, logFile, launchJson] = process.argv.slice(2);
const pid = Number(pidArg);
const launchArgs = launchJson ? JSON.parse(launchJson) : [];

function log(msg) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()}  swap: ${msg}\r\n`);
  } catch {
    /* never stop for logging */
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(p) {
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Other processes with the app's exe name: Electron helpers left behind. */
function leftovers() {
  if (process.platform !== 'win32') return [];
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${path.basename(exe)}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return (r.stdout || '')
    .split(/\r?\n/)
    .map((l) => Number((l.split('","')[1] || '').replace(/"/g, '')))
    .filter((p) => p && p !== process.pid);
}

function files(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

function copyWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      return;
    } catch (e) {
      if (i >= 60) throw e;
      if (i === 10) leftovers().forEach((p) => { try { process.kill(p); } catch { /* gone */ } });
      sleep(500);
    }
  }
}

try {
  log(`started (pid ${process.pid}); waiting for the old app (pid ${pid})`);
  for (let t = 0; alive(pid) && t < 120; t++) sleep(500);
  if (alive(pid)) {
    log('old app still running after 60s; stopping it');
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
    sleep(1000);
  }
  for (let t = 0; leftovers().length && t < 20; t++) sleep(500);
  const left = leftovers();
  if (left.length) {
    log(`stopping ${left.length} leftover process(es): ${left.join(', ')}`);
    left.forEach((p) => { try { process.kill(p); } catch { /* gone */ } });
    sleep(1000);
  }

  const want = files(src);
  log(`copying ${want.length} files: ${src} -> ${dest}`);
  for (const rel of want) copyWithRetry(path.join(src, rel), path.join(dest, rel));
  const keep = new Set(want.map((f) => f.toLowerCase()));
  let removed = 0;
  for (const rel of files(dest)) {
    if (keep.has(rel.toLowerCase())) continue;
    try {
      fs.unlinkSync(path.join(dest, rel));
      removed++;
    } catch (e) {
      log(`could not remove ${rel}: ${e.code || e.message}`);
    }
  }
  log(`copied; removed ${removed} file(s) the new build no longer has`);
} catch (e) {
  log(`copy FAILED: ${e && e.stack ? e.stack : e}`);
}

// start the app whatever happened: an old build that opens beats nothing
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, launchArgs, { cwd: dest, detached: true, stdio: 'ignore', env }).unref();
  log(`started ${exe}`);
} catch (e) {
  log(`could not start the app: ${e.message}`);
}
