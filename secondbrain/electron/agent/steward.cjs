/**
 * Steward is the Agent (Kyle's word, 2026-10-28: "Steward needs to live on the Agent shelf within
 * secondbrain ... set steward as the Agent"; the note plan-steward-is-the-agent, stage 2d).
 *
 * Steward is a Microsoft Agent Framework agent in worlds\steward. His service (step 4's hosted.py)
 * speaks the OpenAI Responses protocol on 127.0.0.1:43120. SecondBrain:
 *
 *   - starts that service as its own child when nothing answers on the port (a running one, say
 *     from a terminal, is used as it is), and stops what it started when it quits;
 *   - sends each Agent-tab message to it, continuing the conversation by the last response id;
 *   - streams each turn, so his tool calls, their results and his text show in the Agent tab as
 *     they happen (Kyle, 2026-10-29: not just a grey blinking word while he works);
 *   - shows Steward's tool calls as tool lines, and his approval requests as the Agent tab's
 *     Allow/Deny cards, sending each answer back as an mcp_approval_response.
 *
 * No key crosses here: the service is loopback only, and Steward reaches SecondBrain with the
 * share key in his own .env.
 */
const fs = require('fs');
const path = require('path');

const PORT = 43120;
const SCRIPT = ['harness', 'steward', 'step04_production_ready', 'hosted.py'];
// Steward as an MCP tool (step 4's mcp_app.py, ADR-0001 item 10), for Manjuel's mcp_call: started
// the same way as his service, beside it (mcp_app.py's PORT; Kyle's word 2026-11-02, it was MAF's samples' 8000)
const MCP_PORT = 43121;
const MCP_SCRIPT = ['harness', 'steward', 'step04_production_ready', 'mcp_app.py'];
const PYTHON = ['.venv', 'Scripts', 'python.exe'];
const MAX_ROUNDS = 20; // approval round-trips in one turn

/** Steward's folder: the one Settings names, else worlds\steward beside the notes folder. */
function findSteward(settingsDir, vaultDir, script = SCRIPT) {
  for (const d of [settingsDir, vaultDir && path.resolve(vaultDir, '..', 'steward')]) {
    if (d && fs.existsSync(path.join(d, ...script))) return d;
  }
  return null;
}

/** POST over node:http: fetch gives up when no headers come within 300 s, and a turn takes longer. */
function httpPost(url, payload, signal) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** One POST to the service; the parsed Responses object, or an Error said plainly. */
async function postJson(url, body, signal) {
  let r;
  try {
    r = await httpPost(url, JSON.stringify(body), signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Steward's service at ${url} did not answer (${e.message}).`);
  }
  const text = r.text;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* said below */
  }
  if (!r.ok || !json) throw new Error(`Steward: ${r.status} ${(json?.error?.message || text).slice(0, 400)}`);
  return json;
}

/**
 * One streamed POST to the service (Responses SSE: `event:` / `data:` frames). Each event is
 * handed to `onFrame` as it arrives, so the Agent tab shows Steward's work live; resolves with the
 * final Responses object from response.completed / failed / incomplete.
 */
function postStream(url, body, signal, onFrame) {
  const http = require('http');
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(payload) }, signal }, (res) => {
      let buf = '';
      let final = null;
      let raw = '';
      const sse = String(res.headers['content-type'] || '').includes('text/event-stream');
      const frame = (block) => {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) return;
        let e;
        try {
          e = JSON.parse(data);
        } catch {
          return;
        }
        if (e.response && /^response\.(completed|failed|incomplete)$/.test(e.type)) final = e.response;
        if (e.type === 'error') final = { status: 'failed', error: { message: e.message || e.error?.message || 'stream error' } };
        onFrame(e);
      };
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (!sse) return void (raw += c);
        buf += c;
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          frame(buf.slice(0, i));
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        }
      });
      res.on('end', () => {
        if (!sse) {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* said below */
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolve(json);
          return reject(new Error(`Steward: ${res.statusCode} ${(json?.error?.message || raw).slice(0, 400)}`));
        }
        if (buf.trim()) frame(buf);
        if (final) resolve(final);
        else reject(new Error(`Steward's stream ended without a final response (HTTP ${res.statusCode}).`));
      });
      res.on('error', reject);
    });
    req.on('error', (e) => reject(e.name === 'AbortError' ? e : new Error(`Steward's service at ${url} did not answer (${e.message}).`)));
    req.end(payload);
  });
}

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  try {
    return JSON.parse(a || '{}');
  } catch {
    return { arguments: String(a) };
  }
}

function textOf(item) {
  return (item.content || []).map((c) => c.text || '').join('');
}

/**
 * One user turn with Steward. `previous` is the last response id of this conversation (or null).
 * `approve(name, args, summary)` resolves true/false for each approval request. Resolves
 * { answer, previous, calls }: calls are { name, arguments } for the session note.
 *
 * The turn is streamed: each tool call, tool result, piece of thinking and piece of text is sent to
 * `onEvent` as Steward produces it ('tool', 'result', 'thinking', 'delta'), instead of all at once
 * when the turn ends.
 *
 * `metadata` rides on every request of the turn, the answers' rounds too (an improve conversation sends
 * {steward_workflow: 'improve'}, so a card's answer reaches the same workflow on his host). A workflow question
 * that is not an approval comes, as MAF's host sends it, as a function call named `request_info`; `review(request)`
 * resolves the reply text, which goes back as that call's function_call_output.
 */
