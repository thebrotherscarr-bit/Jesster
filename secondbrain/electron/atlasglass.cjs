/**
 * Atlas comes from SecondBrain (Kyle's word, 2026-10-23: "I want ONE .exe as secondbrain ... the
 * door, the gate, the glass, everything COMES FROM SECONDBRAIN"; the note plan-one-exe, piece 1).
 *
 * When SecondBrain starts (boot):
 *
 *   - it becomes the door on 127.0.0.1:8090 (door/listen.cjs). An old atlas-mcp.exe found there
 *     is stopped first -- that program only, found by name, and never while a sitting is open
 *     (RULE 9); anything else on the port is left alone and said;
 *   - it runs the glass, atlas\webapp\atlas-webapp.exe, as its own child, started again when it
 *     stops (Atlas's Update swaps the program under it) and stopped when SecondBrain quits.
 *
 * The Atlas button (Kyle's word, 2026-10-22: "You click that and it opens and launches the web
 * app") opens the glass in a window of its own: an app window in his Chrome, as atlas-desktop.exe
 * opens it, else Edge's app window, else the default browser.
 *
 * The service wire (ATLAS_SERVICE) is the ground's .env's when it has one, so atlas-desktop.exe
 * and Atlas's own scripts still agree with the door; else one made fresh at each start. It rides
 * in the glass's environment only: never printed, logged or put on a command line. The ground is
 * Settings → Atlas & Manjuel's ground, else the folder two up from the notes folder when it holds
 * manjuel.py (worlds\notes → Research).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const DOOR_PORT = 8090;
const GLASS_PORT = 8091;
const GLASS_URL = `http://127.0.0.1:${GLASS_PORT}/`;
const NO_GROUND = 'The Atlas ground was not found. Set it in Settings → Atlas & Manjuel (the folder with manjuel.py).';

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

/** Wait until the port answers (or, with `gone`, until it does not) or the time is up. */
async function waitFor(port, ms, probe = answering, gone = false) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await probe(port)) !== gone) return true;
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

/** The sitting open in the ground's ledger (its number), or '' (an open sitting's `ended` is ""). */
function openSitting(ground) {
  let last = '';
  try {
    last = fs.readFileSync(path.join(ground, 'sessions', 'sessions.jsonl'), 'utf8').trim().split(/\r?\n/).pop() || '';
  } catch {
    return '';
  }
  try {
    const row = JSON.parse(last);
    return String(row.ended || '').trim() ? '' : String(row.n ?? '?');
  } catch {
    return '';
  }
}

/** The program listening on a loopback port, { pid, name }, or null (Windows: netstat, tasklist). */
function portOwner(port) {
  if (process.platform !== 'win32') return null;
  try {
    const rows = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/);
    const row = rows.map((r) => r.trim().split(/\s+/)).find((c) => c[3] === 'LISTENING' && /:(\d+)$/.exec(c[1] || '')?.[1] === String(port));
    if (!row) return null;
    const pid = Number(row[4]);
    const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const name = (/^"([^"]+)"/.exec(csv.trim()) || [])[1] || '';
    return { pid, name };
  } catch {
    return null;
  }
}

// What SecondBrain started, so it stops them when it quits.
const owned = [];
const supervisors = [];

function startOwned(exe, args, cwd, env, logs) {
  const out = logs ? fs.openSync(path.join(cwd, logs[0]), 'a') : 'ignore';
  const err = logs ? fs.openSync(path.join(cwd, logs[1]), 'a') : 'ignore';
  const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', out, err] });
  child.on('error', () => {});
  owned.push(child);
  return child;
}

/**
 * The glass as SecondBrain's own child: started now, and again `delay` after it stops. A glass
 * already answering on 8091 (atlas-desktop.exe's) is used and looked at again later; the exe
 * missing for a moment (Atlas's Update mid-swap) is waited out. Five quick deaths in a row stop
 * the restarts, said in `error`.
 */
