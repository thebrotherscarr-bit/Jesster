/**
 * The worlds the door carries, ported from atlas/line: internal/tenant (the
 * registry and line.manifest.json), internal/rbac (roles, asked by tool name,
 * then `*`, then the kinds tools/read/edit), internal/trust (state/trust.json)
 * and ground.Barred (a folder named Archive is never carried, by any road).
 */
const fs = require('fs');
const path = require('path');
const { struct, marshal, rfc3339, q, goIsAbs } = require('./util.cjs');

// ---- the manifest ------------------------------------------------------------------

function defaultManifest() {
  return { line: 'AGENTS.md', road: 'THE_ROAD.md', state: 'STATE_OF_BUILD.md', log: 'SEAT_LOG.md', doctrine: ['doctrine', 'foundation'], plans: null, wall: '.' };
}

/** <home>/line.manifest.json when present and readable; each absent key from the default. */
function loadManifest(home) {
  const m = defaultManifest();
  let got;
  try {
    got = JSON.parse(fs.readFileSync(path.join(home, 'line.manifest.json'), 'utf8'));
  } catch {
    return m;
  }
  if (!got || typeof got !== 'object') return m;
  const s = (v) => (typeof v === 'string' ? v : '');
  return {
    line: s(got.line) || m.line,
    road: s(got.road) || m.road,
    state: s(got.state) || m.state,
    log: s(got.log) || m.log,
    doctrine: Array.isArray(got.doctrine) && got.doctrine.length ? got.doctrine.map(String) : m.doctrine,
    plans: got.plans && typeof got.plans === 'object' ? got.plans : m.plans,
    wall: s(got.wall) || m.wall,
  };
}

// ---- RBAC --------------------------------------------------------------------------

function defaultPolicy() {
  const role = (name, description, perms, implies) => ({ name, description, permissions: perms, ...(implies ? { implies } : {}) });
  return {
    roles: {
      operator: role('operator', 'the hand; holds the gate', { tools: 'allow', read: 'allow', edit: 'allow' }),
      steward: role('steward', 'plans, specs, keeps THE_ROAD', { tools: 'allow', read: 'allow', edit: 'allow' }, ['agent']),
      agent: role('agent', 'a declared seat with limited scope', { tools: 'allow', read: 'allow', edit: 'deny' }),
      guest: role('guest', 'unauthenticated; deny all', { tools: 'deny', read: 'deny', edit: 'deny' }),
    },
    assign: {},
  };
}

/** <home>/rbac.json merged over the default: custom roles override, absent keep. */
function loadPolicy(home) {
  const p = defaultPolicy();
  let got;
  try {
    got = JSON.parse(fs.readFileSync(path.join(home, 'rbac.json'), 'utf8'));
  } catch {
    return p;
  }
  if (!got || typeof got !== 'object') return p;
  for (const [k, v] of Object.entries(got.roles || {})) p.roles[k] = v;
  for (const [k, v] of Object.entries(got.assign || {})) p.assign[k] = v;
  return p;
}

function kindsOf(writes) {
  return writes ? ['tools', 'edit'] : ['tools', 'read'];
}

function describe(toolName, k) {
  if (k === 'edit') return `${toolName} writes`;
  if (k === 'read') return `${toolName} reads`;
  return 'calling any tool at all';
}

function asked(r, label, roleName, toolName, kinds) {
  const perms = (r && r.permissions) || {};
  if (perms[toolName] === 'allow') return { allowed: true, decided: true, why: '' };
  if (perms[toolName] === 'deny') return { allowed: false, decided: true, why: `${label} ${q(roleName)} denies tool ${q(toolName)}` };
  if (perms['*'] === 'allow') return { allowed: true, decided: true, why: '' };
  if (perms['*'] === 'deny') return { allowed: false, decided: true, why: `${label} ${q(roleName)} denies all tools` };
  let every = true;
  for (const k of kinds) {
    if (perms[k] === 'allow') continue;
    if (perms[k] === 'deny') return { allowed: false, decided: true, why: `${label} ${q(roleName)} denies ${k} (${describe(toolName, k)})` };
    every = false;
  }
  return every ? { allowed: true, decided: true, why: '' } : { allowed: false, decided: false, why: '' };
}

