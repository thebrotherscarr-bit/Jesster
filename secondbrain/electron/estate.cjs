/**
 * The Estate for Steward: what SecondBrain runs, as MCP tools on its own /mcp (atlas.cjs handleMcp), so Steward can
 * see and work the Estate himself. Nothing here starts, stops or reads anything new: each tool is the path the window
 * already takes (the Servers shelf's registry, the updater, the Approvals history), and Ollama's own API.
 *
 *   estate_status       read   every server (name, port, up, pid, started), SecondBrain's build, Ollama, the sitting
 *   estate_logs         read   the tail of one server's log, as the Servers shelf shows it (at most 400 lines)
 *   service_control     write  start | stop | restart one server, as the shelf's services:control does
 *   ollama_unload       write  one model out of memory (keep_alive 0)
 *   app_update          check is a read; apply is a write (it quits SecondBrain into the new build)
 *   approvals_history   read   the answered cards, newest first (at most 200)
 *
 * A write is served only while the operator allows writes (Settings → Share), as WRITE_TOOLS are, and each says so
 * in its MCP annotations (readOnlyHint false), so Steward's side puts it on the operator's card.
 *
 * Never: SecondBrain itself (it is the one serving this), the door while a Manjuel sitting is open (RULE 9), or a
 * log whose name starts with .env (RULE 7).
 */
const http = require('http');

const OLLAMA = { host: '127.0.0.1', port: 11434 };
const MAX_LOG_LINES = 400;
const MAX_HISTORY = 200;
const SELF = ['secondbrain', 'jesster'];
const ACTIONS = ['start', 'stop', 'restart'];

const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const ESTATE_TOOLS = [
  {
    name: 'estate_status',
    description:
      "The Estate as SecondBrain runs it: each server (name, port, up, pid, started), SecondBrain's build, Ollama's version and loaded models, and whether a Manjuel sitting is open.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Estate status', ...read },
  },
  {
    name: 'estate_logs',
    description: "The last lines of one server's log, as SecondBrain's Servers shelf shows it. service is a name from estate_status.",
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string' }, lines: { type: 'integer', minimum: 1, maximum: MAX_LOG_LINES, description: `at most ${MAX_LOG_LINES}; 100 when left out` } },
      required: ['service'],
    },
    annotations: { title: 'Estate logs', ...read },
  },
  {
    name: 'service_control',
    description:
      "Start, stop or restart one server SecondBrain runs (a name from estate_status), as the Servers shelf's buttons do. A write: it waits on the operator's card. Never SecondBrain itself, and never the door while a Manjuel sitting is open.",
    inputSchema: { type: 'object', properties: { service: { type: 'string' }, action: { type: 'string', enum: ACTIONS } }, required: ['service', 'action'] },
    annotations: { title: 'Control a server', ...write },
  },
  {
    name: 'ollama_unload',
    description: "Unload one model from Ollama's memory now (keep_alive 0). A write: it waits on the operator's card.",
    inputSchema: { type: 'object', properties: { model: { type: 'string', description: 'a name from estate_status ollama.models' } }, required: ['model'] },
    annotations: { title: 'Unload an Ollama model', ...write, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'app_update',
    description:
      "SecondBrain's own update. check: this build and the newest on GitHub (a read). apply: download it and restart SecondBrain into it (a write: it waits on the operator's card, and ends this connection).",
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['check', 'apply'] } }, required: ['action'] },
    annotations: { title: "SecondBrain's update", ...write, openWorldHint: true },
  },
  {
    name: 'approvals_history',
    description: 'The cards the operator has answered (Allow, Deny, Always, a timeout), newest first: id, tool, summary, answer, where (window, telegram or discord), time.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_HISTORY, description: `at most ${MAX_HISTORY}; 50 when left out` } } },
    annotations: { title: 'Approvals history', ...read },
  },
];

const NAMES = ESTATE_TOOLS.map((t) => t.name);

/** Is this call a write (refused while the operator allows reads only)? */
function isWrite(name, args = {}) {
  if (name === 'app_update') return args.action === 'apply';
  return name === 'service_control' || name === 'ollama_unload';
}