function superviseGlass(ground, wire, { start = startOwned, probe = answering, delay = 3000 } = {}) {
  const web = path.join(ground, 'atlas', 'webapp');
  const exe = path.join(web, 'atlas-webapp.exe');
  const sup = { stopping: false, child: null, starts: 0, quick: 0, error: '' };
  const again = () => !sup.stopping && setTimeout(run, delay);
  async function run() {
    if (sup.stopping) return;
    if (!fs.existsSync(exe) || (await probe(GLASS_PORT))) return again();
    sup.starts++;
    const began = Date.now();
    sup.child = start(exe, [], web, { ...process.env, ATLAS_SERVICE: wire }, ['web.log', 'web.err.log']);
    sup.child.once('exit', () => {
      sup.quick = Date.now() - began < 10000 ? sup.quick + 1 : 0;
      if (sup.quick >= 5) {
        sup.error = `the glass stopped five times in a row; its log is ${path.join(web, 'web.err.log')}`;
        return;
      }
      again();
    });
  }
  sup.stop = () => {
    sup.stopping = true;
    if (sup.child && sup.child.exitCode === null) {
      try {
        sup.child.kill();
      } catch {}
    }
  };
  supervisors.push(sup);
  run();
  return sup;
}

/** Stop the glass and anything else SecondBrain started (never what it found running). */
function stopOwned() {
  while (supervisors.length) supervisors.pop().stop();
  while (owned.length) {
    const c = owned.pop();
    try {
      c.kill();
    } catch {}
  }
}

/**
 * At SecondBrain's start: be the door on 8090 and run the glass. Resolves { ground, wire } or
 * { error } (said plainly, for the Atlas button to show).
 */
async function boot({
  settingsGround,
  vaultDir,
  door,
  probe = answering,
  owner = portOwner,
  kill = (pid) => process.kill(pid),
  sitting = openSitting,
  listenFn = (d, o) => require('./door/listen.cjs').listen(d, o),
  supervise = superviseGlass,
  wait = waitFor,
}) {
  const ground = findGround(settingsGround, vaultDir);
  if (!ground) return { error: NO_GROUND };
  const wire = serviceWire(ground) || crypto.randomBytes(24).toString('hex');
  if (await probe(DOOR_PORT)) {
    const o = owner(DOOR_PORT);
    if (!o || o.name.toLowerCase() !== 'atlas-mcp.exe') {
      return { error: `Port ${DOOR_PORT} is held by ${o ? o.name : 'another program'}, so SecondBrain cannot be the Atlas door there.` };
    }
    const n = sitting(ground);
    if (n) return { error: `Sitting ${n} is open in the old Atlas door on ${DOOR_PORT}. Close it, then press Atlas.` };
    kill(o.pid);
    if (!(await wait(DOOR_PORT, 10000, probe, true))) return { error: `The old Atlas door on ${DOOR_PORT} did not stop.` };
  }
  try {
    await listenFn(door, { wire });
  } catch (e) {
    return { error: e.message };
  }
  supervise(ground, wire);
  return { ground, wire };
}

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

function register({ app, ipcMain, guard, getSettings, vaultDir, shell, door }) {
  // One boot at a time; a failed one is tried again at the next press of the Atlas button.
  let booted = null;
  const bootOnce = () => {
    if (!booted) {
      const a = getSettings().get('atlas') || {};
      booted = boot({ settingsGround: a.ground, vaultDir: vaultDir(), door }).then((r) => {
        if (r.error) {
          console.error('[SecondBrain] atlas:', r.error);
          booted = null;
        }
        return r;
      });
    }
    return booted;
  };
  app.whenReady().then(bootOnce);
  ipcMain.handle('atlas:open', async (event) => {
    guard(event);
    if (!(await answering(GLASS_PORT))) {
      const r = await bootOnce();
      if (r.error) return r;
      if (!(await waitFor(GLASS_PORT, 20000))) return { error: `The glass did not answer on port ${GLASS_PORT}; its log is in ${path.join(r.ground, 'atlas', 'webapp')}.` };
    }
    return { url: GLASS_URL, window: openWindow(GLASS_URL, { openExternal: (u) => shell.openExternal(u) }) };
  });
  // what SecondBrain started goes down with it
  app.on('will-quit', stopOwned);
}

module.exports = { register, boot, superviseGlass, openWindow, stopOwned, startOwned, answering, waitFor, findGround, serviceWire, openSitting, portOwner, GLASS_URL, DOOR_PORT, GLASS_PORT };
