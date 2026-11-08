/**
 * The Servers shelf: every server Steward needs, in one registry, each controllable where SecondBrain can control it
 * (the note plan-secondbrain-services-page-servers-m-42e7bf, piece 1).
 *
 * An entry is { id, label, port, kind, start/stop/restart, held(), up(), blocked(), logPath(), settings() }; all but
 * id, label and port are optional. `kind` is 'owned' (SecondBrain starts it) or 'external' (something else runs it,
 * so it is shown and not touched); it may be a function, asked each time. An entry with no `start` is status only.
 *
 * Ollama is the one server here that is new: `ollama serve` as SecondBrain's own child (startOwned), with the
 * environment pinned in Settings (services.ollama) instead of whatever the shell had. It is off by default, and it
 * never touches an Ollama it did not start: the Ollama app runs it today.
 */
const fs = require('fs');
const path = require('path');
const { startOwned, answering, waitFor } = require('./atlasglass.cjs');

const OLLAMA_PORT = 11434;
const ACTIONS = ['start', 'stop', 'restart'];
const MAX_LINES = 500;
const TAIL_BYTES = 1024 * 1024; // the last 1 MB of a log holds the last 500 lines of any log here
const OLLAMA_EXTERNAL = "Ollama is run by the Ollama app; turn on 'SecondBrain runs Ollama' after quitting it";
// the switch is on, and something SecondBrain did not start (the Ollama app) still answers on 11434: never killed from here
const OLLAMA_APP = 'Quit the Ollama app first (and turn off its start at login); then press Start.';
// the operator's override, read once at SecondBrain's start: '1' on, '0' off, whatever Settings says
const RUNS_OLLAMA = 'SECONDBRAIN_RUNS_OLLAMA';
// an `ollama serve` that dies within QUICK_MS of its start, QUICK_DEATHS times in a row, is not started again
const QUICK_MS = 10000;
const QUICK_DEATHS = 5;
// a ROCm override from another card's setup: it makes Ollama pick the wrong kernels for this one
const DROPPED = ['HSA_OVERRIDE_GFX_VERSION'];

/**
 * ollama.exe, first match wins (Steward ADR-0020): `configured` (Settings' services.ollama.exe) when it is a file, else
 * where its installer puts it (%LOCALAPPDATA%\Programs\Ollama, today's and the default), else the first ollama on PATH;
 * '' when none is there.
 */
