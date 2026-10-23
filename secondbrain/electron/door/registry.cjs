/**
 * The door's surface and its gate, ported from atlas/line internal/tools:
 * tools.go (Tool, WritesFor, Registry.Call), holds.go (the queue a writing call
 * waits in when the hand behind it is not the operator's, and the answer that
 * lets it through) and protocol.go (the tools/list schema).
 *
 * IDENTITY COMES FROM THE TRANSPORT AND NEVER FROM THE MESSAGE. The caller is
 * what SecondBrain judged the request to be: anything at POST /mcp carries the
 * share key and is a client (service: false); the app's own window, over IPC,
 * is the operator's hand (service: true). The reserved keys are stripped from
 * whatever a caller sends and written back by the door alone.
 *
 * THE HOLDS ARE ARMED. The Go door arms them only with --auth, because without
 * a credential it cannot tell a seat from the glass. SecondBrain always can:
 * /mcp demands its bearer key and the glass is the app itself.
 */
const fs = require('fs');
const path = require('path');
const { marshal, marshalLine, q, rfc3339 } = require('./util.cjs');

const CALLER_KEY = '__caller';
const REGISTRY_KEY = '__registry';

/** The verbs RULE 6 keeps out of an agent's hand; a tool carrying one as a word always writes. */
const FORBIDDEN_VERBS = ['approve', 'ascend', 'merge', 'commit', 'push', 'delete', 'reject', 'promote'];

function forbiddenWord(name) {
  for (const w of String(name).toLowerCase().split('_')) if (FORBIDDEN_VERBS.includes(w)) return w;
  return '';
}

/** The two that run the queue itself never hold. */
const HELD_EXEMPT = new Set(['hold_answer', 'hold_list']);

/** What a secret reads as where a hold is SHOWN; the parked call keeps it whole. */
const WITHHELD = '[withheld: a secret; the parked call keeps it]';
const KEY_RE = /^atl_[0-9a-f]{32}$/;

function actionOf(args) {
  return String(typeof args.action === 'string' ? args.action : '').trim().toLowerCase();
}

/** Whether THIS call writes: the declaration, narrowed by a reading action. */
function writesFor(tool, args) {
  if (!tool.writes || !tool.reads || !tool.reads.length) return Boolean(tool.writes);
  const a = actionOf(args || {});
  if (!a) return false;
  return !tool.reads.includes(a);
}

function callerLabel(c) {
  if (c.service) return 'operator (service wire)';
  return c.name || 'unnamed client';
}

function rbacState(tn, caller) {
  if (tn.rbacOpen()) return 'open (no roles assigned)';
  const [role, ok] = tn.roleOf(caller.name);
  return 'role ' + (ok ? role : 'guest');
}

function copyArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) if (k !== CALLER_KEY && k !== REGISTRY_KEY) out[k] = v;
  return out;
}

function callerOf(args) {
  const c = args && args[CALLER_KEY];
  return c && typeof c === 'object' ? c : { name: '', service: false, hold: '' };
}

function regOf(args) {
  return (args && args[REGISTRY_KEY]) || null;
}

function heldAnswer(h) {
  return (
    `HELD: ${q(h.tool)} writes, and this call did not come from the operator's own glass (${h.caller}). Nothing has been written.\n\n` +
    `It is parked as ${h.id} and waits for his hand -- RULE 6: no agent commits, pushes, lands, approves, or authorises a spend. ` +
    `He answers it on the card at the foot of the front page's terminal (or on the GitHub page), or with hold_answer.\n\n` +
    'Do not retry this call and do not work around it. Say plainly that it is waiting.'
  );
}

class Registry {
  constructor(tenants, { holdWrites = true } = {}) {
    this.tenants = tenants;
    this.order = [];
    this.byName = new Map();
    this.holdWrites = holdWrites;
    this.held = new Map();
    this.heldSeq = 0;
  }

  /** { name, description, writes, reads?, secrets?, serviceOnly?, args, fn(t, args) } */
  add(tool) {
    if (!this.byName.has(tool.name)) this.order.push(tool.name);
    this.byName.set(tool.name, tool);
    return this;
  }

