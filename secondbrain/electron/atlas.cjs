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
const estate = require('./estate.cjs');
const mcpv = require('./mcpversion.cjs');

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

// Steward (the MAF agent in worlds/steward) is SecondBrain's agent: it gets the web tools, the
// long-term memory notes (agent-memory, user-profile) and skill saving, beside the notes.
// The Estate's tools (estate.cjs): what SecondBrain runs, for Steward to see and work. app_update is listed with the
// reads for its check; its apply is a write, refused while writes are off.
// eval_start is an Estate action of the bounded kind, read-class here (served while writes are off, never on a card):
// it only runs Steward's eval sets, which write only his eval history and throwaway working copies (estate.cjs).
const ESTATE_READ_TOOLS = ['estate_status', 'estate_logs', 'approvals_history', 'app_update', 'eval_start', 'eval_status', 'saved_flows', 'saved_flow_run'];
const ESTATE_WRITE_TOOLS = ['service_control', 'ollama_unload'];
const READ_TOOLS = ['search_notes', 'read_note', 'list_notes', 'search_sessions', 'skills_list', 'skill_view', 'web_search', 'web_fetch', ...ESTATE_READ_TOOLS];
const WRITE_TOOLS = ['write_note', 'append_to_note', 'todo', 'memory', 'skill_save', ...ESTATE_WRITE_TOOLS];
// SecondBrain's browser window and computer use, for Steward too (Kyle, 2026-10-28: "allow clicking and
// typing too", "computer use"). Served only while switched on in Settings, which is when they exist.
const SCREEN_TOOLS = ['browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_back', 'computer_task', 'screen_look'];
const SERVER = { name: 'secondbrain', version: '1' };
const SKILL_INDEX_URI = 'skill://index.json';

// The Agent tab, typed into from outside (Kyle, 2026-10-28: "write an extension for secondbrain so
// you can click in it"): a message goes to the Agent exactly as if typed in the tab, the window
// opens that conversation, and every approval the Agent asks for waits on the user's card there.
// Served only while writes are allowed.
const AGENT_TOOLS = [
  {
    name: 'agent_send',
    description:
      "Type a message into SecondBrain's Agent tab, as the user would. It goes to the Agent (Steward), the window shows the conversation live, and any approval he asks for waits on the user's Allow/Deny card there. Returns the session id at once; read the answer with agent_read.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the message' },
        session_id: { type: 'string', description: 'continue this conversation; omit to start a new one' },
      },
      required: ['text'],
    },
  },
  {
    name: 'agent_read',
    description: "Read one Agent-tab conversation: whether the Agent is still working on it, and its messages so far.",
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
];

// Steward's cards when he runs under his MCP host (mcp_app.py: Manjuel's `maf` face, Aurora's ask_steward), where no
// window of his own can show them: he asks here, the card is raised through the Agent's own card path (the Agent tab,
// the Approvals shelf, Telegram, the approvals history) tagged "Manjuel / MCP", and the call returns its answer. No
// answer in 10 minutes is No. Served while the Agent runs here, writes allowed or not: it only asks.
const APPROVAL_TOOL = {
  name: 'approval_ask',
  description:
    "Ask the user to approve one tool call on SecondBrain's Allow/Deny card (the Agent tab, the Approvals shelf and Telegram), tagged Manjuel / MCP. Waits for the answer, up to 10 minutes (then No), and returns { id, approved, answer }.",
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'the tool that needs approval' },
      arguments: { type: 'object', description: "the call's arguments, shown on the card" },
      summary: { type: 'string', description: 'what the card says; omit to show the tool and its arguments' },
      session_id: { type: 'string', description: 'the conversation the call belongs to' },
    },
    required: ['tool'],
  },
};

/** approval_ask on the app's AgentService (ctx.agent): the card's answer as text, or { error }. */
async function approvalCall(args, { agent, phoneCard }) {
  const name = String(args.tool || '').trim();
  if (!name) return { error: 'approval_ask needs the tool that needs approval' };
  const callArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
  const r = await agent.askCard({
    name,
    args: callArgs,
    summary: typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : undefined,
    sessionId: args.session_id ? String(args.session_id) : '',
    onCard: phoneCard,
  });
  return JSON.stringify({ id: r.id, approved: r.approved, answer: r.answer });
}

