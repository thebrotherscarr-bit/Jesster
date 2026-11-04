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
// a ROCm override from another card's setup: it makes Ollama pick the wrong kernels for this one
const DROPPED = ['HSA_OVERRIDE_GFX_VERSION'];

/** ollama.exe where its installer puts it (%LOCALAPPDATA%\Programs\Ollama), or '' when it is not there. */
function findOllama(env = process.env) {
  if (!env.LOCALAPPDATA) return '';
  const exe = path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe');
  return fs.existsSync(exe) ? exe : '';
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

/**
 * Ollama as a server entry. `getConfig()` is Settings' services.ollama ({ enabled, env }); its log is ollama.log in
 * `logDir`. While it is off, or while an Ollama SecondBrain did not start answers on the port, it is 'external' and
 * Start/Stop are refused with OLLAMA_EXTERNAL.
 */
function ollamaServer({ getConfig, logDir, start = startOwned, probe = answering, wait = waitFor, find = findOllama, killTree = () => {}, base = process.env }) {
  let child = null;
  let held = false;
  const ours = () => Boolean(child && child.exitCode === null);
  const cfg = () => getConfig() || {};
  const logs = () => (typeof logDir === 'function' ? logDir() : logDir); // the app's logs folder, asked once it is ready
  async function blocked() {
    if (!cfg().enabled) return OLLAMA_EXTERNAL;
    if (!ours() && (await probe(OLLAMA_PORT))) return OLLAMA_EXTERNAL;
    if (!find(base)) return 'Ollama was not found in %LOCALAPPDATA%\\Programs\\Ollama.';
    return '';
  }
  async function begin() {
    const why = await blocked();
    if (why) throw new Error(why);
    held = false;
    if (ours()) return;
    fs.mkdirSync(logs(), { recursive: true });
    child = start(find(base), ['serve'], logs(), ollamaEnv(cfg().env, base), ['ollama.log', 'ollama.log']);
    if (!(await wait(OLLAMA_PORT, 30000, probe))) throw new Error(`Ollama did not answer on port ${OLLAMA_PORT}; its log is ${path.join(logs(), 'ollama.log')}.`);
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
    kind: async () => ((await blocked()) === OLLAMA_EXTERNAL ? 'external' : 'owned'),
    blocked,
    start: begin,
    stop: end,
    restart: async () => {
      await end();
      await begin();
    },
    held: () => held,
    logPath: () => path.join(logs(), 'ollama.log'),
    settings: () => ({ enabled: Boolean(cfg().enabled), env: { ...(cfg().env || {}) } }),
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
    if (why) out.why = why; // a refusal to come: Start on an Ollama the app runs says so, so his buttons stay live
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
      return { ok: true, file, text: file ? tail(file, lines) : '' };
    },
  };
}

/** A steward.cjs service() as an entry: the instance main.cjs already made, with its log in Steward's folder. */
function stewardEntry({ id, label, svc, logPath }) {
  return { id, label, port: svc.port, kind: 'owned', start: svc.start, stop: svc.stop, restart: svc.restart, held: svc.held, logPath };
}

module.exports = { registry, ollamaServer, ollamaEnv, findOllama, stewardEntry, tail, OLLAMA_PORT, OLLAMA_EXTERNAL, MAX_LINES };
