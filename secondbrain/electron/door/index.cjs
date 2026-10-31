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
const { Registry, holdTools, callerOf, regOf, heldAnswer } = require('./registry.cjs');
const { sittingOpen } = require('./records.cjs');
const { marshal } = require('./util.cjs');
const { recordTools } = require('./records.cjs');
const { gitTools } = require('./git.cjs');
const { authTools } = require('./auth.cjs');
const { gitctlTools } = require('./gitctl.cjs');
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
// The git verbs (gitctl.cjs) since 2026-10-23: the engine of SecondBrain's GitHub shelf (plan-github-shelf, G1).
const PORTED_TOOLS = [...holdTools, ...recordTools.filter((t) => t.name !== 'env_list'), ...gitTools, ...gitctlTools, ...authTools];

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

function build(worlds, { defaultProject = '', holdWrites = true, coreCmd = '', getInner = noInner, extra = [] } = {}) {
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
  innerHolds(reg, getInner);
  // the app's own, beyond the Go door's surface (agentTools); a bare door carries none
  for (const t of extra) reg.add(t);
  return reg;
}

/**
 * THE AGENT TAB, AT THE DOOR (2026-10-31, his word: "do it"). agent_send and agent_read, as /mcp
 * serves them (atlas.cjs), so any client of the door can message Steward in the Agent tab without a
 * connection of its own. agent_send writes, so a client's send is HELD and goes to the Agent only on
 * his Approve; agent_read reads. Only the app adds them (register), so ORDER stays the Go door's.
 */
function agentTools(getAgent, showAgent) {
  const { agentCall } = require('../atlas.cjs');
  const run = (name) => async (t, args) => {
    const out = agentCall(name, args, { agent: getAgent(), showAgent });
    if (typeof out !== 'string') throw new Error(out.error);
    return out;
  };
  return [
    {
      name: 'agent_send',
      writes: true,
      description:
        "type a message into SecondBrain's Agent tab, as the user would: it goes to Steward and the window shows the conversation live. It writes, so it waits for the operator's Approve; name a new session_id (like session-20261031-2100-ab12) to read the answer with agent_read once it runs",
      args: ['text', 'session_id?', 'project?'],
      fn: run('agent_send'),
    },
    {
      name: 'agent_read',
      writes: false,
      description: "one Agent-tab conversation: whether Steward is still working on it, and its messages so far",
      args: ['session_id', 'project?'],
      fn: run('agent_read'),
    },
  ];
}

/**
 * THE INNER DOOR'S HOLDS ARE HIS TOO (2026-10-23). A forwarded call the inner door parks itself -- the
 * glass's own Bash and PowerShell cards, which the Go shell gate holds even for the operator -- is
 * listed by hold_list and answered by hold_answer here, beside this door's own. Without it the glass
 * looked for the card's hold in this door's queue, did not find it, and said "answered elsewhere":
 * every card on build 37 was dead. Only the operator's calls reach the inner queue, and an inner door
 * that is not running is not started for it.
 */