/** One JSON request to Ollama on loopback: the parsed answer, or an Error. */
function ollamaJson(port, method, path, body, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: OLLAMA.host, port, method, path, timeout, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* said below */
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && json) resolve(json);
          else reject(new Error(`Ollama answered ${res.statusCode}: ${(json && json.error) || text.slice(0, 200)}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Ollama did not answer in time')));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

/** Ollama's API as estate_status and ollama_unload use it, on 127.0.0.1:`port` (11434; tests give their own). */
function ollamaApi(port = OLLAMA.port) {
  return {
    version: () => ollamaJson(port, 'GET', '/api/version'),
    ps: () => ollamaJson(port, 'GET', '/api/ps'),
    unload: (model) => ollamaJson(port, 'POST', '/api/generate', { model, keep_alive: 0 }),
  };
}
const ollama = ollamaApi();

async function status({ servers, buildInfo, sitting, ollama: api = ollama }) {
  const list = await servers.list();
  const services = list.map((s) => ({ name: s.id, label: s.label, port: s.port, up: s.status === 'up', status: s.status, pid: s.pid ?? null, started: s.started ?? null }));
  let o = { up: false, version: null, models: [] };
  try {
    const v = await api.version();
    const ps = await api.ps();
    o = {
      up: true,
      version: v.version || null,
      models: (ps.models || []).map((m) => ({ name: m.name || m.model, size_vram: m.size_vram ?? null, expires_at: m.expires_at ?? null })),
    };
  } catch (e) {
    o.error = e.message;
  }
  const n = sitting();
  return { services, secondbrain: { build: buildInfo(), pid: process.pid }, ollama: o, sitting: n ? { open: true, n } : { open: false } };
}

/**
 * One estate tool's call → the text of its result, or { error }. `deps`: { servers (services.cjs registry), buildInfo,
 * check, apply (updater.cjs), sitting() (the open sitting's number on the ground, or ''), history ({ read }), ollama }.
 */
async function estateCall(name, args, deps, { writes = false } = {}) {
  args = args || {};
  if (!NAMES.includes(name)) return { error: `no tool ${name}` };
  if (isWrite(name, args) && !writes) return { error: `${name}${name === 'app_update' ? ' apply' : ''} is a write; the user allows reads only (SecondBrain → Settings → Share)` };
  try {
    if (name === 'estate_status') return JSON.stringify(await status(deps));
    if (name === 'estate_logs') {
      const lines = Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(Number(args.lines) || 100)));
      const r = deps.servers.log(String(args.service || ''), lines);
      return r.ok ? JSON.stringify({ service: String(args.service), file: r.file, text: r.text }) : { error: r.error };
    }
    if (name === 'service_control') {
      const id = String(args.service || '').trim();
      const action = String(args.action || '');
      if (SELF.includes(id.toLowerCase())) return { error: 'SecondBrain is not started or stopped by its own tools: it is the one serving them.' };
      if (!ACTIONS.includes(action)) return { error: `Unknown action: ${action} (start, stop or restart)` };
      if (id === 'door' && action !== 'start') {
        const n = deps.sitting();
        if (n) return { error: `Sitting ${n} is open in Manjuel: the door is not stopped under it (RULE 9). Ask the operator to close it first.` };
      }
      const r = await deps.servers.control(id, action);
      return r.ok ? JSON.stringify({ service: id, action, ok: true }) : { error: r.error };
    }
    if (name === 'ollama_unload') {
      const model = String(args.model || '').trim();
      if (!model) return { error: 'ollama_unload needs the model' };
      const r = await (deps.ollama || ollama).unload(model);
      return JSON.stringify({ model, unloaded: true, done_reason: r.done_reason || null });
    }
    if (name === 'app_update') {
      if (args.action === 'check') return JSON.stringify(await deps.check());
      if (args.action === 'apply') return JSON.stringify(await deps.apply());
      return { error: 'app_update action is check or apply' };
    }
    if (name === 'approvals_history') return JSON.stringify(deps.history.read(Math.min(MAX_HISTORY, Number(args.limit) || 50)));
  } catch (e) {
    return { error: e.message };
  }
  return { error: `no tool ${name}` };
}

module.exports = { ESTATE_TOOLS, NAMES, estateCall, isWrite, ollama, ollamaApi, status, MAX_LOG_LINES, MAX_HISTORY };