  get(name) {
    return this.byName.get(name);
  }

  names() {
    return [...this.order];
  }

  all() {
    return this.order.map((n) => this.byName.get(n));
  }

  /** tools/list as protocol.go builds it: every argument a string, `?` optional, `required` always emitted. */
  schemas() {
    return this.all().map((t) => {
      const properties = {};
      const required = [];
      for (const a of t.args || []) {
        const optional = a.length > 1 && a.endsWith('?');
        const name = a.replace(/\?+$/, '');
        if (!optional) required.push(name);
        properties[name] = {
          type: 'string',
          description: optional ? 'the ground this call names; OPTIONAL -- omit it and the ground the session was opened in answers' : 'the ground this call names',
        };
      }
      return { name: t.name, description: t.description, inputSchema: { type: 'object', properties, required } };
    });
  }

  /**
   * Call: resolve the project, refuse the operator's own hand to anyone else,
   * ask RBAC with the caller's transport name, park a writing call from a hand
   * that is not his, then run. Resolves to the answer; rejects with the refusal.
   */
  async call(name, args, caller) {
    const t = this.byName.get(name);
    if (!t) throw new Error(`unknown tool: ${q(name)}`);
    caller = { name: String((caller && caller.name) || ''), service: Boolean(caller && caller.service), hold: String((caller && caller.hold) || '') };
    args = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
    delete args[CALLER_KEY];
    delete args[REGISTRY_KEY];
    const project = typeof args.project === 'string' ? args.project : '';
    const tn = this.tenants.resolve(project);
    if (t.serviceOnly && !caller.service) {
      this.record(tn.home, 'refused', { id: `refused_${Date.now()}_${name}`, tool: name, caller: callerLabel(caller), project: tn.name, rbac: rbacState(tn, caller) }, 'service-only: the caller is not the operator\'s glass');
      throw new Error(
        `refused: ${q(name)} is the operator's own hand, offered to his glass alone and to no seat, agent or other client (RULE 6); if this IS his glass, the door has to run with --auth to tell`,
      );
    }
    const writes = writesFor(t, args);
    if (!caller.service) {
      const [allowed, role, reason] = tn.checkRBAC(caller.name, name, writes);
      if (!allowed) throw new Error(`rbac: caller ${q(caller.name)} (role ${q(role)}) denied tool ${q(name)}: ${reason}`);
    }
    if (this.holdWrites && writes && !caller.service && !HELD_EXEMPT.has(name)) {
      return heldAnswer(this.park(tn, t, args, caller));
    }
    args[CALLER_KEY] = caller;
    args[REGISTRY_KEY] = this;
    return t.fn(tn, args);
  }

  /** The record is written FIRST: a hold the operator cannot find later is a call that vanished. */
  park(tn, t, args, caller) {
    this.heldSeq++;
    const h = {
      id: `hold_${Date.now()}_${this.heldSeq}_${t.name}`,
      tool: t.name,
      args: copyArgs(args),
      caller: callerLabel(caller),
      project: tn.name,
      when: new Date(),
      rbac: rbacState(tn, caller),
      tn,
    };
    this.held.set(h.id, h);
    this.record(tn.home, 'held', h, '');
    return h;
  }

  /** One line appended to the world's own holds log (append-only, ESTATE LAW 8). */
  record(home, what, h, note) {
    const line = { ts: rfc3339(), what, id: h.id, tool: h.tool, caller: h.caller, project: h.project, rbac: h.rbac };
    if (note) line.note = note;
    try {
      const p = path.join(home, 'state', 'holds.jsonl');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, marshalLine(line) + '\n');
    } catch {
      /* the Go door drops a record it cannot write, too */
    }
  }
}

/** A hold's arguments as the glass may see them: declared secrets and the key shape withheld. */
function shown(tool, args) {
  const secret = new Set((tool && tool.secrets) || []);
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (secret.has(k) || (typeof v === 'string' && KEY_RE.test(v.trim()))) out[k] = WITHHELD;
    else out[k] = v;
  }
  return out;
}

