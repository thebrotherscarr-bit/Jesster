/**
 * The door's record tools, ported from atlas/line: orient (get_in_line), the
 * landed B1 readers in tools.go (muster, read_handoffs, list_doctrine,
 * read_doctrine, check_the_wall, state_matrix, read_plan, remember), records.go,
 * seats.go, proofs.go, and the tenant/trust/rbac verbs. Each answers in the Go
 * door's own words and shapes.
 */
const fs = require('fs');
const path = require('path');
const util = require('./util.cjs');
const { renderTrust, upsertTrust, loadTrust } = require('./tenant.cjs');
const { regOf } = require('./registry.cjs');

const { struct, marshal, marshalLine, q, sha256File, sha256Bytes, runeLen, truncateRunes, firstLines, rfc3339, readable, isMissing, goIsAbs, str } = util;

// ---- get_in_line (internal/orient) ---------------------------------------------------

const ORIENT_CAP = 60000;
const STANDING_LAW = `== ATLAS ORIENTATION ==
state = fold(record): nothing is deleted; append and supersede.
Propose, never dispose: can_approve is false in every declaration,
and approval lives in the operator's hand alone.
Prove hermetic on temp ground; leave your toll in SEAT_LOG.md.

`;

function readCapped(p, max) {
  let s;
  try {
    s = fs.readFileSync(p, 'utf8');
  } catch {
    return [null, false];
  }
  return [truncateRunes(s, max), true];
}

