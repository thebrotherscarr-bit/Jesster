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
const { Registry, holdTools, callerOf, regOf } = require('./registry.cjs');
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
  innerHolds(reg, getInner);
  return reg;
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
 * asked of `secondbrain` is refused there by name.
 */
function worldsFor(ground) {
  return [
    ['research', ground],
    ['atlas', path.join(ground, 'atlas')],
    ['secondbrain', path.join(ground, 'worlds', 'jesster')],
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
