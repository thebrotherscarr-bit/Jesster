/**
 * The bridge to Atlas and Manjuel, both ways, without changing either.
 *
 *  SecondBrain → Atlas: atlas-mcp ("the door") started over stdio by the MCP
 *  client, carrying the Manjuel ground as a tenant and (optionally) Manjuel
 *  itself as the engine. Atlas keeps its own law: its writing calls are still
 *  held for the operator's card.
 *
 *  Atlas/Manjuel → SecondBrain: the desktop app serves the notes over MCP on
 *  loopback (POST /mcp, bearer key), the shape Manjuel's own client speaks:
 *  MANJUEL_MCP_SECONDBRAIN=<url> and MANJUEL_MCP_SECONDBRAIN_KEY=<key> in its
 *  .env. Read-only unless the user allows writes.
 */
const path = require('path');

// What the agent is offered from Atlas by default: the estate's records and
// law, memory, chains, the steward and the engine, git as it stands, the
// hold list, team messaging. "All tools" offers every one (96 today).
const DEFAULT_TOOLS = [
  'get_in_line', 'muster', 'records', 'list_doctrine', 'read_doctrine', 'read_plan', 'proofs', 'projects',
  'memory', 'remember', 'verify_chain', 'mesh_chain', 'mesh_read', 'ask_steward',
  'env_open', 'env_close', 'env_list', 'run_start', 'run_answer', 'run_cancel',
  'git', 'git_diff', 'git_pr', 'hold_list', 'team_status', 'team_history', 'team_send',
];

/** The mcpServers entry that launches atlas-mcp for a Manjuel ground. */
function atlasServer({ exe, ground, python = 'python', engine = true, trusted = false, all = false, atlasBin = '' }) {
  if (!exe) throw new Error('choose atlas-mcp.exe');
  if (!ground) throw new Error('choose the Manjuel ground (the folder with manjuel.py)');
  const args = ['--tenant', `research=${ground}`, '--tenant', `atlas=${path.join(ground, 'atlas')}`, '--default-project', 'research'];
  if (engine) args.push('--manjuel', `${python} ${path.join(ground, 'manjuel.py')}`);
  if (atlasBin) args.push('--atlas-bin', atlasBin);
  return { command: exe, args, trusted: Boolean(trusted), enabled: true, ...(all ? {} : { include: DEFAULT_TOOLS }) };
}

/** Put the atlas entry into an mcp.json text, keeping every other server. */
function withAtlas(configText, entry) {
  let cfg;
  try {
    cfg = JSON.parse(configText || '{}');
  } catch {
    cfg = {};
  }
  const servers = cfg.mcpServers || cfg.servers || {};
  servers.atlas = entry;
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

// ---- SecondBrain as an MCP server for Atlas and Manjuel ---------------------

const READ_TOOLS = ['search_notes', 'read_note', 'list_notes', 'search_sessions', 'skills_list', 'skill_view'];
const WRITE_TOOLS = ['write_note', 'append_to_note', 'todo'];
const PROTOCOL = '2025-06-18';

/**
 * One JSON-RPC request → its response (or null for a notification). `registry`
 * holds the agent's tools; only the shared ones are served.
 */
async function handleMcp(msg, { registry, ctx, writes = false }) {
  const allowed = new Set([...READ_TOOLS, ...(writes ? WRITE_TOOLS : [])]);
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } };
  }
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return null; // a notification
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    return ok({
      protocolVersion: params.protocolVersion || PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'secondbrain', version: '1' },
      instructions: `The user's SecondBrain notes vault. ${writes ? 'Reading and writing are allowed.' : 'Read-only: the user has not allowed writes.'}`,
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({
      tools: registry
        .schemas()
        .filter((t) => allowed.has(t.function.name))
        .map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })),
    });
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (!allowed.has(name)) {
      const why = WRITE_TOOLS.includes(name) ? `${name} is a write; the user allows reads only (SecondBrain → Settings → Share)` : `no tool ${name}`;
      return ok({ content: [{ type: 'text', text: why }], isError: true });
    }
    const out = await registry.run(name, params.arguments || {}, ctx);
    if (typeof out === 'string') return ok({ content: [{ type: 'text', text: out }], isError: false });
    return ok({ content: [{ type: 'text', text: out.error }], isError: true });
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

/** Constant-time bearer check. */
function keyOk(header, key) {
  const crypto = require('crypto');
  const got = String(header || '').replace(/^Bearer\s+/i, '');
  if (!key || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { atlasServer, withAtlas, handleMcp, keyOk, DEFAULT_TOOLS, READ_TOOLS, WRITE_TOOLS };