function tailLines(text, n) {
  const lines = text.replace(/[\r\n]+$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function base(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

async function orientForTenant(t) {
  let b = STANDING_LAW;
  const [line, ok] = readCapped(t.linePath(), 4000);
  b += ok ? `-- LINE (${t.name}) --\n${line}\n\n` : `-- LINE (${t.name}) --\n[no line document carried for ${q(t.name)}]\n\n`;
  let road = '';
  for (const cand of t.roadCandidates()) {
    const [txt, rok] = readCapped(cand, 4000);
    if (rok) {
      road = txt;
      break;
    }
  }
  b += road ? `-- ROAD --\n${road}\n\n` : `-- ROAD --\n[no road document carried for ${q(t.name)}]\n\n`;
  const logPath = t.logPath();
  if (logPath) {
    let st = null;
    try {
      st = fs.statSync(logPath);
    } catch {
      st = null;
    }
    if (st) {
      if (st.isDirectory()) {
        let entries = null;
        try {
          entries = fs.readdirSync(logPath, { withFileTypes: true });
        } catch {
          entries = null;
        }
        if (entries && entries.length) {
          const names = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
          b += `-- LOG TAIL (${base(logPath)}/) --\n${names.join('\n')}\n`;
        } else {
          b += `-- LOG TAIL --\n[handoffs dir ${logPath} empty]\n`;
        }
      } else {
        const [raw, lok] = readCapped(logPath, 40000);
        if (lok) b += `-- LOG TAIL --\n${tailLines(raw, 40)}\n`;
      }
    } else {
      b += `-- LOG TAIL --\n[no handoffs carried for ${q(t.name)}]\n`;
    }
  } else {
    b += `-- LOG TAIL --\n[no handoffs configured for ${q(t.name)}]\n`;
  }
  if (runeLen(b) > ORIENT_CAP) b = truncateRunes(b, ORIENT_CAP) + '\n\n[truncated at the 60000-character law]\n';
  return b;
}

// ---- the landed readers -----------------------------------------------------------------

function readDirSorted(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function toolReadHandoffs(t) {
  const logPath = t.logPath();
  if (!logPath) throw new Error(`no handoffs path configured for project ${q(t.name)}`);
  let st;
  try {
    st = fs.statSync(logPath);
  } catch {
    throw new Error(`handoffs missing for ${q(t.name)}: ${logPath}`);
  }
  let b = '';
  if (st.isDirectory()) {
    for (const e of readDirSorted(logPath)) {
      if (e.isDirectory()) continue;
      const fp = path.join(logPath, e.name);
      let body;
      try {
        body = fs.readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      b += `${e.name} · sha256 ${sha256File(fp)}\n\n${body}\n\n`;
    }
  } else {
    const body = fs.readFileSync(logPath, 'utf8');
    b += `${path.basename(logPath)} · sha256 ${sha256File(logPath)}\n\n${body}\n`;
  }
  return b;
}

async function toolListDoctrine(t) {
  let b = '';
  let found = 0;
  for (const dir of t.doctrineDirs()) {
    let entries;
    try {
      entries = readDirSorted(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) continue;
      b += `  ${e.name}\n`;
      found++;
    }
  }
  if (!found) return `The hold is empty — no doctrine carried for project ${q(t.name)}.`;
  return `THE CARRIED LAW — ${found} documents, read-only:\n${b}`;
}

const DOCTRINE_CAP = 60000;

async function toolReadDoctrine(t, args) {
  const name = str(args, 'name').trim();
  if (!name) throw new Error('read_doctrine needs a name — try list_doctrine first');
  const want = name.toLowerCase();
  const wantBase = name.slice(0, name.length - path.extname(name).length).toLowerCase();
  for (const dir of t.doctrineDirs()) {
    let entries;
    try {
      entries = readDirSorted(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) continue;
      const b = e.name.toLowerCase();
      const noExt = e.name.slice(0, e.name.length - path.extname(e.name).length).toLowerCase();
      if (b === want || b === want + '.md' || noExt === wantBase) {
        const fp = path.join(dir, e.name);
        let text;
        try {
          text = fs.readFileSync(fp, 'utf8');
        } catch {
          continue;
        }
        const sha = sha256File(fp);
        if (runeLen(text) > DOCTRINE_CAP) {
          text = truncateRunes(text, DOCTRINE_CAP) + `\n\n[truncated honestly at ${DOCTRINE_CAP} characters — the whole document is on disk under sha256 ${sha}]`;
        }
        return `${e.name} (${path.basename(dir)}) · sha256 ${sha}\n\n${text}`;
      }
    }
  }
  throw new Error(`No such document in the hold for ${q(t.name)}: ${name}. An absent name is denied honestly — try list_doctrine.`);
}

const WALL_LAW =
  'THE WALL — everything about a project stays inside its home. "Scope is a wall, not a suggestion" (the Servant\'s Law, Article I). Do not touch, read, or list ground outside it.';

async function toolCheckWall(t, args) {
  const raw = str(args, 'path').trim();
  if (!raw) throw new Error('check_the_wall needs a path');
  const root = t.wallRoot();
  const target = goIsAbs(raw) ? raw : path.join(root, raw);
  const absTarget = path.resolve(target);
  const absRoot = path.resolve(root);
  const inside = absTarget === absRoot || absTarget.startsWith(absRoot + path.sep);
  if (inside) return `INSIDE the wall: ${absTarget}\nWithin ${q(t.name)} — a seat may work here under the standing law.`;
  return `REFUSED — outside the wall: ${absTarget}\n"${WALL_LAW}" Prepare a packet instead; only the operator lands work outside.`;
}

async function toolStateMatrix(t) {
  const paths = {};
  if (t.roadPath()) paths.road = t.roadPath();
  if (t.statePath()) paths.state = t.statePath();
  if (t.logPath()) paths.log = t.logPath();
  const rows = [];
  let plain = 'THE MATRIX — state = fold(record)\n';
  for (const k of ['road', 'state', 'log']) {
    let present = false;
    let n = 0;
    let head = '';
    if (paths[k]) {
      try {
        const b = fs.readFileSync(paths[k]);
        present = true;
        n = b.length;
        head = firstLines(b.toString('utf8'), 3);
      } catch {
        /* absent */
      }
    }
    rows.push(struct({ key: k, present, bytes: n, head: head || undefined }));
    plain += `  ${k.padEnd(6)} ${present ? `${n} bytes` : 'absent'}\n`;
  }
  plain += "\n  (folded from the named project's record; absence named honestly.)\n";
  plain += '\n' + marshal({ project: t.name, equation: 'state = fold(record)', rows }, '  ');
  return plain;
}

async function toolReadPlan(t, args) {
  const which = str(args, 'which').trim();
  if (!which) throw new Error('read_plan needs a name — e.g. road, state, catalog, acceptance, charter, or a plans/ path');
  const p = t.planPath(which);
  if (!p) throw new Error(`No such plan ${q(which)} for project ${q(t.name)}. An absent name is denied honestly — try road/state/catalog/acceptance/charter.`);
  let body;
  try {
    body = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`plan ${q(which)} present in the map but unreadable: ${e.message}`);
  }
  return `${path.basename(p)} · sha256 ${sha256File(p)}\n\n${body}`;
}

// ---- remember: the sole write tool of B1 -------------------------------------------------

async function toolRemember(t, args) {
  const text = str(args, 'text').trim();
  if (!text) throw new Error('remember needs some text to hold');
  const dir = path.join(t.home, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = rfc3339();
  const line = marshalLine({ ts: stamp, testimony: true, project: t.name, text }) + '\n';
  fs.appendFileSync(path.join(dir, 'remembered.jsonl'), line);
  return `REMEMBERED (testimony, staged for operator ascend) — ${stamp} · sha256 ${sha256Bytes(line)}\n${text}`;
}

// ---- records.go ---------------------------------------------------------------------------

const KIND_ORDER = ['doctrine', 'record', 'spec', 'agents', 'commands', 'skills', 'logs', 'other'];
const ROOT_KINDS = {
  doctrine: ['CLAUDE.md'],
  record: ['CHANGELOG.md', 'DAYBOOK.md', 'HANDOFF.md', 'SEAT_LOG.md', 'TASKS.md', 'memory.md'],
  spec: ['SPEC.md', 'SPEC_CONTROL_CENTER.md', 'DESIGN.md', 'SYSTEM_DESIGN.md', 'BUILDMAP.md', 'BUILDPATH.md', 'RUNBOOK.md', 'QUICKSTART.md', 'README.md', 'TESTING.md', 'CONTRIBUTING.md', 'REFUSALS.md', 'parity.md', 'rack.md'],
  commands: ['commands.md', 'pipelines.md', 'agents.md'],
};
const LOGS_SHOWN = 60;

function rootKind(name) {
  for (const k of KIND_ORDER) for (const want of ROOT_KINDS[k] || []) if (want.toLowerCase() === name.toLowerCase()) return k;
  return 'other';
}

function goTime(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function recordDocs(home) {
  const scan = (dir, prefix, kind, sealed) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (isMissing(e)) return [];
      throw e;
    }
    const got = [];
    for (const e of ents) {
      if (e.isDirectory() || path.extname(e.name).toLowerCase() !== '.md') continue;
      let st;
      try {
        st = fs.statSync(path.join(dir, e.name));
      } catch {
        continue;
      }
      got.push(struct({ name: prefix + e.name, kind: kind || rootKind(e.name), bytes: st.size, modified: goTime(st.mtime), sealed: sealed || undefined }));
    }
    return got;
  };
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const logs = scan(path.join(home, 'logs'), 'logs/', 'logs', false).sort((a, b) => (a.modified > b.modified ? -1 : a.modified < b.modified ? 1 : 0));
  return [
    ...scan(home, '', '', false).sort(byName),
    ...scan(path.join(home, 'law'), 'law/', 'doctrine', true).sort(byName),
    ...scan(path.join(home, 'agents'), 'agents/', 'agents', false).sort(byName),
    ...scan(path.join(home, 'skills'), 'skills/', 'skills', false).sort(byName),
    ...logs.slice(0, LOGS_SHOWN),
  ];
}

function summarise(kinds) {
  return KIND_ORDER.filter((k) => kinds[k] !== undefined).map((k) => `${k} (${kinds[k]})`).join(', ');
}

async function toolRecords(t, args) {
  const docs = recordDocs(t.home);
  const count = () => docs.reduce((m, d) => ((m[d.kind] = (m[d.kind] || 0) + 1), m), {});
  const name = str(args, 'name').trim();
  if (name) {
    for (const d of docs) {
      if (d.name.toLowerCase() !== name.toLowerCase()) continue;
      let b;
      try {
        b = fs.readFileSync(path.join(t.home, ...d.name.split('/')));
      } catch (e) {
        throw new Error(`record ${q(d.name)} is listed but unreadable: ${e.message}`);
      }
      return marshal({ world: t.name, name: d.name, kind: d.kind, sha256: sha256Bytes(b), bytes: b.length, modified: d.modified, sealed: Boolean(d.sealed), text: b.toString('utf8') });
    }
    throw new Error(`no record named ${q(name)} in ${t.name}. Kinds carried: ${summarise(count())}`);
  }
  const kind = str(args, 'kind').trim().toLowerCase();
  if (kind) {
    const out = docs.filter((d) => d.kind === kind);
    if (!out.length) throw new Error(`no kind ${q(kind)} in ${t.name}. Kinds carried: ${summarise(count())}`);
    return marshal({ world: t.name, kind, count: out.length, documents: out });
  }
  const by = {};
  for (const d of docs) (by[d.kind] ||= []).push(d);
  const kinds = KIND_ORDER.filter((k) => by[k]).map((k) => ({ kind: k, count: by[k].length, documents: by[k] }));
  return marshal({ world: t.name, count: docs.length, kinds });
}

// ---- seats.go ------------------------------------------------------------------------------

const HEAD_RE = /^##[ \t]+(.+?)[ \t]*$/m;
const FIELD_RE = /^[ \t]*[-*][ \t]*\*\*([^*]+?)\*\*[ \t]*:?[ \t]*(.*?)[ \t]*$/gm;
const PIPE_HEAD_RE = /^##[ \t]+Pipeline[ \t]*:?[ \t]+(.+?)[ \t]*$/;
const STEP_RE = /^[ \t]*(?:\d+[.)]|[-*])[ \t]+([^(\n]+?)[ \t]*(?:\(([^)]*)\))?[ \t]*$/;
const WHEN_RE = /when[ \t]*:[ \t]*([A-Za-z0-9_-]+)/i;

function readSeat(file, raw, stands) {
  const seat = { file };
  let name = file.slice(0, file.length - path.extname(file).length);
  const m = HEAD_RE.exec(raw);
  if (m) name = m[1].trim();
  seat.name = name;
  const fields = {};
  const order = [];
  let promptFrom = -1;
  for (const f of raw.matchAll(FIELD_RE)) {
    const key = f[1].trim().replace(/:$/, '').trim();
    const val = f[2].trim();
    if (!(key in fields)) order.push(key);
    fields[key] = val;
    if (val === '' && key.toLowerCase() === 'system prompt') promptFrom = f.index + f[0].length;
  }
  if (promptFrom >= 0 && promptFrom < raw.length) {
    const body = raw.slice(promptFrom).trim();
    seat.prompt = body;
    seat.prompt_chars = Buffer.byteLength(body);
    delete fields['System Prompt'];
  }
  seat.fields = fields;
  seat.field_order = order;
  seat.stands_in = stands[name.toLowerCase()] || null;
  return seat;
}

async function toolSeats(t) {
  const out = { world: t.name };
  const dir = path.join(t.home, 'agents');
  let entries;
  try {
    entries = readDirSorted(dir);
  } catch (e) {
    out.seats_error = readable(e);
    return marshal(out);
  }
  const stands = {};
  let pipes = null;
  try {
    pipes = fs.readFileSync(path.join(t.home, 'pipelines.md'), 'utf8');
  } catch (e) {
    out.pipelines_error = readable(e);
  }
  if (pipes !== null) {
    let pipeline = '';
    let step = 0;
    for (let line of pipes.split('\n')) {
      line = line.replace(/\r+$/, '');
      const h = PIPE_HEAD_RE.exec(line);
      if (h) {
        pipeline = h[1].trim();
        step = 0;
        continue;
      }
      if (!pipeline) continue;
      const m = STEP_RE.exec(line);
      if (!m) continue;
      const seat = m[1].trim();
      if (!seat) continue;
      step++;
      const row = { pipeline, step };
      const note = (m[2] || '').trim();
      if (note) {
        row.note = note;
        const w = WHEN_RE.exec(note);
        if (w) row.when = w[1];
      }
      (stands[seat.toLowerCase()] ||= []).push(row);
    }
  }
  const seats = [];
  for (const e of entries) {
    if (e.isDirectory() || !e.name.toLowerCase().endsWith('.md')) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, e.name), 'utf8');
    } catch (err) {
      seats.push({ file: e.name, error: readable(err) });
      continue;
    }
    seats.push(readSeat(e.name, raw, stands));
  }
  const nm = (s) => String(s.name || '').toLowerCase();
  seats.sort((a, b) => (nm(a) < nm(b) ? -1 : nm(a) > nm(b) ? 1 : 0));
  out.seats = seats;
  return marshal(out);
}