/** agent_send / agent_read on the app's AgentService (ctx.agent); the text of the result. */
function agentCall(name, args, { agent, showAgent }) {
  if (name === 'agent_read') {
    if (!args.session_id) return { error: 'agent_read needs a session_id' };
    return JSON.stringify(agent.open(String(args.session_id)));
  }
  const text = String(args.text || '').trim();
  if (!text) return { error: 'agent_send needs the text to send' };
  const sessionId = args.session_id ? String(args.session_id) : require('./agent/agent.cjs').newSessionId();
  if (agent.sessions.get(sessionId)?.busy) return { error: `session ${sessionId} is still working on the last message; read it with agent_read` };
  // not awaited: a turn can take minutes, and its answer is read with agent_read
  agent.ask({ text, sessionId, source: 'app' }).catch(() => {});
  if (showAgent) showAgent(sessionId);
  return JSON.stringify({ session_id: sessionId });
}

/**
 * The vault's skill notes as Agent Skills over MCP (SEP-2640): `skill://index.json` lists them
 * and `skill://<name>/SKILL.md` serves each one, which is how MAF's MCPSkillsSource discovers
 * centrally managed skills. A skill note is "> description" then the instructions.
 */
function skillResources(vault) {
  const { skills, describeSkill } = require('./agent/memory.cjs');
  const { slug } = require('./agent/tools.cjs');
  return (vault ? skills(vault) : []).map((n) => {
    const name = slug(n.title);
    const description = describeSkill(n);
    const body = String(n.content || '').replace(/^>\s*.*(\r?\n)+/, '');
    return {
      name,
      description,
      uri: `skill://${name}/SKILL.md`,
      text: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`,
    };
  });
}

// SecondBrain IS the door (door/index.cjs): the Atlas door's ported tools are
// served here after the notes', with every writing call held for the operator.
let installedDoor = null;

/** door/index.cjs register() installs the door; null takes it out. */
function useDoor(door) {
  installedDoor = door || null;
}

function instructionsFor(writes, door) {
  return (
    `The user's SecondBrain notes vault. ${writes ? 'Reading and writing are allowed.' : 'Read-only: the user has not allowed writes.'}` +
    (door && door.list().length ? `\n\nThe Atlas door is served here too.\n${door.instructions}` : '')
  );
}

/**
 * One JSON-RPC request → its response (or null for a notification), in either MCP era
 * (mcpversion.cjs): a request carrying the 2026-07-28 `_meta` envelope is served statelessly, with
 * server/discover, resultType and the cache hints; `initialize`, and a request without the
 * envelope, are served as before (2025-06-18 and earlier, ping included). `registry` holds the
 * agent's tools; only the shared ones are served. `door` (the installed one unless given) serves
 * the Atlas door's tools beside them. `headers` (Node's, lowercase) turns on the Streamable HTTP
 * header checks for a modern request.
 */
async function handleMcp(msg, opts) {
  const era = mcpv.classify(msg, opts.headers);
  if (era.era === 'legacy') return legacyMcp(msg, opts);
  const { id, method } = msg;
  if (id === undefined || id === null) return null; // a notification
  if (era.error) return { jsonrpc: '2.0', id, error: era.error };
  const writes = Boolean(opts.writes);
  const door = 'door' in opts ? opts.door : installedDoor;
  if (method === 'server/discover') {
    const result = mcpv.discoverResult({ ...SERVER, capabilities: { tools: {}, resources: {} }, instructions: instructionsFor(writes, door) });
    return mcpv.finishModern({ jsonrpc: '2.0', id, result }, method, SERVER);
  }
  if (mcpv.REMOVED.has(method)) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method} (removed in ${mcpv.LATEST})` } };
  const out = await legacyMcp(msg, opts);
  // 2026-07-28 moved "resource not found" from -32002 to -32602 (Invalid Params)
  if (out && out.error && out.error.code === -32002) out.error.code = mcpv.INVALID_PARAMS;
  return mcpv.finishModern(out, method, SERVER);
}

/** POST /mcp (main.cjs): { status, body } for one request; body null is 202 Accepted. */
async function serveMcpHttp(body, headers, opts) {
  const out = await handleMcp(body, { ...opts, headers: headers || {} });
  if (out === null) return { status: 202, body: null };
  const modern = mcpv.classify(body).era === 'modern';
  return { status: modern ? mcpv.httpStatus(out) : 200, body: out };
}

async function legacyMcp(msg, { registry, ctx, writes = false, door = installedDoor }) {
  const allowed = new Set([...READ_TOOLS, ...SCREEN_TOOLS, ...(writes ? WRITE_TOOLS : [])]);
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } };
  }
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return null; // a notification
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    return ok({
      protocolVersion: mcpv.negotiateLegacy(params.protocolVersion),
      capabilities: { tools: {}, resources: {} },
      serverInfo: SERVER,
      instructions: instructionsFor(writes, door),
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'resources/list') {
    const list = skillResources(ctx && ctx.vault);
    return ok({
      resources: [
        { uri: SKILL_INDEX_URI, name: 'skills index', mimeType: 'application/json' },
        ...list.map((s) => ({ uri: s.uri, name: s.name, description: s.description, mimeType: 'text/markdown' })),
      ],
    });
  }
  if (method === 'resources/read') {
    const list = skillResources(ctx && ctx.vault);
    if (params.uri === SKILL_INDEX_URI) {
      const index = { skills: list.map((s) => ({ name: s.name, type: 'skill-md', description: s.description, url: s.uri })) };
      return ok({ contents: [{ uri: SKILL_INDEX_URI, mimeType: 'application/json', text: JSON.stringify(index) }] });
    }
    const hit = list.find((s) => s.uri === params.uri);
    if (!hit) return { jsonrpc: '2.0', id, error: { code: -32002, message: `resource not found: ${params.uri}` } };
    return ok({ contents: [{ uri: hit.uri, mimeType: 'text/markdown', text: hit.text }] });
  }
  if (method === 'tools/list') {
    const notes = registry
      .schemas()
      .filter((t) => allowed.has(t.function.name))
      .map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters }));
    const agentTools = [...(writes && ctx && ctx.agent ? AGENT_TOOLS : []), ...(ctx && ctx.agent ? [APPROVAL_TOOL] : [])];
    // the Estate's, while the app hands them in (ctx.estate); a write only while writes are allowed
    const estateTools = ctx && ctx.estate ? estate.ESTATE_TOOLS.filter((t) => allowed.has(t.name)).map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) : [];
    const taken = new Set([...notes, ...estateTools, ...agentTools].map((t) => t.name));
    return ok({ tools: [...notes, ...estateTools, ...agentTools, ...(door ? door.list().filter((t) => !taken.has(t.name)) : [])] });
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (estate.NAMES.includes(name)) {
      const out = !(ctx && ctx.estate) ? { error: 'the Estate is not served here' } : await estate.estateCall(name, params.arguments || {}, ctx.estate, { writes });
      if (typeof out === 'string') return ok({ content: [{ type: 'text', text: out }], isError: false });
      return ok({ content: [{ type: 'text', text: out.error }], isError: true });
    }
    if (name === APPROVAL_TOOL.name) {
      const out = !(ctx && ctx.agent && ctx.agent.askCard) ? { error: 'the Agent is not running here' } : await approvalCall(params.arguments || {}, ctx);
      if (typeof out === 'string') return ok({ content: [{ type: 'text', text: out }], isError: false });
      return ok({ content: [{ type: 'text', text: out.error }], isError: true });
    }
    if (AGENT_TOOLS.some((t) => t.name === name)) {
      const why = !writes ? `${name} drives the Agent; the user allows reads only (SecondBrain → Settings → Share)` : !(ctx && ctx.agent) ? 'the Agent is not running here' : null;
      const out = why ? { error: why } : agentCall(name, params.arguments || {}, ctx);
      if (typeof out === 'string') return ok({ content: [{ type: 'text', text: out }], isError: false });
      return ok({ content: [{ type: 'text', text: out.error }], isError: true });
    }
    if (!allowed.has(name) && !WRITE_TOOLS.includes(name) && door && door.has(name)) {
      const out = await door.call(name, params.arguments || {}, ctx && ctx.caller);
      return ok({ content: [{ type: 'text', text: out.text }], isError: out.isError });
    }
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

module.exports = { atlasServer, withAtlas, handleMcp, serveMcpHttp, useDoor, keyOk, originOk: mcpv.originOk, FORBIDDEN_ORIGIN: mcpv.FORBIDDEN_ORIGIN, agentCall, approvalCall, APPROVAL_TOOL, DEFAULT_TOOLS, READ_TOOLS, WRITE_TOOLS, AGENT_TOOLS, SCREEN_TOOLS, ESTATE_READ_TOOLS, ESTATE_WRITE_TOOLS };