// ---- the two tools -------------------------------------------------------------------

async function toolHoldList(t, args) {
  const reg = regOf(args);
  if (!reg) return 'Refused: the hold queue is not reachable from here.';
  const out = { armed: reg.holdWrites, held: [] };
  if (!reg.holdWrites) {
    out.why_not =
      'The door was started WITHOUT --auth, so it cannot tell a seat from the glass and nothing is being held. Restart it with --auth and a service wire to arm this.';
    return marshal(out, ' ');
  }
  if (!callerOf(args).service) return "Refused: the hold queue is the operator's. This asks who is calling, and the answer was not his glass.";
  const ids = [...reg.held.keys()].sort();
  out.held = ids.map((id) => {
    const h = reg.held.get(id);
    return { id: h.id, tool: h.tool, caller: h.caller, project: h.project, when: rfc3339(h.when), args: shown(reg.get(h.tool), h.args) };
  });
  return marshal(out, ' ');
}

async function toolHoldAnswer(t, args) {
  const reg = regOf(args);
  if (!reg) return 'Refused: the hold queue is not reachable from here.';
  if (!callerOf(args).service) return "Refused: answering a hold is the operator's act alone, and this call did not come from his glass. RULE 6.";
  const id = typeof args.id === 'string' ? args.id : '';
  const decision = typeof args.decision === 'string' ? args.decision : '';
  if (!id) return 'Refused: name the hold to answer, e.g. id=hold_1757...';
  if (decision !== 'approve' && decision !== 'deny') return `Refused: a hold is answered approve or deny, got ${q(decision)}.`;
  const h = reg.held.get(id);
  if (!h) {
    return `Refused: no hold called ${id} is waiting. It may have been answered already, or the door restarted -- a restart drops the queue, and a dropped hold means the call never ran.`;
  }
  reg.held.delete(id);
  const pt = h.tn;
  if (!pt || !pt.home) {
    reg.record(t.home, 'refused', h, 'the hold carries no world to run in');
    return `Refused: ${h.id} carries no world to run in, so ${q(h.tool)} was not run and nothing was written.`;
  }
  if (decision === 'deny') {
    reg.record(pt.home, 'denied', h, '');
    return `Denied ${h.id}. ${q(h.tool)} was not run and nothing was written.`;
  }
  const tool = reg.get(h.tool);
  if (!tool) {
    reg.record(pt.home, 'vanished', h, 'the tool no longer exists');
    return `Refused: ${q(h.tool)} no longer exists at this door, so the held call cannot be run.`;
  }
  // Run it AS ITSELF, with the args it was parked with -- not re-read, not re-judged.
  const run = copyArgs(h.args);
  run[CALLER_KEY] = { name: 'operator via hold ' + h.id, service: true, hold: h.id };
  run[REGISTRY_KEY] = reg;
  let out;
  try {
    out = await tool.fn(pt, run);
  } catch (e) {
    reg.record(pt.home, 'approved_errored', h, e.message);
    return `Approved ${h.id} and ${q(h.tool)} errored: ${e.message}\n\n`;
  }
  reg.record(pt.home, 'approved_ran', h, '');
  return `Approved ${h.id}. ${q(h.tool)} ran:\n\n${out}`;
}

const holdTools = [
  {
    name: 'hold_list',
    writes: false,
    description: 'the writing calls parked waiting for the operator\'s hand, and whether holding is armed at all',
    args: ['project?'],
    fn: toolHoldList,
  },
  {
    name: 'hold_answer',
    writes: true,
    description: 'approve or deny one parked call by id; the operator\'s act alone, and it runs exactly the call that was parked',
    args: ['id', 'decision', 'project?'],
    fn: toolHoldAnswer,
  },
];

module.exports = { Registry, holdTools, writesFor, forbiddenWord, callerOf, regOf, shown, heldAnswer, CALLER_KEY, REGISTRY_KEY, FORBIDDEN_VERBS, HELD_EXEMPT, WITHHELD };