// ---- proofs.go -----------------------------------------------------------------------------

const kept = new Map();

/** in(the file's text), read again only when its size or modification time has moved. */
function fromRecord(p, fn) {
  const st = fs.statSync(p);
  const k = kept.get(p + '\0' + fn.name);
  if (k && k.size === st.size && k.mtimeMs === st.mtimeMs) return k.val;
  const raw = fs.readFileSync(p, 'utf8');
  const val = fn(raw);
  kept.set(p + '\0' + fn.name, { size: st.size, mtimeMs: st.mtimeMs, val });
  return val;
}

function linesIn(raw) {
  const out = [];
  for (let line of raw.split('\n')) {
    line = line.trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) out.push(row);
    } catch {
      /* a half-written last line is dropped, never the read */
    }
  }
  return out;
}

function standupsIn(raw) {
  return linesIn(raw).filter((r) => r.suite === 'standup');
}

function sittingsIn(raw) {
  const byN = new Map();
  const order = [];
  for (const r of linesIn(raw)) {
    if (typeof r.n !== 'number') continue;
    if (!byN.has(r.n)) order.push(r.n);
    byN.set(r.n, r);
  }
  order.sort((a, b) => a - b);
  let tolled = 0;
  let runs = 0;
  let open = 0;
  let recent = [];
  for (const n of order) {
    const r = byN.get(n);
    if (r.toll_paid === true) tolled++;
    const rs = Array.isArray(r.runs) ? r.runs : [];
    runs += rs.length;
    if (typeof r.ended !== 'string' || !r.ended.trim()) open++;
    recent.push({ n, started: r.started ?? null, ended: r.ended ?? null, toll_paid: r.toll_paid ?? null, runs: rs.length });
  }
  if (recent.length > 12) recent = recent.slice(recent.length - 12);
  return { sittings: order.length, tolled, runs, still_open: open, recent };
}