/** rbac.Can: [allowed, the role that decided, reason]. */
function can(p, agentID, toolName, writes) {
  const roleName = p.assign[agentID];
  if (roleName === undefined) return [false, 'guest', `agent ${q(agentID)} has no assigned role`];
  if (!p.roles[roleName]) return [false, 'guest', `role ${q(roleName)} not found in policy`];
  const kinds = kindsOf(writes);
  const visited = new Set();
  const queue = [roleName];
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const r = p.roles[current];
    if (!r) continue;
    const label = current === roleName ? 'role' : 'implied role';
    const a = asked(r, label, current, toolName, kinds);
    if (a.decided) return [a.allowed, current, a.why];
    queue.push(...(r.implies || []));
  }
  return [false, roleName, `role ${q(roleName)} allows neither tool ${q(toolName)} by name nor its kind (${kinds[1]}: ${describe(toolName, kinds[1])})`];
}

function savePolicy(home, p) {
  const roles = {};
  for (const [k, r] of Object.entries(p.roles)) {
    roles[k] = struct({ name: r.name ?? '', description: r.description ?? '', permissions: r.permissions ?? null, implies: r.implies && r.implies.length ? r.implies : undefined });
  }
  fs.writeFileSync(path.join(home, 'rbac.json'), marshal(struct({ roles, assign: p.assign }), '  '));
}

// ---- trust -------------------------------------------------------------------------

function trustPath(home) {
  return path.join(home, 'state', 'trust.json');
}

function loadTrust(home) {
  try {
    const s = JSON.parse(fs.readFileSync(trustPath(home), 'utf8'));
    return { grants: Array.isArray(s.grants) ? s.grants : [] };
  } catch {
    return { grants: [] };
  }
}

function saveTrust(home, s) {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const grants = s.grants.length ? s.grants.map((g) => struct({ from: g.from, to: g.to, tool: g.tool, action: g.action, ts: g.ts })) : null;
  const tmp = trustPath(home) + '.tmp';
  fs.writeFileSync(tmp, marshal(struct({ grants }), '  ') + '\n');
  fs.renameSync(tmp, trustPath(home));
}

function upsertTrust(home, g) {
  const s = loadTrust(home);
  if (!g.ts) g.ts = rfc3339();
  const kept = s.grants.filter((e) => !(e.from === g.from && e.to === g.to && e.tool === g.tool));
  kept.push(g);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  kept.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.tool, b.tool));
  s.grants = kept;
  saveTrust(home, s);
  return s;
}

function renderTrust(home) {
  const s = loadTrust(home);
  if (!s.grants.length) return 'TRUST — no delegations recorded (empty is honest, never fabricated).';
  let b = `TRUST — ${s.grants.length} delegation(s):\n`;
  for (const g of s.grants) b += `  ${String(g.action).toUpperCase()} ${g.tool}: ${g.from} → ${g.to} (${g.ts})\n`;
  return b;
}

// ---- the archive is not a tenant ----------------------------------------------------

function barred(home) {
  let p = path.normalize(String(home));
  for (;;) {
    if (path.basename(p).toLowerCase() === 'archive') return true;
    const parent = path.dirname(p);
    if (parent === p) return false;
    p = parent;
  }
}

// ---- a tenant ----------------------------------------------------------------------

class Tenant {
  constructor(name, home) {
    this.name = name;
    this.home = home;
    this.manifest = loadManifest(home);
    this.policy = loadPolicy(home);
    this.engine = '';
  }

  resolve(rel) {
    if (!rel) return '';
    return goIsAbs(rel) ? rel : path.join(this.home, rel);
  }

  linePath() {
    return this.resolve(this.manifest.line);
  }

  logPath() {
    return this.resolve(this.manifest.log);
  }

  roadPath() {
    return this.resolve(this.manifest.road);
  }

  statePath() {
    return this.resolve(this.manifest.state);
  }