async function turn({ base, text, previous, approve, review, metadata, onEvent = () => {}, signal, stream = postStream }) {
  // Steward's service runs his MAF workflow (steward_workflow.py): it plans, sends the plan as an
  // approval request, and keeps its own modes, so the tab sends only the text (no response_format,
  // no agent_mode) and every piece of his text and thinking streams
  const meta = metadata ? { metadata } : {};
  let body = { input: text, stream: true, ...meta, ...(previous ? { previous_response_id: previous } : {}) };
  const calls = [];
  const answers = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const asks = [];
    const seen = new Set();
    const take = (item) => {
      const key = item.id || `${item.type}:${item.call_id || ''}:${JSON.stringify(item.content || item.output || item.arguments || '')}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (item.type === 'function_call' && item.name === 'request_info') {
        asks.push({ ...item, review: true }); // the workflow's question (the improvement loop's review)
      } else if (item.type === 'function_call') {
        const args = parseArgs(item.arguments);
        calls.push({ name: item.name, arguments: args, call_id: item.call_id });
        onEvent({ type: 'tool', name: item.name, args });
      } else if (item.type === 'function_call_output') {
        // kept on its call, for Claude's check of the turn (checker.cjs)
        const call = calls.find((c) => c.call_id && c.call_id === item.call_id) || calls[calls.length - 1];
        if (call) call.result = String(item.output ?? '');
        onEvent({ type: 'result', name: call?.name || '', text: String(item.output ?? '').slice(0, 2000) });
      } else if (item.type === 'mcp_approval_request') {
        asks.push(item);
      } else if (item.type === 'message') {
        const t = textOf(item);
        if (t) answers.push(t);
      }
    };
    const r = await stream(`${base}/responses`, body, signal, (e) => {
      if (e.type === 'response.output_text.delta' && e.delta) onEvent({ type: 'delta', text: e.delta });
      // his thinking, as MAF's hosting streams text_reasoning content (reasoning summary deltas); the
      // guide's console shows it live (observers/reasoning_display.py), and so does the Agent tab
      else if (e.type === 'response.reasoning_summary_text.delta' && e.delta) onEvent({ type: 'thinking', text: e.delta });
      else if (e.type === 'response.output_item.done' && e.item) take(e.item);
    });
    if (r.status === 'failed' || r.error) throw new Error(`Steward: ${r.error?.message || 'the turn failed'}`);
    // anything the stream did not hand over item by item is taken from the final response
    for (const item of r.output || []) take(item);
    if (!asks.length) {
      const answer = answers.join('\n\n');
      onEvent({ type: 'answer', text: answer });
      return { answer, previous: r.id, calls };
    }
    const decisions = [];
    for (const a of asks) {
      const args = parseArgs(a.arguments);
      if (a.review) {
        if (!review) throw new Error('Steward asked a question this conversation cannot answer.');
        const reply = await review(args.request && typeof args.request === 'object' ? args.request : args);
        decisions.push({ type: 'function_call_output', call_id: a.call_id, output: String(reply) });
        continue;
      }
      const allow = await approve(a.name, args, `${a.name} ${JSON.stringify(args, null, 2)}`);
      decisions.push({ type: 'mcp_approval_response', approval_request_id: a.id, approve: Boolean(allow) });
    }
    body = { input: decisions, stream: true, ...meta, previous_response_id: r.id };
  }
  throw new Error(`Steward was still asking for approvals after ${MAX_ROUNDS} rounds; the turn was stopped.`);
}

/**
 * The service, started when needed. `ensure()` resolves the base URL once something answers on
 * the port, starting Steward first when nothing does; or rejects with what is missing.
 *
 * `script`, `port` and `log` name what is started: his service by default, or his MCP door
 * (MCP_SCRIPT on MCP_PORT, its own log), which SecondBrain starts and stops the same way.
 *
 * `start`, `stop` and `restart` are the Steward window's buttons (Kyle, 2026-11-02: "there should be a way to start
 * and stop all the MCP servers in secondbrain that steward uses"). `stop` ends the Python listening on the port and
 * its whole process tree (`killTree`), whoever started it: on Windows a venv's python.exe is a launcher with the real
 * Python under it, so killing only the child SecondBrain spawned can leave the port held. A stopped service is
 * `held` until Start or Restart, so `keepUp` does not bring it back behind the user's back. `up()` says whether
 * something answers on the port now, starting nothing.
 */
function service({ getConfig, vaultDir, answering, waitFor, startOwned, wait = 90000, startLimit = 180000, script = SCRIPT, port: fixedPort = 0, log = 'steward.log', portEnv = 'STEWARD_PORT', portOwner = () => null, killTree = () => {} }) {
  let starting = null;
  let child = null;
  let held = false;
  let startedAt = null; // when SecondBrain started the child it holds, for estate_status
  let startedMs = 0;
  const portOf = () => fixedPort || Number((getConfig() || {}).port) || PORT;
  async function ensure() {
    const cfg = getConfig() || {};
    const port = portOf();
    const base = `http://127.0.0.1:${port}`;
    if (await answering(port)) return base;
    if (!starting) {
      starting = (async () => {
        // A child it started that has not exited is still starting (mcp_app.py loads its tools for about two
        // minutes before it binds, 2026-11-05): wait for it, up to `startLimit` from its start, and never start a
        // second copy beside it (that one failed with OSError 10048 on the port). Past the limit it is ended first.
        if (alive()) {
          const left = startLimit - (Date.now() - startedMs);
          if (left > 0 && (await waitFor(port, left))) return base;
          if (alive()) killTree(child.pid);
          child = null;
        }
        const dir = findSteward(cfg.dir, vaultDir(), script);
        if (!dir) throw new Error('Steward was not found: Jesster looks for worlds\\steward beside the notes folder, or the folder in Settings (agent.steward.dir).');
        const python = path.join(dir, ...PYTHON);
        if (!fs.existsSync(python)) throw new Error(`Steward's Python was not found at ${python}.`);
        // the port in the variable the script reads (ag_ui_app.py: STEWARD_AG_UI_PORT)
        child = startOwned(python, [path.join(...script)], dir, { ...process.env, [portEnv]: String(port) }, [log, log]);
        startedAt = new Date().toISOString();
        startedMs = Date.now();
        if (!(await waitFor(port, wait))) throw new Error(`Steward's ${script[script.length - 1]} did not answer on port ${port}; its log is ${path.join(dir, log)}.`);
        return base;
      })().finally(() => {
        starting = null;
      });
    }
    return starting;
  }
  const alive = () => Boolean(child && child.pid && child.exitCode === null);
  /**
   * `ownOnly` (SecondBrain quitting): only when SecondBrain started the one running, so a Steward started by hand
   * outlives it. The kills are synchronous, done before the first await, so a quit that does not wait still ends them.
   */
  async function stop({ ownOnly = false } = {}) {
    if (ownOnly && !alive()) return;
    held = true;
    const port = portOf();
    const owner = portOwner(port);
    if (owner && /python/i.test(owner.name || '')) killTree(owner.pid); // never a program that is not his
    if (alive()) killTree(child.pid);
    child = null;
    startedAt = null;
    const gone = await waitFor(port, 15000, answering, true);
    if (!gone) throw new Error(`Something still answers on port ${port} after the stop.`);
  }
  async function start() {
    held = false;
    return ensure();
  }
  async function restart() {
    await stop();
    return start();
  }
  // whether something answers on the port now, without starting anything (Telegram's /status)
  const up = async () => Boolean(await answering(portOf()));
  return {
    ensure,
    start,
    stop,
    restart,
    up,
    held: () => held,
    port: portOf,
    // the child SecondBrain started and when, or null when it holds none (one started by hand)
    pid: () => (alive() ? child.pid : null),
    started: () => (alive() ? startedAt : null),
  };
}