function tollsIn(raw) {
  return raw.split('\n').filter((line) => line.startsWith('## ') && line.includes(' sitting ')).length;
}

async function toolProofs(t) {
  const out = { world: t.name };
  try {
    const b = fs.readFileSync(path.join(t.home, 'tests', 'last_run.json'), 'utf8');
    try {
      out.suites = JSON.parse(b);
    } catch (e) {
      out.suites_error = 'tests/last_run.json is not readable JSON: ' + e.message;
    }
  } catch (e) {
    out.suites_error = readable(e);
  }
  try {
    out.standups = fromRecord(path.join(t.home, 'tests', 'run_history.jsonl'), standupsIn);
  } catch (e) {
    out.standups_error = readable(e);
  }
  try {
    out.parity = fromRecord(path.join(t.home, 'sessions', 'parity_history.jsonl'), linesIn);
  } catch (e) {
    out.parity_error = readable(e);
  }
  const rec = {};
  try {
    Object.assign(rec, fromRecord(path.join(t.home, 'sessions', 'sessions.jsonl'), sittingsIn));
  } catch (e) {
    rec.error = readable(e);
  }
  try {
    rec.seat_log_tolls = fromRecord(path.join(t.home, 'SEAT_LOG.md'), tollsIn);
  } catch {
    rec.seat_log_tolls = null;
  }
  rec.counted_by_the_engine = ['memory entries', 'index docs and passages'];
  out.record = rec;
  try {
    out.standup_reports = fs
      .readdirSync(path.join(t.home, 'logs'), { withFileTypes: true })
      .filter((n) => !n.isDirectory() && n.name.startsWith('standup_'))
      .map((n) => 'logs/' + n.name)
      .sort();
  } catch {
    /* no logs/ */
  }
  return marshal(out);
}

