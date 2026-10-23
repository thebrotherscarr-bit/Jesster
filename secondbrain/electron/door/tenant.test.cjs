const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tenants, loadManifest, defaultPolicy, can, loadPolicy, upsertTrust, renderTrust, barred } = require('./tenant.cjs');
const { marshal, struct, dial, goIsAbs } = require('./util.cjs');

const world = () => fs.mkdtempSync(path.join(os.tmpdir(), 'door-tenant-'));

test('an unknown project is refused by name, and the default answers an unnamed call', () => {
  const a = world();
  const b = world();
  const reg = new Tenants().add('Research', a).add('atlas', b);
  assert.equal(reg.resolve('').name, 'atlas', 'atlas is the default when none is set, as tenant.Default says');
  reg.setDefault('research');
  assert.equal(reg.resolve('').name, 'research');
  assert.equal(reg.resolve('RESEARCH').home, path.resolve(a));
  assert.throws(() => reg.resolve('stranger'), /unknown project "stranger": not a carried tenant/);
  assert.deepEqual(reg.names(), ['research', 'atlas']);
});

test('the archive is never carried, by any road', () => {
  const root = world();
  assert.ok(barred(path.join(root, 'Archive', 'estate')));
  assert.ok(!barred(path.join(root, 'archived')));
  assert.throws(() => new Tenants().add('x', path.join(root, 'Archive')), /RULE 1/);
  assert.throws(() => new Tenants().add('archive', root), /RULE 1/);
});

test('the manifest overrides only what it names', () => {
  const home = world();
  assert.deepEqual(loadManifest(home), { line: 'AGENTS.md', road: 'THE_ROAD.md', state: 'STATE_OF_BUILD.md', log: 'SEAT_LOG.md', doctrine: ['doctrine', 'foundation'], plans: null, wall: '.' });
  fs.writeFileSync(path.join(home, 'line.manifest.json'), JSON.stringify({ log: 'handoffs', plans: { hld: 'docs/HLD.md' } }));
  const m = loadManifest(home);
  assert.equal(m.log, 'handoffs');
  assert.equal(m.line, 'AGENTS.md');
  const t = new Tenants().add('w', home).resolve('w');
  assert.equal(t.planPath('hld'), path.join(t.home, 'docs', 'HLD.md'));
});

test('a plan name is a name, not a path', () => {
  const home = world();
  fs.mkdirSync(path.join(home, 'plans'));
  fs.writeFileSync(path.join(home, 'plans', 'next.md'), 'next');
  fs.writeFileSync(path.join(home, '.env'), 'X=1');
  const t = new Tenants().add('w', home).resolve('w');
  assert.equal(t.planPath('next.md'), path.join(t.home, 'plans', 'next.md'));
  assert.equal(t.planPath('road'), path.join(t.home, 'THE_ROAD.md'));
  for (const bad of ['.env', '../.env', 'C:\\Windows\\win.ini', '..', 'plans']) assert.equal(t.planPath(bad), '', bad);
});

test('rbac asks the tool by name, then the wildcard, then the kinds; open mode passes all', () => {
  const p = defaultPolicy();
  p.assign = { seat: 'agent', boss: 'steward', anon: 'guest', ghost: 'nobody' };
  assert.deepEqual(can(p, 'seat', 'records', false), [true, 'agent', '']);
  assert.deepEqual(can(p, 'seat', 'remember', true), [false, 'agent', 'role "agent" denies edit (remember writes)']);
  assert.deepEqual(can(p, 'boss', 'remember', true), [true, 'steward', '']);
  assert.deepEqual(can(p, 'anon', 'records', false), [false, 'guest', 'role "guest" denies tools (calling any tool at all)']);
  assert.deepEqual(can(p, 'ghost', 'records', false), [false, 'guest', 'role "nobody" not found in policy']);
  assert.deepEqual(can(p, 'x', 'records', false), [false, 'guest', 'agent "x" has no assigned role']);
  p.roles.agent.permissions.remember = 'allow';
  assert.deepEqual(can(p, 'seat', 'remember', true), [true, 'agent', ''], 'a name beats a kind');
  const home = world();
  const t = new Tenants().add('w', home).resolve('w');
  assert.ok(t.rbacOpen());
  assert.deepEqual(t.checkRBAC('anyone', 'remember', true), [true, '', '']);
  t.assignRole('Seat', 'agent');
  t.savePolicy();
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'rbac.json'), 'utf8'));
  assert.equal(saved.assign.seat, 'agent', 'the actor is lower-cased, as rbac.AssignAgent does');
  assert.deepEqual(Object.keys(saved), ['roles', 'assign']);
  assert.equal(loadPolicy(home).assign.seat, 'agent');
  assert.throws(() => t.assignRole('x', 'king'), /role "king" does not exist/);
});

test('trust is upserted and listed honestly', () => {
  const home = world();
  assert.match(renderTrust(home), /no delegations recorded/);
  upsertTrust(home, { from: 'research', to: 'atlas', tool: 'records', action: 'allow', ts: '2026-10-22T00:00:00Z' });
  upsertTrust(home, { from: 'research', to: 'atlas', tool: 'records', action: 'deny', ts: '2026-10-22T00:00:01Z' });
  const out = renderTrust(home);
  assert.match(out, /TRUST — 1 delegation\(s\):/);
  assert.match(out, /DENY records: research → atlas/);
  const raw = fs.readFileSync(path.join(home, 'state', 'trust.json'), 'utf8');
  assert.ok(raw.startsWith('{\n  "grants": [\n    {\n      "from": "research"'), 'the struct order is Go\'s');
});

test('JSON is written as Go writes it: maps sorted, structs in order, <>& escaped', () => {
  assert.equal(marshal({ b: 1, a: [struct({ z: 1, y: undefined, x: '<a&b>' })] }, ''), '{"a":[{"z":1,"x":"\\u003ca\\u0026b\\u003e"}],"b":1}');
  assert.equal(marshal({ k: '<p>' }, '', false), '{"k":"<p>"}');
  assert.equal(marshal({ n: undefined }, ''), '{"n":null}');
});

test('a wall dial reads the environment, then .env here and one level up, and returns only a boolean', () => {
  const up = world();
  const home = path.join(up, 'w');
  fs.mkdirSync(home);
  assert.equal(dial(home, 'GIT_REMOTE', {}), false);
  assert.equal(dial(home, 'GIT_REMOTE', { MANJUEL_GIT_REMOTE: 'yes' }), true);
  fs.writeFileSync(path.join(up, '.env'), '# a comment\nexport CHAINKIT_GIT_REMOTE="on"\n');
  assert.equal(dial(home, 'GIT_REMOTE', {}), true);
  assert.equal(dial(home, 'RACK_PULL', {}), false);
});

test('an absolute path is Go\'s: on Windows it needs a volume', () => {
  assert.equal(goIsAbs('C:\\x', 'win32'), true);
  assert.equal(goIsAbs('\\\\server\\share', 'win32'), true);
  assert.equal(goIsAbs('/x', 'win32'), false);
  assert.equal(goIsAbs('/x', 'linux'), true);
});