/**
 * Steward's services go down with SecondBrain, each with its whole process tree (stop's kill-tree path): only the venv
 * launcher was killed before (atlasglass stopOwned), so the real Python could keep 43120/43121. `app` is Electron's.
 */
function stopOnQuit(app, services) {
  app.on('before-quit', () => {
    for (const svc of services) svc.stop({ ownOnly: true }).catch(() => {});
  });
}

/**
 * Brings a service back when it is found down and the user has not stopped it (the MCP door has no caller of its
 * own in SecondBrain: Manjuel reaches 43121 directly, so it is checked with the Steward window's status). Resolves
 * true when it started one.
 */
async function keepUp(svc, up) {
  if (up || svc.held()) return false;
  await svc.ensure();
  return true;
}

/**
 * Checks a service every `ms` and brings it back with keepUp. The MCP door's only check was the Steward button's
 * status poll; the console (2026-11-04) removed that button, and after a restart 43121 stayed down. This runs in
 * the main process, whatever the window shows. `probe(port)` answers whether the port is up. Returns the timer.
 */
function keepUpEvery(svc, port, probe, ms = 10000, when = () => true) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !when()) return;
    busy = true;
    try {
      await keepUp(svc, await probe(port));
    } catch (e) {
      console.error('[SecondBrain] keep up:', e.message);
    } finally {
      busy = false;
    }
  }, ms);
  if (timer.unref) timer.unref();
  return timer;
}

/**
 * Each Agent-tab conversation's thread with Steward, kept across restarts: his last response id
 * (his service keeps the replies themselves). One small JSON file.
 */
function threads(file) {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    get: (id) => read()[id] || null,
    set: (id, value) => {
      const all = read();
      all[id] = value;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
    },
  };
}

module.exports = { turn, service, keepUp, keepUpEvery, stopOnQuit, findSteward, postJson, postStream, threads, PORT, MCP_PORT, MCP_SCRIPT };