// ---- tenants, rbac, trust -------------------------------------------------------------------

function tenantsOf(args) {
  const reg = regOf(args);
  return reg && reg.tenants;
}

async function toolMuster(t, args) {
  const names = tenantsOf(args).names();
  return `${names.length} carried projects:` + names.map((n) => '\n  ' + n).join('');
}

async function toolTenantList(t, args) {
  const reg = tenantsOf(args);
  const names = reg.names();
  let b = `TENANTS — ${names.length} carried project(s):\n`;
  for (const n of names) {
    let tn;
    try {
      tn = reg.resolve(n);
    } catch {
      continue;
    }
    const assigned = Object.keys(tn.policy.assign).length;
    const mode = assigned ? `${assigned} assigned` : 'open mode';
    const ng = loadTrust(tn.home).grants.length;
    b += `  - ${n} · ${mode} · ${ng} trust grant(s)${n === t.name ? ' (you are here)' : ''}\n`;
  }
  return b;
}

async function toolTenantRBACAssign(t, args) {
  const actor = str(args, 'actor');
  if (!actor) throw new Error('tenant_rbac_assign needs an actor');
  const role = str(args, 'role');
  if (!role) throw new Error('tenant_rbac_assign needs a role');
  t.assignRole(actor, role);
  try {
    t.savePolicy();
  } catch (e) {
    throw new Error(`rbac assigned but failed to persist: ${e.message}`);
  }
  return `ASSIGNED role ${q(role)} to agent ${q(actor)} in tenant ${q(t.name)}`;
}

