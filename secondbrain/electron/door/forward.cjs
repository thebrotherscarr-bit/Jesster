/**
 * The door's tools not yet ported, FORWARDED (Kyle's card, 2026-10-22: "Forward them now"):
 * SecondBrain runs Atlas's own door (atlas-mcp.exe) inside itself, on loopback, and hands it
 * every call for a tool it does not run natively. So SecondBrain serves all 96 tools today,
 * one app and one MCP, and native ports replace forwarded tools a group at a time.
 *
 * THE GATE STAYS SECONDBRAIN'S. Every forwarded tool is registered in SecondBrain's own
 * Registry with the Go door's flags (tools.json, read off atlas/line/internal/tools): a
 * client's write parks for his Approve and a tool that is his hand alone is refused to
 * anyone else, before anything is forwarded. The inner door is started with --auth and a
 * service wire SecondBrain makes fresh at each launch (never his .env's, never shown), so
 * what it is handed it runs as the operator: it has already been judged.
 *
 * The inner door starts at the first forwarded call and goes down with SecondBrain.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TABLE = require('./tools.json');
const INNER_PORT = 43112;

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

class InnerDoor {
  constructor(ground, { port = INNER_PORT, spawnFn = spawn, fetchFn = fetch } = {}) {
    this.ground = ground;
    this.port = port;
    this.spawnFn = spawnFn;
    this.fetchFn = fetchFn;
    this.secret = crypto.randomBytes(24).toString('hex');
    this.child = null;
    this.starting = null;
    this.seq = 0;
  }

  args() {
    const g = this.ground.replace(/\\/g, '/');
    return ['--http', `127.0.0.1:${this.port}`, '--auth', '--tenant', `research=${g}`, '--tenant', `atlas=${g}/atlas`,
      '--default-project', 'research', '--manjuel', `python ${g}/manjuel.py`];
  }

  /** Start it once; a second caller waits on the same start. */
  start() {
    if (this.child && this.child.exitCode === null) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (await answering(this.port)) throw new Error(`port ${this.port} is taken by another program, so SecondBrain's inner Atlas door cannot start there`);
      const line = path.join(this.ground, 'atlas', 'line');
      const exe = path.join(line, 'atlas-mcp.exe');
      if (!fs.existsSync(exe)) throw new Error(`the Atlas door is not at ${exe}`);
      const out = fs.openSync(path.join(line, 'mcp-secondbrain.log'), 'a');
      const err = fs.openSync(path.join(line, 'mcp-secondbrain.err.log'), 'a');
      this.child = this.spawnFn(exe, this.args(), {
        cwd: line, env: { ...process.env, ATLAS_SERVICE: this.secret }, windowsHide: true, stdio: ['ignore', out, err],
      });
      this.child.on('error', () => {});
      const end = Date.now() + 20000;
      while (Date.now() < end) {
        if (await answering(this.port)) return;
        if (this.child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`SecondBrain's inner Atlas door did not start on port ${this.port}; see ${path.join(line, 'mcp-secondbrain.err.log')}`);
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  stop() {
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.kill();
      } catch {
        /* gone */
      }
    }
    this.child = null;
  }

  /** One tools/call, as the operator. Resolves the tool's text; rejects with its refusal. */
  async call(name, args) {
    await this.start();
    const r = await this.fetchFn(`http://127.0.0.1:${this.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.secret },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(30 * 60000),
    });
    const msg = await r.json();
    if (msg.error) throw new Error(msg.error.message || 'the inner door refused');
    const res = msg.result || {};
    const text = (res.content || []).map((c) => c.text || '').join('\n');
    if (res.isError) throw new Error(text || 'the tool failed');
    return text;
  }
}

/** Strip the door's reserved keys before a call leaves SecondBrain. */
function plainArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) if (!k.startsWith('__')) out[k] = v;
  return out;
}

/** Registry entries for `names`, each forwarded to `inner`, flagged as the Go door flags them. */
function forwardedTools(names, getInner) {
  return TABLE.filter((t) => names.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    args: t.args,
    writes: t.writes,
    reads: t.reads,
    serviceOnly: t.serviceOnly,
    secrets: t.secrets,
    forwarded: true,
    fn: (tn, args) => getInner().call(t.name, { ...plainArgs(args), project: tn.name }),
  }));
}

module.exports = { InnerDoor, forwardedTools, TABLE, INNER_PORT };
