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
const { spawn } = require('child_process');

const REPO = 'thebrotherscarr-bit/Jesster';
const TAG = /^secondbrain-b(\d+)$/;
const ASSET = 'SecondBrain-win32-x64.zip';
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

const LOG = path.join(os.tmpdir(), 'secondbrain-update.log');

/** Every step of an update, appended to %TEMP%\\secondbrain-update.log. */
function log(msg) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${msg}\r\n`);
  } catch {
    /* logging must never stop an update */
  }
}

/** Unpack a zip (as GitHub serves the build) with Node alone. */
function unzip(zipFile, outDir) {
  const zlib = require('zlib');
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('the download is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let files = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    const target = path.resolve(outDir, name);
    if (!target.startsWith(path.resolve(outDir) + path.sep)) throw new Error(`unsafe path in zip: ${name}`);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (method === 0) fs.writeFileSync(target, data);
    else if (method === 8) fs.writeFileSync(target, zlib.inflateRawSync(data));
    else throw new Error(`zip method ${method} not supported (${name})`);
    files++;
  }
  return files;
}

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

/** Download the newest build, then hand over to the swap script and quit. */
async function apply() {
  log(`update requested by build ${buildInfo().build} at ${process.execPath}`);
  try {
    return await applySteps();
  } catch (e) {
    log(`update FAILED: ${e && e.stack ? e.stack : e}`);
    throw e;
  }
}

async function applySteps() {
  const state = await check();
  log(`latest on GitHub: ${state.latest ? `build ${state.latest.build}` : 'none'}; this is build ${state.current.build}`);
  if (!state.available) return { updated: false, detail: 'already up to date' };
  if (!state.canApply) return { updated: false, detail: 'self-update only runs in the packaged Windows app' };
  if (!state.latest.url.startsWith(DOWNLOAD_PREFIX)) throw new Error('refusing a download from outside the app repository');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'secondbrain-update-'));
  const zip = path.join(work, ASSET);
  const unpacked = path.join(work, 'new');
  log(`downloading ${state.latest.url}`);
  await get(state.latest.url, { file: zip });
  log(`downloaded ${fs.statSync(zip).size} bytes; unpacking`);
  // Electron's fs treats .asar files as folders; a build is plain files here
  const asar = process.noAsar;
  process.noAsar = true;
  let src;
  try {
    log(`unpacked ${unzip(zip, unpacked)} files`);
    src = findExe(unpacked);
  } finally {
    process.noAsar = asar;
  }
  if (!src) throw new Error('the downloaded build has no SecondBrain.exe');

  // The hand-over runs in the NEW build's own exe, in Node mode, from the
  // download folder: no PowerShell or cmd (a hidden PowerShell script from
  // %TEMP% never ran on a real PC), and nothing in the install folder is in use.
  const dest = path.dirname(process.execPath);
  const exeName = path.basename(process.execPath);
  const swap = path.join(work, 'swap.cjs');
  fs.writeFileSync(swap, fs.readFileSync(path.join(__dirname, 'swap.cjs')));
  const runner = path.join(src, exeName);
  log(`handing over: ${runner} ${swap} (${src} -> ${dest})`);
  const child = spawn(runner, [swap, String(process.pid), src, dest, path.join(dest, exeName), LOG], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('error', (e) => log(`could not start the hand-over: ${e.message}`));
  child.unref();
  setTimeout(() => app.quit(), 500);
  setTimeout(() => app.exit(0), 5000); // if something holds quit up, leave anyway
  return { updated: true, to: state.latest.build };
}

module.exports = { buildInfo, check, apply, unzip, LOG };