async function toolTenantRBACCheck(t, args) {
  const actor = str(args, 'actor');
  if (!actor) throw new Error('tenant_rbac_check needs an actor');
  const toolName = str(args, 'tool');
  if (!toolName) throw new Error('tenant_rbac_check needs a tool');
  const reg = regOf(args);
  if (!reg) throw new Error("tenant_rbac_check cannot see this door's own surface from here");
  const tool = reg.get(toolName);
  if (!tool) throw new Error(`unknown tool: ${q(toolName)} -- tenant_rbac_check judges a tool this door carries`);
  const [allowed, role, reason] = t.checkRBAC(actor, toolName, Boolean(tool.writes));
  if (allowed) return role ? `ALLOWED — ${actor} (role ${q(role)}) on ${t.name}` : `ALLOWED — ${actor} on ${t.name} (open mode)`;
  return `DENIED — ${actor} (role ${q(role)}) on ${t.name}: ${reason}`;
}

async function toolTenantTrust(t, args) {
  let from = str(args, 'from_project');
  if (!from.trim()) throw new Error('tenant_trust needs from_project');
  let to = str(args, 'to_project');
  if (!to.trim()) throw new Error('tenant_trust needs to_project');
  let toolName = str(args, 'tool');
  if (!toolName.trim()) throw new Error('tenant_trust needs a tool');
  const action = str(args, 'action');
  if (action !== 'allow' && action !== 'deny') throw new Error(`tenant_trust action must be 'allow' or 'deny', got ${q(action)}`);
  from = from.trim().toLowerCase();
  to = to.trim().toLowerCase();
  toolName = toolName.trim();
  for (const f of ['approve', 'ascend', 'merge', 'commit', 'push', 'delete', 'reject', 'promote']) {
    if (toolName.toLowerCase() === f) throw new Error(`refused: ${q(toolName)} is a forbidden verb — absent by construction, never delegable`);
  }
  const reg = tenantsOf(args);
  if (!reg.has(from)) throw new Error(`unknown project ${q(from)}: not a carried tenant (from_project)`);
  if (!reg.has(to)) throw new Error(`unknown project ${q(to)}: not a carried tenant (to_project)`);
  upsertTrust(t.home, { from, to, tool: toolName, action, ts: '' });
  const sha = sha256File(path.join(t.home, 'state', 'trust.json'));
  return `TRUST ${action} ${toolName}: ${from} → ${to} (witnessed state/trust.json · sha256 ${sha})`;
}

async function toolTrustList(t) {
  return renderTrust(t.home);
}

// ---- env_list: the sittings, read off each world's own ledger ---------------------------------

/** engine.SittingOpen: [n, started, open]; an unreadable last line is an open sitting (unknown refuses). */
function sittingOpen(ground) {
  let text;
  try {
    text = fs.readFileSync(path.join(ground, 'sessions', 'sessions.jsonl'), 'utf8');
  } catch (e) {
    if (isMissing(e)) return [0, '', false];
    return [0, 'unreadable ledger: ' + e.message, true];
  }
  const lines = text.replace(/[\r\n]+$/, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return [0, 'the last ledger line is not readable JSON', true];
    }
    if (typeof row.ended === 'string' && row.ended.trim()) return [0, '', false];
    return [typeof row.n === 'number' ? row.n : 0, typeof row.started === 'string' ? row.started : '', true];
  }
  return [0, '', false];
}

