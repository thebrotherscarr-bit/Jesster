/**
 * The Atlas button: SecondBrain launches the Atlas web app (the glass).
 * Kyle's word, 2026-10-22: "There should be a button right over here by like integrations
 * ... It says Atlas. You click that and it opens and launches the web app."
 *
 * Nothing starts until the button is clicked. Then, when the glass already answers on
 * 127.0.0.1:8091 it is used as it is; when it does not, this starts what atlas-desktop.exe
 * starts after a reboot:
 *
 *   - the door, atlas\line\atlas-mcp.exe, with RUNBOOK's line, its output to mcp.log and
 *     mcp.err.log beside it, when 127.0.0.1:8090 does not answer;
 *   - the glass, atlas\webapp\atlas-webapp.exe, which serves the page and nothing else.
 *
 * Then the web app opens in a window of its own: an app window in his Chrome, as
 * atlas-desktop.exe opens it, else Edge's app window, else the default browser.
 *
 * SecondBrain stops what it started when it quits (his word: "one app ... so you don't have
 * to have some other bullshit running in the background"). A door or glass that was already
 * running (started by atlas-desktop.exe, or by hand) is used and left alone. The service wire
 * (ATLAS_SERVICE) is read from the Manjuel ground's .env into their environment only: never
 * printed, logged or put on a command line. The ground is Settings → Atlas & Manjuel's
 * ground, else the folder two up from the notes folder when it holds manjuel.py
 * (worlds\notes → Research).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const DOOR_PORT = 8090;
const GLASS_PORT = 8091;
const GLASS_URL = `http://127.0.0.1:${GLASS_PORT}/`;

/** Does something listen on this loopback port? */
function answering(port, timeout = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Wait until the port answers or the time is up. */
async function waitFor(port, ms, probe = answering) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await probe(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** The Manjuel ground: the one Settings names, else two up from the notes folder. */
function findGround(settingsGround, vaultDir) {
  for (const g of [settingsGround, vaultDir && path.resolve(vaultDir, '..', '..')]) {
    if (g && fs.existsSync(path.join(g, 'manjuel.py'))) return g;
  }
  return null;
}

/** ATLAS_SERVICE from the ground's .env, or '' (only that one name is read). */
function serviceWire(ground) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(ground, '.env'), 'utf8');
  } catch {
    return '';
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('ATLAS_SERVICE=')) return line.slice('ATLAS_SERVICE='.length).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

/** RUNBOOK's door line, as atlas-desktop.exe runs it. */
function doorArgs(ground) {
  const g = ground.replace(/\\/g, '/');
  return ['--http', `127.0.0.1:${DOOR_PORT}`, '--auth', '--tenant', `research=${g}`, '--tenant', `atlas=${g}/atlas`,
    '--default-project', 'research', '--manjuel', `python ${g}/manjuel.py`];
}

// What SecondBrain started, so it stops them when it quits.
const owned = [];

function startOwned(exe, args, cwd, env, logs) {
  const out = logs ? fs.openSync(path.join(cwd, logs[0]), 'a') : 'ignore';
  const err = logs ? fs.openSync(path.join(cwd, logs[1]), 'a') : 'ignore';
  const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', out, err] });
  child.on('error', () => {});
  owned.push(child);
  return child;
}

/** Stop the door and glass SecondBrain started (never ones it found running). */
function stopOwned() {
  while (owned.length) {
    const c = owned.pop();
    try {
      c.kill();
    } catch {}
  }
}

// One start at a time: two quick clicks share it.
let pending = null;

/** A browser installed in one of the three places Windows installs one. */
function installed(parts, env = process.env) {
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
    if (!root) continue;
    const p = path.join(root, ...parts);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/**
 * Open the web app in a window of its own: his Chrome's app window, else Edge's, else the
 * default browser (`openExternal`). Returns which one.
 */
function openWindow(url, { find = installed, launch = null, openExternal } = {}) {
  const run = launch || ((exe, args) => spawn(exe, args, { detached: true, stdio: 'ignore' }).unref());
  const args = [`--app=${url}`, '--window-size=1440,920'];
  const chrome = find(['Google', 'Chrome', 'Application', 'chrome.exe']);
  if (chrome) {
    run(chrome, args);
    return 'chrome';
  }
  const edge = find(['Microsoft', 'Edge', 'Application', 'msedge.exe']);
  if (edge) {
    run(edge, args);
    return 'edge';
  }
  openExternal(url);
  return 'browser';
}

/**
 * Make sure the glass answers; start the door and the glass when they do not.
 * Returns { url } or { error } (said plainly, for the shelf to show).
 */
async function ensureGlass({ settingsGround, vaultDir, probe = answering, start = startOwned, wait = waitFor }) {
  if (await probe(GLASS_PORT)) return { url: GLASS_URL };
  const ground = findGround(settingsGround, vaultDir);
  if (!ground) {
    return { error: 'The Atlas ground was not found. Set it in Settings → Atlas & Manjuel (the folder with manjuel.py).' };
  }
  const env = { ...process.env };
  const wire = serviceWire(ground);
  if (wire) env.ATLAS_SERVICE = wire;
  if (!(await probe(DOOR_PORT))) {
    const line = path.join(ground, 'atlas', 'line');
    const door = path.join(line, 'atlas-mcp.exe');
    if (!fs.existsSync(door)) return { error: `The Atlas door is not at ${door}.` };
    start(door, doorArgs(ground), line, env, ['mcp.log', 'mcp.err.log']);
    await wait(DOOR_PORT, 20000, probe);
  }
  const web = path.join(ground, 'atlas', 'webapp');
  const glass = path.join(web, 'atlas-webapp.exe');
  if (!fs.existsSync(glass)) return { error: `The Atlas web app is not at ${glass}.` };
  start(glass, [], web, env, null);
  if (!(await wait(GLASS_PORT, 20000, probe))) {
    return { error: `Atlas was started but did not answer on port ${GLASS_PORT}. Its door logs are in ${path.join(ground, 'atlas', 'line')}.` };
  }
  return { url: GLASS_URL };
}

function register({ app, ipcMain, guard, getSettings, vaultDir, shell }) {
  ipcMain.handle('atlas:open', async (event) => {
    guard(event);
    if (!pending) {
      const a = getSettings().get('atlas') || {};
      pending = ensureGlass({ settingsGround: a.ground, vaultDir: vaultDir() }).finally(() => {
        pending = null;
      });
    }
    const r = await pending;
    if (r.error) return r;
    return { url: r.url, window: openWindow(r.url, { openExternal: (u) => shell.openExternal(u) }) };
  });
  // what SecondBrain started goes down with it
  app.on('will-quit', stopOwned);
}

module.exports = { register, ensureGlass, openWindow, stopOwned, findGround, serviceWire, doorArgs, GLASS_URL, DOOR_PORT, GLASS_PORT };