function innerHolds(reg, getInner) {
  const list = reg.get('hold_list');
  const answer = reg.get('hold_answer');
  const running = () => {
    try {
      const d = getInner();
      return d && d.child && d.child.exitCode === null ? d : null;
    } catch {
      return null;
    }
  };
  reg.add({
    ...list,
    fn: async (tn, args) => {
      const out = await list.fn(tn, args);
      const d = running();
      if (!d || !callerOf(args).service) return out;
      try {
        const mine = JSON.parse(out);
        const theirs = JSON.parse(await d.call('hold_list', { project: tn.name }));
        mine.held = [...(mine.held || []), ...(theirs.held || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return marshal(mine, ' ');
      } catch {
        return out;
      }
    },
  });
  reg.add({
    ...answer,
    fn: async (tn, args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const here = regOf(args);
      const d = running();
      if (d && id && callerOf(args).service && here && !here.held.has(id)) {
        try {
          return await d.call('hold_answer', { id, decision: typeof args.decision === 'string' ? args.decision : '', project: tn.name });
        } catch (e) {
          return 'Refused: ' + e.message;
        }
      }
      return answer.fn(tn, args);
    },
  });
}

/**
 * The worlds the door carries for a Manjuel ground: the two the glass's door line carries, and
 * since 2026-10-23 SecondBrain's own checkout (his card: "Yes, all three"), so the GitHub shelf
 * keeps all three repositories. The inner door carries only the first two, so a forwarded tool
 * asked of `secondbrain` is refused there by name. Since 2026-10-30 (Steward's ADR-0001, item 5)
 * also Steward's own repository, so his git tools reach it through the door under a key of his own,
 * with every write held for the operator.
 */
function worldsFor(ground) {
  return [
    ['research', ground],
    ['atlas', path.join(ground, 'atlas')],
    ['secondbrain', path.join(ground, 'worlds', 'jesster')],
    ['steward', path.join(ground, 'worlds', 'steward')],
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

/** What the GitHub shelf may press over IPC (door:call). */
const SHELF_TOOLS = new Set(['git', 'git_diff', 'git_remote', 'git_commit', 'git_push', 'git_pull', 'git_branch', 'git_tag', 'git_pr', 'hold_list', 'hold_answer']);

const FLOW = Object.freeze({ name: 'a flow', service: false });

/** One git act asked by a flow: { text, isError }, as door.call answers. */
async function flowCall(door, name, args) {
  if (!SHELF_TOOLS.has(name) || name.startsWith('hold_')) return { text: `Refused: a flow's git block cannot call ${name}.`, isError: true };
  const reg = door.registry();
  if (!reg) return door.call(name, args, FLOW);
  const action = String(typeof args.action === 'string' ? args.action : '').trim().toLowerCase();
  const reading = ['git', 'git_diff', 'git_remote'].includes(name) || (['git_branch', 'git_tag', 'git_pr'].includes(name) && (action === '' || action === 'list'));
  if (reading) return door.call(name, args, OPERATOR);
  if (name === 'git_pull') {
    let tn;
    try {
      tn = reg.tenants.resolve(typeof args.project === 'string' ? args.project : '');
    } catch (e) {
      return { text: e.message, isError: true };
    }
    if (tn.name === 'research') {
      const [n, , open] = sittingOpen(tn.home);
      if (open) return { text: `Refused: sitting ${n} is open on the ground, and nothing moves under a sitting (RULE 9). Close it, then bring Manjuel level.`, isError: true };
    }
    return door.call(name, args, OPERATOR);
  }
  if (name === 'git_pr') {
    // his glass's alone, so it cannot park the usual way: it is parked here, and runs on his Approve
    let tn;
    try {
      tn = reg.tenants.resolve(typeof args.project === 'string' ? args.project : '');
    } catch (e) {
      return { text: e.message, isError: true };
    }
    return { text: heldAnswer(reg.park(tn, reg.get('git_pr'), args, FLOW)), isError: false };
  }
  return door.call(name, args, FLOW);
}

/** main.cjs's one line: the door into atlas.handleMcp, and the operator's hand over IPC; with getAgent, the Agent tab's two (agentTools). */
function register({ atlas, ipcMain, guard, getSettings, vaultDir, getAgent, showAgent }) {
  const { findGround } = require('../atlasglass.cjs');
  const door = serve(() => findGround((getSettings().get('atlas') || {}).ground, vaultDir()), { extra: getAgent ? agentTools(getAgent, showAgent) : [] });
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
  // The GitHub shelf (plan-github-shelf, G2): the app's own page presses these as the operator, the way
  // the glass's GitHub tab presses its buttons. Its git and hold tools only, never the rest of the door.
  ipcMain.handle('door:call', async (event, name, args) => {
    guard(event);
    if (!SHELF_TOOLS.has(name)) throw new Error(`not a GitHub shelf tool: ${name}`);
    return door.call(name, args && typeof args === 'object' ? args : {}, OPERATOR);
  });
  // A FLOW'S git block (plan-github-shelf, G3). A flow is not his hand: its reads run, and bringing a
  // repository level runs (his card, 2026-10-23: "Yes, fast-forward freely" -- git_pull is fast-forward only
  // and refuses over unsaved work), but never into the ground while a sitting is open (RULE 9). Every other
  // write waits for him in GitHub's Waiting on you, pull requests too.
  ipcMain.handle('door:flow', async (event, name, args) => {
    guard(event);
    return flowCall(door, name, args && typeof args === 'object' ? args : {});
  });
  return door;
}

module.exports = { register, serve, build, agentTools, worldsFor, engines, ORDER, PORTED, REMAINING, INSTRUCTIONS, OPERATOR, CLIENT, SHELF_TOOLS, flowCall };
