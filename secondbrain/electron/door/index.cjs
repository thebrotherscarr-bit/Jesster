/**
 * SecondBrain IS the door (Kyle's order, 2026-10-22): the Atlas door's tools,
 * ported from atlas/line (Go) and served by this app at its own MCP endpoint,
 * POST /mcp, beside the notes, so no separate atlas-mcp process is needed.
 *
 * The worlds are the two the glass's door line carries (atlasglass.doorArgs):
 * `research`, the Manjuel ground, and `atlas`, ground/atlas, `research` the
 * default. Anything reaching /mcp is a client and never the operator's glass,
 * so every writing call is HELD; the operator's hand is this app's own window,
 * which lists the holds and answers them over IPC (door:holds, door:answer).
 *
 * The port lands in pieces (the note plan-secondbrain-is-the-door): ORDER is
 * the Go door's whole surface, in its registration order, and REMAINING is what
 * is not ported yet. Since 2026-10-22 (his card: "Forward them now") every
 * REMAINING tool is still listed and served: SecondBrain's own gate judges the
 * call, then hands it to the Atlas door it runs inside itself (forward.cjs).
 *
 * Since 2026-10-23 (plan-one-exe) the same door also answers on 8090, the port the glass and
 * every other client of the old Go door use (listen.cjs, started by atlasglass.cjs at boot).
 */
const path = require('path');
const { Tenants } = require('./tenant.cjs');
const { Registry, holdTools } = require('./registry.cjs');
const { recordTools } = require('./records.cjs');
const { gitTools } = require('./git.cjs');
const { authTools } = require('./auth.cjs');
const { engines } = require('./engine.cjs');
const { InnerDoor, forwardedTools } = require('./forward.cjs');

/** The Go door's 97 tools, in the order atlas/line/internal/tools/tools.go registers them (`notes` since 2026-10-23). */
const ORDER = [
  'get_in_line', 'verify_chain', 'muster', 'read_handoffs', 'list_doctrine', 'read_doctrine', 'check_the_wall', 'git', 'git_diff',
  'git_commit', 'git_push', 'git_pull', 'git_branch', 'git_pr', 'hold_list', 'hold_answer', 'shell_run', 'aider_run', 'aider_undo',
  'aider_status', 'file_edit', 'secret_set', 'law_status', 'law_add', 'law_seal', 'git_tag', 'git_remote', 'records', 'notes', 'seats', 'proofs',
  'projects', 'state_matrix', 'read_plan', 'ask_steward', 'remember', 'mesh_enroll', 'mesh_post', 'mesh_read', 'mesh_chain', 'mesh_cite',
  'rack_list', 'rack_ask', 'rack_open', 'memory', 'rack_plan', 'rack_pull', 'rack_warm', 'rack_sync', 'chat_start', 'chat_send',
  'chat_list', 'chat_cancel', 'chat_sessions', 'prompt_save', 'prompt_get', 'prompt_list', 'prompt_run', 'prompt_compare', 'prompt_eval',
  'seat_ask', 'town_beat', 'town_status', 'flow_save', 'flow_get', 'flow_list', 'flow_run', 'flow_resume', 'flow_cancel', 'flow_status',
  'flow_compare', 'flow_replay', 'flow_runs', 'team_send', 'team_status', 'team_history', 'team_ingest', 'auth_key_create', 'auth_key_list',
  'auth_key_revoke', 'auth_key_scope', 'auth_verify', 'tenant_trust_list', 'us_to_vc', 'tenant_list', 'tenant_rbac_assign',
  'tenant_rbac_check', 'tenant_trust', 'env_open', 'env_close', 'env_list', 'run_start', 'run_answer', 'standup_run', 'suite_run',
  'release_step', 'run_cancel',
];

// THE NATIVE TOOLS. The engine tools are ported (engine.cjs) but FORWARDED for now, with
// env_list: a flow's run node needs the engine in the process that runs the flow, and the
// flows are forwarded, so the engine stands in the inner door until the flows come home too.
const PORTED_TOOLS = [...holdTools, ...recordTools.filter((t) => t.name !== 'env_list'), ...gitTools, ...authTools];

const PORTED = ORDER.filter((n) => PORTED_TOOLS.some((t) => t.name === n));
/** Served by forwarding to the inner Atlas door (forward.cjs), until each is ported. */
const REMAINING = ORDER.filter((n) => !PORTED.includes(n));

