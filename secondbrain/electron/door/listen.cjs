/**
 * SecondBrain IS the door on 8090 (the note plan-one-exe, piece 1; Kyle's word, 2026-10-23: "I
 * want ONE .exe as secondbrain, that SERVES all my other shit through MCP ... the door, the gate,
 * the glass, everything COMES FROM SECONDBRAIN"). The Go door's HTTP surface
 * (atlas/line/internal/httpserver), answered by this app on the port the glass, the Claude bridge
 * and atlas-desktop.exe already use, so none of them changes:
 *
 *   POST /rpc     newline-delimited JSON-RPC, the 96 tools through SecondBrain's own gate
 *   GET  /tools   the tools, as tools/list gives them
 *   GET  /health  GET /metrics
 *   GET  /chat/stream, /run/stream, /run/state, /run/listen: the engine's streams, handed as they
 *                 are to the inner door (forward.cjs) until the engine comes home (piece 2)
 *
 * WHO IS ASKING is read off the transport, as the Go door reads it (httpserver/auth.go): the
 * glass's service wire is the operator; an atl_ key from a world's state/auth.json is a client,
 * held to the worlds it carries, its writes parked for his Approve; anyone else gets 401 (only
 * auth_verify is open). The streams are the glass's alone here: a stream runs the engine with no
 * hold, so a client is not let through to one.
 */
const http = require('http');
const crypto = require('crypto');
const auth = require('./auth.cjs');

const DOOR_PORT = 8090;
const STREAMS = ['/chat/stream', '/run/stream', '/run/state', '/run/listen'];

function bearer(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return m ? m[1].trim() : '';
}

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The credential a bearer carries: { ok, service, name, tenants }. */
function credentialFor(token, reg, wire) {
  if (!token) return { ok: false };
  if (wire && same(token, wire)) return { ok: true, service: true, name: '', tenants: ['*'] };
  if (!reg || !auth.KEY_RE.test(token)) return { ok: false };
  for (const name of reg.tenants.names()) {
    let tn;
    try {
      tn = reg.tenants.resolve(name);
    } catch {
      continue;
    }
    try {
      const rec = auth.verify(tn.home, token);
      return { ok: true, service: false, name: rec.id, tenants: [tn.name, ...(rec.tenants || [])] };
    } catch {
      /* not this world's key */
    }
  }
  return { ok: false };
}

/** The Go door's gateCall: '' to let the call through, else the refusal (401 or 403 first). */
function gate(name, args, cred, reg) {
  if (name === 'auth_verify') return '';
  if (!cred.ok) return '401: a bearer key rides Authorization — strangers get nothing';
  if (cred.service) return '';
  let project = '';
  try {
    project = reg.tenants.resolve(typeof args.project === 'string' ? args.project : '').name;
  } catch {
    return '403: unknown project — not a carried tenant';
  }
  if (!cred.tenants.includes('*') && !cred.tenants.includes(project)) return `403: key ${cred.name} does not carry project "${project}"`;
  return '';
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** One JSON-RPC line → its response, or null for a notification. */
async function answerLine(text, cred, door) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return fail(null, -32700, 'parse error');
  }
  const id = msg && msg.id !== undefined ? msg.id : null;
  const method = msg && msg.method;
  const params = (msg && msg.params) || {};
  if (method === 'tools/call') {
    const reg = door.registry();
    const why = reg ? gate(String(params.name || ''), params.arguments || {}, cred, reg) : cred.service ? '' : '403: unknown project — not a carried tenant';
    if (why) return fail(id, why.startsWith('401') ? -32001 : why.startsWith('403') ? -32003 : -32600, why);
  }
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'secondbrain-door', version: '1' },
        instructions: door.instructions,
      });
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: door.list() });
    case 'tools/call': {
      if (!door.has(params.name)) return fail(id, -32602, `unknown tool "${params.name}"`);
      const out = await door.call(params.name, params.arguments || {}, { name: cred.name || '', service: Boolean(cred.service) });
      const content = [{ type: 'text', text: out.text }];
      return ok(id, out.isError ? { isError: true, content } : { content });
    }
    default:
      return fail(id, -32601, `unknown method "${method}"`);
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Serve `door` (index.cjs serve()) on loopback. `wire` is the glass's service wire. Resolves the
 * listening server; rejects when the port is taken.
 */
function listen(door, { wire = '', port = DOOR_PORT, host = '127.0.0.1' } = {}) {
  const counts = new Map();
  const count = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  const who = (req) => credentialFor(bearer(req.headers.authorization), door.registry(), wire);

  async function rpc(req, res) {
    const cred = who(req);
    const out = [];
    for (const line of (await readBody(req)).split('\n')) {
      if (!line.trim()) continue;
      const r = await answerLine(line, cred, door);
      if (r) {
        count(r.error ? 'error' : 'rpc');
        out.push(JSON.stringify(r));
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(out.length ? out.join('\n') + '\n' : '');
  }

  async function stream(req, res) {
    if (!who(req).service) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end("401: the engine's streams are the glass's alone");
      return;
    }
    const inner = door.inner();
    if (!inner) return json(res, 503, { error: 'the Atlas ground was not found' });
    await inner.start();
    count(req.url.split('?')[0]);
    const headers = { Authorization: 'Bearer ' + inner.secret };
    for (const h of ['accept', 'last-event-id']) if (req.headers[h]) headers[h] = req.headers[h];
    const up = http.request({ host: '127.0.0.1', port: inner.port, path: req.url, method: 'GET', headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => {
      if (!res.headersSent) json(res, 502, { error: e.message });
      else res.end();
    });
    res.on('close', () => up.destroy());
    up.end();
  }

  const server = http.createServer(async (req, res) => {
    const where = req.url.split('?')[0];
    try {
      if (req.method === 'POST' && where === '/rpc') return await rpc(req, res);
      if (req.method === 'GET' && where === '/tools') return json(res, 200, { tools: door.list() });
      if (req.method === 'GET' && where === '/health') return json(res, 200, { status: 'ok', server: 'secondbrain-door', version: '1', auth: true });
      if (req.method === 'GET' && where === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end([...counts].map(([k, n]) => `secondbrain_door_calls{what=${JSON.stringify(k)}} ${n}`).join('\n') + '\n');
        return;
      }
      if (req.method === 'GET' && STREAMS.includes(where)) return await stream(req, res);
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e && e.message ? e.message : String(e) });
      else res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e && e.code === 'EADDRINUSE' ? new Error(`port ${port} is taken by another program, so SecondBrain cannot be the door there`) : e));
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { listen, credentialFor, gate, answerLine, bearer, DOOR_PORT, STREAMS };