async function toolEnvList(t, args) {
  // the engines this door has open (engine.cjs), required here so the two files load in either order
  const { engines } = require('./engine.cjs');
  const reg = tenantsOf(args);
  const open = engines.list();
  let b = `${open.length} engine(s) open:\n`;
  for (const e of open) {
    const pend = e.pending ? ' · WAITING ON AN ANSWER: ' + String(e.pending.prompt || '').slice(0, 90) : '';
    b += `  ${e.name} · sitting ${e.opened && e.opened.sitting != null ? e.opened.sitting : ''}${pend}\n`;
  }
  b += '\ncarried worlds:\n';
  for (const name of reg.names()) {
    let tn;
    try {
      tn = reg.resolve(name);
    } catch {
      continue;
    }
    let state = 'closed';
    const [n, started, sat] = sittingOpen(tn.home);
    if (engines.get(tn.home)) state = 'engine open here';
    else if (sat) state = `sat in elsewhere (sitting ${Math.trunc(n)}, ${started})`;
    b += `  ${name.padEnd(16)} ${state}\n`;
  }
  return b;
}

const recordTools = [
  { name: 'get_in_line', writes: false, description: 'standing law + line + road + log-tail for a carried project', args: ['project?'], fn: (t) => orientForTenant(t) },
  { name: 'muster', writes: false, description: 'declared projects roll call', args: [], fn: toolMuster },
  { name: 'read_handoffs', writes: false, description: "SEAT_LOG (or the manifest 'log' path) whole, with sha256 receipt(s)", args: ['project?'], fn: toolReadHandoffs },
  { name: 'list_doctrine', writes: false, description: 'carried doctrine by name, read-only; absent name denied honestly', args: ['project?'], fn: toolListDoctrine },
  { name: 'read_doctrine', writes: false, description: 'one document whole with sha256 receipt; absent name denied honestly', args: ['name', 'project?'], fn: toolReadDoctrine },
  { name: 'check_the_wall', writes: false, description: 'judge a path before acting; quote the law on refusal', args: ['path', 'project?'], fn: toolCheckWall },
  {
    name: 'records',
    writes: false,
    description: "the estate's own documents sorted by what they are (doctrine, record, spec, agents, commands, skills, logs); a kind listed, or one document served whole with a sha256 receipt",
    args: ['kind?', 'name?', 'project?'],
    fn: toolRecords,
  },
  { name: 'seats', writes: false, description: "the world's own seat declarations and the pipelines they stand in, from agents/ and pipelines.md", args: ['project?'], fn: toolSeats },
  { name: 'proofs', writes: false, description: "what this world has PROVED, from its own record: the suites' stamp, every live standup, the parity history", args: ['project?'], fn: toolProofs },
  { name: 'state_matrix', writes: false, description: 'state = fold(record) index of the named project', args: ['project?'], fn: toolStateMatrix },
  { name: 'read_plan', writes: false, description: 'HLD/LLD/road documents by name; absent name denied honestly', args: ['which', 'project?'], fn: toolReadPlan },
  { name: 'remember', writes: true, description: 'sole write tool; testimony stamped generated; staged for operator ascend', args: ['text', 'project?'], fn: toolRemember },
  { name: 'tenant_trust_list', writes: false, description: 'read recorded cross-tenant delegations (N6)', args: ['project?'], fn: toolTrustList },
  { name: 'tenant_list', writes: false, description: 'list all registered tenants and their roles', args: ['project?'], fn: toolTenantList },
  { name: 'tenant_rbac_assign', writes: true, description: "assign a role to an agent in a tenant's RBAC policy", args: ['actor', 'role', 'project?'], fn: toolTenantRBACAssign },
  { name: 'tenant_rbac_check', writes: false, description: "check if an agent has permission for a tool under a tenant's RBAC policy", args: ['actor', 'tool', 'project?'], fn: toolTenantRBACCheck },
  {
    name: 'tenant_trust',
    writes: true,
    description: 'grant or revoke cross-tenant trust (delegation of specific tools)',
    args: ['from_project', 'to_project', 'tool', 'action', 'project?'],
    fn: toolTenantTrust,
  },
  { name: 'env_list', writes: false, description: 'which worlds have an engine open, and which are being sat in elsewhere', args: [], fn: toolEnvList },
];

module.exports = { recordTools, orientForTenant, recordDocs, sittingOpen, sittingsIn, tollsIn, linesIn, WALL_LAW };
