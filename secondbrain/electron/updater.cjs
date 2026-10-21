/**
 * Self-update for the packaged Windows app.
 *
 * GitHub Actions builds the app on every push and publishes it as a release
 * tagged `secondbrain-b<build>` with `SecondBrain-win32-x64.zip` attached
 * (.github/workflows/secondbrain-release.yml). The build number baked into
 * this copy (electron/build.json, written by that workflow) is compared with
 * the newest release; applying an update downloads the zip, unpacks it, and
 * hands off to a small script that waits for this process to exit, mirrors
 * the new files over the install folder and starts the app again.
 *
 * Notes are not in the install folder: localStorage lives in
 * %APPDATA%\SecondBrain, so an update never touches them.
 */
const { app } = require('electron');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'thebrotherscarr-bit/Jesster';
const TAG = /^secondbrain-b(\d+)$/;
const ASSET = 'SecondBrain-win32-x64.zip';
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

function buildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build.json'), 'utf8'));
  } catch {
    return { build: 0, commit: 'dev', branch: 'local' };
  }
}

function get(url, { json = false, file = null, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'SecondBrain-updater', Accept: json ? 'application/vnd.github+json' : '*/*' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(get(res.headers.location, { json, file, redirects: redirects - 1 }));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub answered ${res.statusCode} for ${url}`));
          return;
        }
        if (file) {
          const out = fs.createWriteStream(file);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve(file)));
          out.on('error', reject);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(json ? JSON.parse(body) : body);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.setTimeout(60000, () => req.destroy(new Error('GitHub did not answer in time')));
    req.on('error', reject);
  });
}

/** What this copy is, and whether GitHub has a newer build. */
async function check() {
  const current = buildInfo();
  const releases = await get(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { json: true });
  let latest = null;
  for (const r of releases) {
    const m = TAG.exec(r.tag_name || '');
    const asset = (r.assets || []).find((a) => a.name === ASSET);
    if (!m || r.draft || !asset) continue;
    const build = Number(m[1]);
    if (!latest || build > latest.build) {
      latest = { build, tag: r.tag_name, title: r.name || r.tag_name, notes: r.body || '', url: asset.browser_download_url };
    }
  }
  return {
    current,
    latest,
    available: Boolean(latest && latest.build > (current.build || 0)),
    canApply: process.platform === 'win32' && app.isPackaged,
  };
}

function powershell(args) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', args], { windowsHide: true }, (err, _o, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve()
    );
  });
}

function findExe(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name.toLowerCase() === 'secondbrain.exe') return dir;
    if (fs.statSync(p).isDirectory()) {
      const found = findExe(p);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The hand-over script: wait for this app to exit, mirror the new build over
 * the install folder, start it again, clean up. PowerShell, not cmd: on a PC
 * with Git installed `find` can be the Unix one, and `timeout` fails without
 * a console, which left the first version of this looping. Written with a
 * BOM so Windows PowerShell 5.1 reads non-ASCII paths correctly.
 * Exercised on Windows in CI by electron/swap.test.cjs.
 */
function writeSwapScript(file, { pid, src, dest, exe, work }) {
  const q = (p) => "'" + String(p).replace(/'/g, "''") + "'";
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Wait-Process -Id ${pid} -Timeout 60`,
    `Stop-Process -Id ${pid} -Force`,
    'Start-Sleep -Milliseconds 800',
    `robocopy ${q(src)} ${q(dest)} /MIR /R:20 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null`,
    `Start-Process -FilePath ${q(exe)} -WorkingDirectory ${q(dest)}`,
  ];
  if (work) lines.push(`Remove-Item -LiteralPath ${q(work)} -Recurse -Force`);
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n') + '\r\n', 'utf8');
  return file;
}

/** Download the newest build, then hand over to the swap script and quit. */
async function apply() {
  const state = await check();
  if (!state.available) return { updated: false, detail: 'already up to date' };
  if (!state.canApply) return { updated: false, detail: 'self-update only runs in the packaged Windows app' };
  if (!state.latest.url.startsWith(DOWNLOAD_PREFIX)) throw new Error('refusing a download from outside the app repository');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'secondbrain-update-'));
  const zip = path.join(work, ASSET);
  const unpacked = path.join(work, 'new');
  await get(state.latest.url, { file: zip });
  await powershell(`Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${unpacked.replace(/'/g, "''")}' -Force`);
  const src = findExe(unpacked);
  if (!src) throw new Error('the downloaded build has no SecondBrain.exe');

  const dest = path.dirname(process.execPath);
  const script = path.join(work, 'swap.ps1');
  writeSwapScript(script, {
    pid: process.pid,
    src,
    dest,
    exe: path.join(dest, path.basename(process.execPath)),
    work,
  });
  spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
    { detached: true, stdio: 'ignore', windowsHide: true }
  ).unref();
  setTimeout(() => app.quit(), 300);
  setTimeout(() => app.exit(0), 5000); // if something holds quit up, leave anyway
  return { updated: true, to: state.latest.build };
}

module.exports = { buildInfo, check, apply, writeSwapScript };