function findOllama(env = process.env, configured = '') {
  const isFile = (p) => {
    try {
      return Boolean(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isFile(configured)) return configured;
  if (env.LOCALAPPDATA) {
    const exe = path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe');
    if (isFile(exe)) return exe;
  }
  // a copy of the environment is case-sensitive where Windows' own is not: PATH may be spelled Path
  const key = Object.keys(env || {}).find((k) => k.toUpperCase() === 'PATH');
  for (const dir of String((key && env[key]) || '').split(path.delimiter)) {
    for (const name of ['ollama.exe', 'ollama']) {
      const exe = dir && path.join(dir.replace(/^"|"$/g, ''), name);
      if (isFile(exe)) return exe;
    }
  }
  return '';
}

/**
 * The child's environment: SecondBrain's own, the pinned values over it, and the dropped names taken out (in any
 * case: Windows names are case-blind). A pinned '' leaves the inherited value as it is (OLLAMA_MODELS: his User
 * variable, which SecondBrain was started with).
 */
function ollamaEnv(pinned, base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (DROPPED.includes(k.toUpperCase())) delete env[k];
  for (const [k, v] of Object.entries(pinned || {})) if (v !== '' && v !== null && v !== undefined) env[k] = String(v);
  return env;
}

/** SECONDBRAIN_RUNS_OLLAMA in `env`: '1' is true (SecondBrain runs Ollama), '0' false, anything else null (Settings decides). */
function runsOllama(env = process.env) {
  const v = String((env && env[RUNS_OLLAMA]) ?? '').trim();
  return v === '1' ? true : v === '0' ? false : null;
}

/**
 * Ollama as a server entry. `getConfig()` is Settings' services.ollama ({ enabled, env }); SECONDBRAIN_RUNS_OLLAMA in
 * `base`, read once here, overrides `enabled`. Its log is ollama.log in `logDir` (cut to its newest 100 MB at each
 * start, by startOwned). While it is off it is 'external' and Start/Stop are refused with OLLAMA_EXTERNAL; while it is
 * on and an Ollama SecondBrain did not start answers on the port, with OLLAMA_APP. An `ollama serve` it started is
 * started again `delay` after it dies, unless it was stopped, the switch is off, the port is taken, SecondBrain is
 * quitting (`dispose`), or it died quickly five times in a row (said in `error()` until the next Start).
 */
function ollamaServer({ getConfig, logDir, start = startOwned, probe = answering, wait = waitFor, find = findOllama, killTree = () => {}, base = process.env, delay = 3000, now = Date.now }) {
  const forced = runsOllama(base);
  let child = null;
  let held = false;
  let quick = 0;
  let error = '';
  let disposed = false;
  let startedAt = null;
  const ours =() => Boolean(child && child.exitCode === null);
  const cfg = () => getConfig() || {};
  const enabled = () => (forced === null ? Boolean(cfg().enabled) : forced);
  const logs = () => (typeof logDir === 'function' ? logDir() : logDir); // the app's logs folder, asked once it is ready
  const logFile = () => path.join(logs(), 'ollama.log');
  async function blocked() {
    if (!enabled() && !ours()) return OLLAMA_EXTERNAL; // switched off: one it started can still be stopped
    if (!ours() && (await probe(OLLAMA_PORT))) return enabled() ? OLLAMA_APP : OLLAMA_EXTERNAL;
    if (!find(base, cfg().exe)) return 'Ollama was not found: not in Settings (services.ollama.exe), in %LOCALAPPDATA%\\Programs\\Ollama or on PATH.';
    return '';
  }
  function launch() {
    fs.mkdirSync(logs(), { recursive: true });
    const began = now();
    const c = start(find(base, cfg().exe), ['serve'], logs(), ollamaEnv(cfg().env, base), ['ollama.log', 'ollama.log']);
    child = c;
    startedAt = new Date(began).toISOString();
    if (c && typeof c.once === 'function') c.once('exit', () => died(c, began));
  }
  function died(c, began) {
    if (c !== child || held || disposed) return; // stopped on purpose, replaced, or SecondBrain is quitting
    child = null;
    quick = now() - began < QUICK_MS ? quick + 1 : 0;
    if (quick >= QUICK_DEATHS) {
      error = `Ollama stopped ${QUICK_DEATHS} times in a row; it is not started again until Start. Its log is ${logFile()}.`;
      return;
    }
    setTimeout(() => relaunch().catch(() => {}), delay);
  }
  async function relaunch() {
    if (held || disposed || ours() || (await blocked())) return; // stopped, quitting, switched off, or the port is taken
    launch();
  }
  async function begin() {
    const why = await blocked();
    if (why) throw new Error(why);
    held = false;
    quick = 0;
    error = '';
    if (ours()) return;
    launch();
    if (!(await wait(OLLAMA_PORT, 30000, probe))) throw new Error(`Ollama did not answer on port ${OLLAMA_PORT}; its log is ${logFile()}.`);
  }
  async function end() {
    const why = await blocked();
    if (why) throw new Error(why);
    held = true;
    if (ours()) killTree(child.pid); // ollama serve's model runners are its children
    child = null;
    if (!(await wait(OLLAMA_PORT, 15000, probe, true))) throw new Error(`Something still answers on port ${OLLAMA_PORT} after the stop.`);
  }
  return {
    id: 'ollama',
    label: 'Ollama',
    port: OLLAMA_PORT,
    kind: async () => ([OLLAMA_EXTERNAL, OLLAMA_APP].includes(await blocked()) ? 'external' : 'owned'),
    blocked,
    start: begin,
    stop: end,
    restart: async () => {
      await end();
      await begin();
    },
    held: () => held,
    pid: () => (ours() ? child.pid : null),
    started: () => (ours() ? startedAt : null),
    error: () => error,
    dispose: () => {
      disposed = true;
    },
    logPath: logFile,
    // enabled as it stands (the override, else Settings); override 'on' / 'off' when SECONDBRAIN_RUNS_OLLAMA set it
    settings: () => ({ enabled: enabled(), override: forced === null ? null : forced ? 'on' : 'off', env: { ...(cfg().env || {}) } }),
  };
}

const value = async (v) => (typeof v === 'function' ? v() : v);

/** The last `n` lines of a file (n is held to 1..500), read from its last 1 MB; '' when there is none. */
function tail(file, n) {
  const want = Math.min(MAX_LINES, Math.max(1, Math.floor(Number(n) || 100)));
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    text = buf.toString('utf8');
  } catch {
    return '';
  }
  return text.split(/\r?\n/).filter((l, i, all) => l || i < all.length - 1).slice(-want).join('\n');
}

/**
 * The registry. `list()` reads each entry's state now; `control(id, action)` runs start, stop or restart and never
 * throws (a refusal or failure comes back as { ok: false, error }); `log(id, lines)` reads only the log an entry names. An entry's port may be a function, asked each time.
 */
function registry(entries, { probe = answering } = {}) {
  const busy = new Set();
  const find = (id) => entries.find((e) => e.id === id);
  async function view(e) {
    const why = e.start ? (e.blocked ? await e.blocked() : '') : `${e.label} is not started or stopped from here.`;
    const port = (await value(e.port)) || null;
    const up = e.up ? await e.up() : port ? await probe(port) : false;
    const status = busy.has(e.id) ? 'starting' : up ? 'up' : e.held && e.held() ? 'held' : 'down';
    const out = { id: e.id, label: e.label, port, kind: await value(e.kind || 'owned'), status, canControl: Boolean(e.start), logPath: (e.logPath && e.logPath()) || null };
    // the process SecondBrain runs it as, and since when (null when it runs none: one found running, or stopped)
    out.pid = (e.pid && e.pid()) || null;
    out.started = (e.started && e.started()) || null;
    if (why) out.why = why; // a refusal to come: Start on an Ollama the app runs says so, so his buttons stay live
    const err = e.error ? e.error() : '';
    if (err) out.error = err; // why a server it keeps up is no longer started again
    if (e.settings) out.settings = e.settings();
    return out;
  }
  return {
    list: () => Promise.all(entries.map(view)),
    async control(id, action) {
      const e = find(id);
      if (!e) return { ok: false, error: `Unknown server: ${id}` };
      if (!ACTIONS.includes(action)) return { ok: false, error: `Unknown action: ${action}` };
      if (!e.start) return { ok: false, error: `${e.label} is not started or stopped from here.` };
      const why = e.blocked ? await e.blocked() : '';
      if (why) return { ok: false, error: why };
      if (busy.has(id)) return { ok: false, error: `${e.label} is starting; wait for it.` };
      if (action !== 'stop') busy.add(id);
      try {
        await e[action]();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        busy.delete(id);
      }
    },
    log(id, lines) {
      const e = find(id);
      if (!e) return { ok: false, error: `Unknown server: ${id}` };
      const file = (e.logPath && e.logPath()) || null;
      // never a keys file (RULE 7), whatever an entry names
      if (file && /^\.env/i.test(path.basename(file))) return { ok: false, error: `${e.label}'s log is not read: ${path.basename(file)} is a keys file.` };
      return { ok: true, file, text: file ? tail(file, lines) : '' };
    },
  };
}

/** A steward.cjs service() as an entry: the instance main.cjs already made, with its log in Steward's folder. */
function stewardEntry({ id, label, svc, logPath }) {
  return { id, label, port: svc.port, kind: 'owned', start: svc.start, stop: svc.stop, restart: svc.restart, held: svc.held, pid: svc.pid, started: svc.started, logPath };
}

module.exports = { registry, ollamaServer, ollamaEnv, findOllama, runsOllama, stewardEntry, tail, OLLAMA_PORT, OLLAMA_EXTERNAL, OLLAMA_APP, RUNS_OLLAMA, MAX_LINES };
