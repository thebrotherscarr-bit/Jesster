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
// the same way as his service, on the port MAF's MCP hosting samples use (mcp_app.py's PORT)
const MCP_PORT = 8000;
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
 */
async function turn({ base, text, previous, approve, onEvent = () => {}, signal, stream = postStream }) {
  // Plan mode is plain conversation: Steward's one card is his request_execute, an approval request
  // like any other, so the turn asks for no response format (Steward's ApprovedModeSwitch, 2026-10-31)
  let body = { input: text, stream: true, ...(previous ? { previous_response_id: previous } : {}) };
  const calls = [];
  const answers = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const asks = [];
    const seen = new Set();
    const take = (item) => {
      const key = item.id || `${item.type}:${item.call_id || ''}:${JSON.stringify(item.content || item.output || item.arguments || '')}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (item.type === 'function_call') {
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
      if (e.type === 'response.output_text.delta' && e.delta) {
        onEvent({ type: 'delta', text: e.delta });
      }
      // his thinking, as MAF's hosting streams text_reasoning content (reasoning summary deltas); the
      // guide's console shows it live (observers/reasoning_display.py), and so does the Agent tab
      else if (e.type === 'response.reasoning_summary_text.delta' && e.delta) {
        onEvent({ type: 'thinking', text: e.delta });
      }
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
      const allow = await approve(a.name, args, `${a.name} ${JSON.stringify(args, null, 2)}`);
      decisions.push({ type: 'mcp_approval_response', approval_request_id: a.id, approve: Boolean(allow) });
    }
    body = { input: decisions, stream: true, previous_response_id: r.id };
  }
  throw new Error(`Steward was still asking for approvals after ${MAX_ROUNDS} rounds; the turn was stopped.`);
}

/**
 * The service, started when needed. `ensure()` resolves the base URL once something answers on
 * the port, starting Steward first when nothing does; or rejects with what is missing.
 *
 * `script`, `port` and `log` name what is started: his service by default, or his MCP door
 * (MCP_SCRIPT on MCP_PORT, its own log), which SecondBrain starts and stops the same way.
 */
function service({ getConfig, vaultDir, answering, waitFor, startOwned, wait = 90000, script = SCRIPT, port: fixedPort = 0, log = 'steward.log' }) {
  let starting = null;
  async function ensure() {
    const cfg = getConfig() || {};
    const port = fixedPort || Number(cfg.port) || PORT;
    const base = `http://127.0.0.1:${port}`;
    if (await answering(port)) return base;
    if (!starting) {
      starting = (async () => {
        const dir = findSteward(cfg.dir, vaultDir(), script);
        if (!dir) throw new Error('Steward was not found: SecondBrain looks for worlds\\steward beside the notes folder, or the folder in Settings (agent.steward.dir).');
        const python = path.join(dir, ...PYTHON);
        if (!fs.existsSync(python)) throw new Error(`Steward's Python was not found at ${python}.`);
        startOwned(python, [path.join(...script)], dir, { ...process.env, STEWARD_PORT: String(port) }, [log, log]);
        if (!(await waitFor(port, wait))) throw new Error(`Steward's ${script[script.length - 1]} did not answer on port ${port}; its log is ${path.join(dir, log)}.`);
        return base;
      })().finally(() => {
        starting = null;
      });
    }
    return starting;
  }
  return { ensure };
}

/**
 * Each Agent-tab conversation's thread with Steward, kept across restarts: his last response id
 * (his service keeps the replies themselves, and his mode). One small JSON file.
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

module.exports = { turn, service, findSteward, postJson, postStream, threads, PORT, MCP_PORT, MCP_SCRIPT };
