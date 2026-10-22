const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build } = require('./index.cjs');

const GLASS = { name: 'glass', service: true };
const CLIENT = { name: 'seat', service: false };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function put(home, rel, text) {
  const p = path.join(home, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function made() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'door-rec-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'door-rec2-'));
  put(home, 'AGENTS.md', '# the line\nwho sits here');
  put(home, 'THE_ROAD.md', 'road ahead\nstep 2\nstep 3\nstep 4');
  put(home, 'SEAT_LOG.md', ['# log', '## 2026-10-21 — sitting 1', 'toll', '## 2026-10-22 — sitting 2', 'toll'].join('\n'));
  put(home, 'doctrine/LAW_ONE.md', 'the first law');
  put(home, 'foundation/vision.txt', 'the vision');
  put(home, 'law/SITTING_LAWS.md', 'law');
  put(home, 'CHANGELOG.md', 'changes');
  put(home, 'SPEC.md', 'spec');
  put(home, 'notes.md', 'other');
  put(home, '.env', 'NEVER=served');
  put(home, 'agents/coder.md', '## Coder\n- **Model Target:** qwen3:8b\r\n- **When**: always\n- **System Prompt:**\nYou write code.\nCarefully.\n');
  put(home, 'pipelines.md', '## Pipeline: build\n1. Coder (when: code)\n2. Reviewer\n');
  put(home, 'logs/standup_2026.md', 'a standup');
  put(home, 'plans/next.md', 'the next plan');
  put(home, 'tests/last_run.json', JSON.stringify({ strokes: { passed: 10, total: 10, green: true } }));
  put(home, 'tests/run_history.jsonl', [JSON.stringify({ suite: 'standup', n: 1 }), JSON.stringify({ suite: 'strokes' }), '{"half'].join('\n'));
  put(home, 'sessions/sessions.jsonl', [JSON.stringify({ n: 1, started: 'a', runs: [] }), JSON.stringify({ n: 1, started: 'a', ended: 'b', toll_paid: true, runs: [1, 2] }), JSON.stringify({ n: 2, started: 'c', ended: '' })].join('\n') + '\n');
  const reg = build([
    ['research', home],
    ['atlas', other],
  ], { defaultProject: 'research' });
  return { reg, home, other };
}

test('get_in_line carries the standing law, the line, the road and the log tail', async () => {
  const { reg } = made();
  const out = await reg.call('get_in_line', {}, CLIENT);
  assert.ok(out.startsWith('== ATLAS ORIENTATION ==\nstate = fold(record)'));
  assert.match(out, /-- LINE \(research\) --\n# the line\nwho sits here\n\n-- ROAD --\nroad ahead/);
  assert.match(out, /-- LOG TAIL --\n# log\n## 2026-10-21/);
  const atlas = await reg.call('get_in_line', { project: 'atlas' }, CLIENT);
  assert.match(atlas, /\[no line document carried for "atlas"\]/);
  assert.match(atlas, /\[no handoffs carried for "atlas"\]/);
});

test('muster, read_handoffs, the doctrine and the wall', async () => {
  const { reg, home } = made();
  assert.equal(await reg.call('muster', {}, CLIENT), '2 carried projects:\n  atlas\n  research', 'carried in name order, as the Go door adds its --tenant flags');
  const log = fs.readFileSync(path.join(home, 'SEAT_LOG.md'), 'utf8');
  assert.equal(await reg.call('read_handoffs', {}, CLIENT), `SEAT_LOG.md · sha256 ${sha(log)}\n\n${log}\n`);
  await assert.rejects(reg.call('read_handoffs', { project: 'atlas' }, CLIENT), /handoffs missing for "atlas"/);
  assert.equal(await reg.call('list_doctrine', {}, CLIENT), 'THE CARRIED LAW — 2 documents, read-only:\n  LAW_ONE.md\n  vision.txt\n');
  assert.equal(await reg.call('read_doctrine', { name: 'law_one' }, CLIENT), `LAW_ONE.md (doctrine) · sha256 ${sha('the first law')}\n\nthe first law`);
  await assert.rejects(reg.call('read_doctrine', { name: 'nope' }, CLIENT), /No such document in the hold for "research": nope/);
  assert.match(await reg.call('list_doctrine', { project: 'atlas' }, CLIENT), /The hold is empty/);
  assert.match(await reg.call('check_the_wall', { path: 'plans/next.md' }, CLIENT), /^INSIDE the wall/);
  assert.match(await reg.call('check_the_wall', { path: '../elsewhere' }, CLIENT), /^REFUSED — outside the wall/);
});

test('state_matrix and read_plan', async () => {
  const { reg } = made();
  const m = await reg.call('state_matrix', {}, CLIENT);
  assert.match(m, /^THE MATRIX — state = fold\(record\)\n {2}road {3}\d+ bytes\n {2}state {2}absent\n {2}log {4}\d+ bytes\n/);
  const js = JSON.parse(m.slice(m.indexOf('{')));
  assert.equal(js.equation, 'state = fold(record)');
  assert.deepEqual(Object.keys(js.rows[1]), ['key', 'present', 'bytes'], 'an empty head is omitted');
  assert.equal(js.rows[0].head, 'road ahead\nstep 2\nstep 3');
  assert.equal(await reg.call('read_plan', { which: 'next.md' }, CLIENT), `next.md · sha256 ${sha('the next plan')}\n\nthe next plan`);
  await assert.rejects(reg.call('read_plan', { which: '../.env' }, CLIENT), /No such plan "..\/.env"/);
  await assert.rejects(reg.call('read_plan', { which: 'charter' }, CLIENT), /present in the map but unreadable/);
});

test('records sorts the estate\'s documents by kind, serves one whole, and never serves .env', async () => {
  const { reg } = made();
  const all = JSON.parse(await reg.call('records', {}, CLIENT));
  assert.deepEqual(all.kinds.map((k) => k.kind), ['doctrine', 'record', 'spec', 'agents', 'commands', 'logs', 'other']);
  assert.deepEqual(all.kinds[4].documents.map((d) => d.name), ['AGENTS.md', 'pipelines.md'], 'agents.md claims AGENTS.md, case folded, as rootKind does');
  const doctrine = all.kinds[0].documents;
  assert.equal(doctrine[0].name, 'law/SITTING_LAWS.md');
  assert.equal(doctrine[0].sealed, true);
  const one = JSON.parse(await reg.call('records', { name: 'changelog.md' }, CLIENT));
  assert.equal(one.text, 'changes');
  assert.equal(one.sha256, sha('changes'));
  assert.equal(one.sealed, false);
  await assert.rejects(reg.call('records', { name: '.env' }, CLIENT), /no record named ".env" in research\. Kinds carried: doctrine \(1\), record \(2\)/);
  await assert.rejects(reg.call('records', { name: '../SEAT_LOG.md' }, CLIENT), /no record named/);
  const logs = JSON.parse(await reg.call('records', { kind: 'logs' }, CLIENT));
  assert.equal(logs.count, 1);
});

test('seats reads every declared field and the pipelines a seat stands in', async () => {
  const { reg } = made();
  const out = JSON.parse(await reg.call('seats', {}, CLIENT));
  const [coder] = out.seats;
  assert.equal(coder.name, 'Coder');
  assert.deepEqual(coder.fields, { 'Model Target': 'qwen3:8b', When: 'always' });
  assert.deepEqual(coder.field_order, ['Model Target', 'When', 'System Prompt']);
  assert.equal(coder.prompt, 'You write code.\nCarefully.');
  assert.deepEqual(coder.stands_in, [{ note: 'when: code', pipeline: 'build', step: 1, when: 'code' }]);
  const none = JSON.parse(await reg.call('seats', { project: 'atlas' }, CLIENT));
  assert.equal(none.seats_error, 'never run in this world');
});

test('proofs reads the suites\' stamp, the standups and the sittings off the record', async () => {
  const { reg } = made();
  const p = JSON.parse(await reg.call('proofs', {}, CLIENT));
  assert.deepEqual(p.suites, { strokes: { green: true, passed: 10, total: 10 } });
  assert.deepEqual(p.standups, [{ n: 1, suite: 'standup' }]);
  assert.equal(p.parity_error, 'never run in this world');
  assert.equal(p.record.sittings, 2);
  assert.equal(p.record.tolled, 1);
  assert.equal(p.record.runs, 2);
  assert.equal(p.record.still_open, 1);
  assert.equal(p.record.seat_log_tolls, 2);
  assert.deepEqual(p.record.recent[1], { ended: '', n: 2, runs: 0, started: 'c', toll_paid: null });
  assert.deepEqual(p.standup_reports, ['logs/standup_2026.md']);
});

test('env_list reads each world\'s sitting off its own ledger (the native one; the door forwards it for now)', async () => {
  const { reg } = made();
  reg.add(require('./records.cjs').recordTools.find((t) => t.name === 'env_list'));
  assert.equal(await reg.call('env_list', {}, CLIENT), '0 engine(s) open:\n\ncarried worlds:\n  atlas            closed\n  research         sat in elsewhere (sitting 2, c)\n');
});

test('remember is held for a client and appends one testimony line on his approve', async () => {
  const { reg, home } = made();
  const held = await reg.call('remember', { text: 'keep this' }, CLIENT);
  assert.match(held, /^HELD: "remember" writes/);
  assert.ok(!fs.existsSync(path.join(home, 'state', 'remembered.jsonl')));
  const id = held.match(/parked as (hold_\S+)/)[1];
  const out = await reg.call('hold_answer', { id, decision: 'approve' }, GLASS);
  assert.match(out, /REMEMBERED \(testimony, staged for operator ascend\) — \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ · sha256 [0-9a-f]{64}\nkeep this$/);
  const line = fs.readFileSync(path.join(home, 'state', 'remembered.jsonl'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(line)), ['project', 'testimony', 'text', 'ts']);
  await assert.rejects(reg.call('remember', { text: '  ' }, GLASS), /remember needs some text/);
});

test('tenants, rbac and trust through the door', async () => {
  const { reg, home } = made();
  assert.equal(await reg.call('tenant_list', {}, CLIENT), 'TENANTS — 2 carried project(s):\n  - atlas · open mode · 0 trust grant(s)\n  - research · open mode · 0 trust grant(s) (you are here)\n');
  assert.equal(await reg.call('tenant_rbac_check', { actor: 'seat', tool: 'remember' }, CLIENT), 'ALLOWED — seat on research (open mode)');
  await assert.rejects(reg.call('tenant_rbac_check', { actor: 'seat', tool: 'nope' }, CLIENT), /unknown tool: "nope"/);
  assert.match(await reg.call('tenant_rbac_assign', { actor: 'seat', role: 'agent' }, CLIENT), /^HELD/);
  assert.equal(await reg.call('tenant_rbac_assign', { actor: 'seat', role: 'agent' }, GLASS), 'ASSIGNED role "agent" to agent "seat" in tenant "research"');
  assert.equal(await reg.call('tenant_rbac_check', { actor: 'seat', tool: 'remember' }, GLASS), 'DENIED — seat (role "agent") on research: role "agent" denies edit (remember writes)');
  await assert.rejects(reg.call('tenant_trust', { from_project: 'research', to_project: 'atlas', tool: 'push', action: 'allow' }, GLASS), /forbidden verb/);
  await assert.rejects(reg.call('tenant_trust', { from_project: 'research', to_project: 'mars', tool: 'records', action: 'allow' }, GLASS), /unknown project "mars"/);
  assert.match(await reg.call('tenant_trust', { from_project: 'Research', to_project: 'atlas', tool: 'records', action: 'allow' }, GLASS), /^TRUST allow records: research → atlas \(witnessed state\/trust.json · sha256 [0-9a-f]{64}\)$/);
  assert.match(await reg.call('tenant_trust_list', {}, CLIENT), /ALLOW records: research → atlas/);
  assert.ok(fs.existsSync(path.join(home, 'rbac.json')));
});