const INSTRUCTIONS = `You are a seat at the atlas household. state = fold(record):
nothing is deleted; append and supersede. Propose, never dispose —
can_approve is false in every declaration, and approval lives in the
operator's hand alone. This server carries MANY projects: name the project
you mean on every call; strangers get nothing.`;

/** The operator's own hand: this app's window, never a client of /mcp. */
const OPERATOR = Object.freeze({ name: 'operator (SecondBrain)', service: true });
/** Anything that reaches /mcp with the share key. */
const CLIENT = Object.freeze({ name: 'secondbrain share key', service: false });

/**
 * A door over named worlds: [[name, home], ...]. Carried in name order, as
 * main.go adds its --tenant flags (sortedKeys), so muster reads the same; with
 * no default given, tenant.Default's own choice (neiro, then atlas, then first).
 */
const noInner = () => {
  throw new Error('this tool is forwarded to the inner Atlas door, and none is running here');
};

function build(worlds, { defaultProject = '', holdWrites = true, coreCmd = '', getInner = noInner } = {}) {
  const tenants = new Tenants();
  const byName = [...worlds].map(([n, h]) => [String(n).toLowerCase(), h]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, home] of byName) tenants.add(name, home);
  if (defaultProject) tenants.setDefault(defaultProject);
  const reg = new Registry(tenants, { holdWrites });
  // the command that runs Manjuel (the Go door's --manjuel), read by the engine tools
  reg.coreCmd = coreCmd;
  const forwarded = forwardedTools(REMAINING, getInner);
  for (const n of ORDER) {
    const t = PORTED_TOOLS.find((x) => x.name === n) || forwarded.find((x) => x.name === n);
    if (t) reg.add(t);
  }
  return reg;
}

/** The worlds the glass's door carries for a Manjuel ground. */
function worldsFor(ground) {
  return [
    ['research', ground],
    ['atlas', path.join(ground, 'atlas')],
  ];
}

/**
 * What atlas.handleMcp serves: the door's tools listed after the notes', and a
 * door tool's call answered as MCP content. `getGround` is read at every call,
 * so a ground set in Settings is carried without a restart; the hold queue
 * lives as long as the ground does.
 */
function serve(getGround, opts = {}) {
  let ground = null;
  let reg = null;
  let inner = null;
  const current = () => {
    const g = getGround();
    if (!g) {
      ground = null;
      reg = null;
      return null;
    }
    if (g !== ground) {
      if (inner) inner.stop();
      ground = g;
      inner = new InnerDoor(g);
      reg = build(worldsFor(g), { defaultProject: 'research', coreCmd: `python ${path.join(g, 'manjuel.py')}`, getInner: () => inner, ...opts });
    }
    return reg;
  };
  return {
    instructions: INSTRUCTIONS,
    list: () => {
      const r = current();
      return r ? r.schemas() : [];
    },
    has: (name) => {
      const r = current();
      return Boolean(r && r.get(name));
    },
    /** { text, isError } for MCP content; a refusal is an error, a held call is not. */
    async call(name, args, caller = CLIENT) {
      const r = current();
      if (!r) return { text: 'The Atlas ground was not found. Set it in Settings → Atlas & Manjuel (the folder with manjuel.py).', isError: true };
      try {
        return { text: String(await r.call(name, args, caller)), isError: false };
      } catch (e) {
        return { text: e && e.message ? e.message : String(e), isError: true };
      }
    },
    registry: () => current(),
    /** the inner door, for the engine's streams on 8090 (listen.cjs) */
    inner: () => (current() ? inner : null),
    /** the inner door goes down with SecondBrain */
    stop: () => {
      if (inner) inner.stop();
    },
  };
}

/** main.cjs's one line: the door into atlas.handleMcp, and the operator's hand over IPC. */
function register({ atlas, ipcMain, guard, getSettings, vaultDir }) {
  const { findGround } = require('../atlasglass.cjs');
  const door = serve(() => findGround((getSettings().get('atlas') || {}).ground, vaultDir()));
  atlas.useDoor(door);
  process.on('exit', () => door.stop());
  ipcMain.handle('door:holds', async (event, project) => {
    guard(event);
    return door.call('hold_list', project ? { project: String(project) } : {}, OPERATOR);
  });
  ipcMain.handle('door:answer', async (event, id, decision) => {
    guard(event);
    return door.call('hold_answer', { id: String(id || ''), decision: String(decision || '') }, OPERATOR);
  });
  return door;
}

module.exports = { register, serve, build, worldsFor, engines, ORDER, PORTED, REMAINING, INSTRUCTIONS, OPERATOR, CLIENT };