  roadCandidates() {
    const out = [];
    if (this.manifest.road) out.push(this.resolve(this.manifest.road));
    if (this.manifest.state) out.push(this.resolve(this.manifest.state));
    return out;
  }

  doctrineDirs() {
    return this.manifest.doctrine.map((d) => this.resolve(d));
  }

  wallRoot() {
    return this.resolve(this.manifest.wall);
  }

  /** A plan name: the manifest's map, the built-in names, else plans/<name> only (a name is a name, not a path). */
  planPath(which) {
    which = String(which || '').trim().toLowerCase();
    if (!which) return '';
    const plans = this.manifest.plans || {};
    if (Object.prototype.hasOwnProperty.call(plans, which)) return this.resolve(String(plans[which]));
    const builtin = { road: 'THE_ROAD.md', state: 'STATE_OF_BUILD.md', catalog: 'THE_CATALOG.md', acceptance: 'ACCEPTANCE.md', charter: 'CHARTER.md' };
    if (builtin[which]) return this.resolve(builtin[which]);
    if (which === '.' || which === '..' || goIsAbs(which) || which.includes(':')) return '';
    const home = path.resolve(this.home);
    const p = path.resolve(this.resolve(path.join('plans', which)));
    if (!p.startsWith(path.join(home, 'plans') + path.sep)) return '';
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* absent */
    }
    return '';
  }

  rbacOpen() {
    return Object.keys(this.policy.assign).length === 0;
  }

  roleOf(agentID) {
    const r = this.policy.assign[agentID];
    return r === undefined ? ['', false] : [r, true];
  }

  /** [allowed, role, reason]; open mode allows every call. */
  checkRBAC(agentID, toolName, writes) {
    if (this.rbacOpen()) return [true, '', ''];
    return can(this.policy, agentID, toolName, writes);
  }

  assignRole(agentID, roleName) {
    if (!this.policy.roles[roleName]) throw new Error(`role ${q(roleName)} does not exist`);
    this.policy.assign[String(agentID).toLowerCase()] = roleName;
  }

  savePolicy() {
    savePolicy(this.home, this.policy);
  }
}

// ---- the registry --------------------------------------------------------------------

class Tenants {
  constructor() {
    this.order = [];
    this.byName = new Map();
    this.defaultTenant = '';
  }

  add(name, home) {
    if (!name || !home) throw new Error('tenant needs both name and path');
    const abs = path.resolve(home);
    if (barred(abs) || barred(name)) {
      throw new Error(
        `refused: THE LINE does not carry ${q(abs)} as ${q(name)}. RULE 1: the archive is outside the estate -- never served, never indexed, never read from here, and never by a flag`,
      );
    }
    const key = name.toLowerCase();
    if (!this.byName.has(key)) this.order.push(key);
    this.byName.set(key, new Tenant(key, abs));
    return this;
  }

  has(name) {
    return this.byName.has(String(name || '').trim().toLowerCase());
  }

  setEngine(name, cmd) {
    const t = this.byName.get(String(name || '').trim().toLowerCase());
    if (!t) throw new Error(`cannot set engine for unknown tenant ${q(name)}`);
    t.engine = cmd;
  }

  setDefault(name) {
    const key = String(name).toLowerCase();
    if (!this.byName.has(key)) throw new Error(`default tenant ${q(name)} is not registered`);
    this.defaultTenant = key;
  }

  default() {
    if (this.defaultTenant) return this.defaultTenant;
    for (const k of ['neiro', 'atlas']) if (this.order.includes(k)) return k;
    if (this.order.length) return this.order[0];
    return '';
  }

  /** An unknown project refuses BY NAME: strangers get no context. */
  resolve(project) {
    let key = String(project || '').trim().toLowerCase();
    if (!key) key = this.default();
    const t = this.byName.get(key);
    if (!t) throw new Error(`unknown project ${q(project || '')}: not a carried tenant`);
    return t;
  }

  names() {
    return [...this.order];
  }
}

module.exports = { Tenant, Tenants, loadManifest, defaultManifest, loadPolicy, defaultPolicy, can, savePolicy, loadTrust, upsertTrust, renderTrust, barred };
