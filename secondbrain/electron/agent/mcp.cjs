/**
 * MCP client: other tool servers' tools become the agent's tools.
 *
 * Config: <vault>/.secondbrain/mcp.json, in the same shape Claude Code and
 * Cursor use, so an existing block can be pasted in:
 *
 *   { "mcpServers": { "notes": { "command": "python", "args": ["notes/cli.py", "mcp"],
 *                                "env": {}, "trusted": false, "enabled": true,
 *                                "include": ["notes_search", "notes_get"] } } }
 *
 * "include" (optional) limits which of a server's tools the agent is offered:
 * a big server's whole catalogue costs the model context on every turn.
 *
 * stdio transport, JSON-RPC 2.0 one message per line. Each server's tools
 * appear as mcp__<server>__<tool>. Calls need the user's OK unless the
 * server is marked trusted: an outside server's tools can do anything.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROTOCOL = '2025-06-18';
const CALL_TIMEOUT = 120000;
const START_TIMEOUT = 60000;

function toolName(server, tool) {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

class McpServer {
  constructor(name, spec, log = () => {}) {
    this.name = name;
    this.spec = spec;
    this.log = log;
    this.proc = null;
    this.seq = 0;
    this.waiting = new Map();
    this.tools = [];
    this.status = 'stopped';
    this.error = null;
    this.stderr = '';
  }

  request(method, params, timeout = CALL_TIMEOUT) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${this.name}: ${method} timed out`));
      }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  }

  send(msg) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error(`${this.name} is not running`);
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  async start() {
    const { command, args = [], env = {}, cwd } = this.spec;
    const cmd = Array.isArray(command) ? command[0] : command;
    const argv = Array.isArray(command) ? [...command.slice(1), ...args] : args;
    if (!cmd) throw new Error(`${this.name}: no command`);
    this.status = 'starting';
    this.proc = spawn(cmd, argv, {
      cwd: cwd || undefined,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // npx, uvx and friends are .cmd scripts on Windows
      shell: process.platform === 'win32' && !/\.exe$/i.test(cmd),
    });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a server printing logs to stdout
        }
        const w = msg.id != null && this.waiting.get(msg.id);
        if (w) {
          clearTimeout(w.timer);
          this.waiting.delete(msg.id);
          if (msg.error) w.reject(new Error(`${this.name}: ${msg.error.message}`));
          else w.resolve(msg.result);
        }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    const exited = new Promise((_, reject) =>
      this.proc.on('exit', (code) => {
        this.status = 'stopped';
        for (const w of this.waiting.values()) {
          clearTimeout(w.timer);
          w.reject(new Error(`${this.name} exited (${code}). ${this.stderr.slice(-300)}`));
        }
        this.waiting.clear();
        reject(new Error(`${this.name} exited (${code}). ${this.stderr.slice(-300)}`));
      })
    );
    this.proc.on('error', (e) => {
      this.error = e.message;
      this.status = 'error';
    });
    exited.catch(() => {});
    try {
      await Promise.race([
        this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'secondbrain', version: '1' } }, START_TIMEOUT),
        exited,
      ]);
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = [];
      let cursor;
      do {
        const r = await this.request('tools/list', cursor ? { cursor } : undefined, START_TIMEOUT);
        tools.push(...(r.tools || []));
        cursor = r.nextCursor;
      } while (cursor);
      this.tools = tools;
      this.status = 'connected';
      this.error = null;
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.stop();
      throw e;
    }
    return this.tools;
  }

  async call(tool, args) {
    const r = await this.request('tools/call', { name: tool, arguments: args || {} });
    const text = (r.content || [])
      .map((c) => (c.type === 'text' ? c.text : c.type === 'resource' ? c.resource?.text || '' : `[${c.type}]`))
      .join('\n');
    if (r.isError) throw new Error(text || 'the tool reported an error');
    return text || JSON.stringify(r.structuredContent || r);
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* gone */
      }
      this.proc = null;
    }
    if (this.status !== 'error') this.status = 'stopped';
  }
}

class McpClient {
  constructor(getVault) {
    this.getVault = getVault;
    this.servers = new Map();
  }

  file() {
    return path.join(this.getVault().dir, '.secondbrain', 'mcp.json');
  }

  readConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      return raw.mcpServers || raw.servers || {};
    } catch {
      return {};
    }
  }

  rawConfig() {
    try {
      return fs.readFileSync(this.file(), 'utf8');
    } catch {
      return JSON.stringify({ mcpServers: {} }, null, 2);
    }
  }

  writeConfig(text) {
    const parsed = JSON.parse(text); // throws on bad JSON, before anything is written
    if (!parsed || typeof parsed !== 'object' || !(parsed.mcpServers || parsed.servers)) {
      throw new Error('expected { "mcpServers": { "name": { "command": "...", "args": [] } } }');
    }
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(parsed, null, 2));
  }

  /** (Re)start every enabled server; returns agent tools for the ones that connected. */
  async connect() {
    this.stopAll();
    const cfg = this.readConfig();
    const tools = [];
    await Promise.all(
      Object.entries(cfg).map(async ([name, spec]) => {
        if (spec.enabled === false) return;
        const s = new McpServer(name, spec);
        this.servers.set(name, s);
        try {
          await s.start();
        } catch {
          return; // status shows the error
        }
        const include = Array.isArray(spec.include) && spec.include.length ? new Set(spec.include) : null;
        for (const t of s.tools) {
          if (include && !include.has(t.name)) continue;
          tools.push({
            name: toolName(name, t.name),
            description: `[${name}] ${t.description || t.name}`.slice(0, 1000),
            parameters: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
            risky: !spec.trusted,
            describe: (a) => `${name} → ${t.name}\n${JSON.stringify(a, null, 1)}`,
            run: (a) => s.call(t.name, a),
          });
        }
      })
    );
    return tools;
  }

  status() {
    return [...this.servers.values()].map((s) => ({
      name: s.name, status: s.status, error: s.error, tools: s.tools.map((t) => t.name), trusted: Boolean(s.spec.trusted),
      offered: Array.isArray(s.spec.include) && s.spec.include.length ? s.tools.filter((t) => s.spec.include.includes(t.name)).length : s.tools.length,
    }));
  }

  stopAll() {
    for (const s of this.servers.values()) s.stop();
    this.servers.clear();
  }
}

module.exports = { McpClient, McpServer, toolName };
