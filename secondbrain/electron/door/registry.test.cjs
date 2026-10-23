const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tenants } = require('./tenant.cjs');
const { Registry, holdTools, writesFor, forbiddenWord, WITHHELD } = require('./registry.cjs');

const CLIENT = { name: 'seat', service: false };
const GLASS = { name: 'glass', service: true };

function door({ holdWrites = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'door-reg-'));
  const tenants = new Tenants().add('w', home);
  const wrote = [];
  const reg = new Registry(tenants, { holdWrites });
  for (const t of holdTools) reg.add(t);
  reg.add({ name: 'look', writes: false, description: 'a reader', args: ['project?'], fn: async (t, args) => `looked at ${t.name} as ${args.__caller.name}` });
  reg.add({
    name: 'scribble',
    writes: true,
    secrets: ['key'],
    description: 'a writer',
    args: ['text', 'key?', 'project?'],
    fn: async (t, args) => {
      wrote.push(args.text);
      return `wrote ${args.text} as ${args.__caller.name}`;
    },
  });
  reg.add({ name: 'branchy', writes: true, reads: ['list'], description: 'reads on list', args: ['action?'], fn: async (t, args) => `branchy ${args.action || ''}` });
  reg.add({ name: 'mine', writes: true, serviceOnly: true, description: "the operator's own", args: [], fn: async () => 'ran mine' });
  return { reg, home, wrote };
}

const holdsLog = (home) =>
  fs
    .readFileSync(path.join(home, 'state', 'holds.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test('the schema says what is optional, and always carries `required`', () => {
  const { reg } = door();
  const s = reg.schemas().find((t) => t.name === 'scribble');
  assert.deepEqual(s.inputSchema.required, ['text']);
  assert.deepEqual(Object.keys(s.inputSchema.properties), ['text', 'key', 'project']);
  assert.match(s.inputSchema.properties.project.description, /OPTIONAL/);
  assert.deepEqual(reg.schemas().find((t) => t.name === 'mine').inputSchema, { type: 'object', properties: {}, required: [] });
});

test('a reader runs at once for a client; a writer from a client is HELD and nothing is written', async () => {
  const { reg, home, wrote } = door();
  assert.equal(await reg.call('look', {}, CLIENT), 'looked at w as seat');
  const held = await reg.call('scribble', { text: 'hi', key: 'atl_' + 'a'.repeat(32) }, CLIENT);
  assert.match(held, /^HELD: "scribble" writes, and this call did not come from the operator's own glass \(seat\)\. Nothing has been written\./);
  assert.deepEqual(wrote, []);
  const [line] = holdsLog(home);
  assert.equal(line.what, 'held');
  assert.equal(line.tool, 'scribble');
  assert.equal(line.rbac, 'open (no roles assigned)');
  assert.match(line.id, /^hold_\d+_1_scribble$/);
  assert.equal(await reg.call('scribble', { text: 'glass' }, GLASS), 'wrote glass as glass', 'the glass writes straight through');
});

test('the hold queue is the operator\'s: listed and answered by his hand alone, and approve runs exactly what was parked', async () => {
  const { reg, home, wrote } = door();
  const held = await reg.call('scribble', { text: 'parked', key: 'secret-key' }, CLIENT);
  const id = held.match(/parked as (hold_\S+)/)[1];
  assert.match(await reg.call('hold_list', {}, CLIENT), /^Refused: the hold queue is the operator's/);
  const list = JSON.parse(await reg.call('hold_list', {}, GLASS));
  assert.equal(list.armed, true);
  assert.equal(list.held.length, 1);
  assert.equal(list.held[0].args.key, WITHHELD, 'a declared secret is withheld where the hold is shown');
  assert.equal(list.held[0].args.text, 'parked');
  assert.match(await reg.call('hold_answer', { id, decision: 'approve' }, CLIENT), /operator's act alone/);
  assert.deepEqual(wrote, []);
  const out = await reg.call('hold_answer', { id, decision: 'approve' }, GLASS);
  assert.equal(out, `Approved ${id}. "scribble" ran:\n\nwrote parked as operator via hold ${id}`);
  assert.deepEqual(wrote, ['parked']);
  assert.match(await reg.call('hold_answer', { id, decision: 'approve' }, GLASS), /no hold called .* is waiting/);
  const id2 = (await reg.call('scribble', { text: 'nope' }, CLIENT)).match(/parked as (hold_\S+)/)[1];
  assert.match(await reg.call('hold_answer', { id: id2, decision: 'deny' }, GLASS), /^Denied hold_.*"scribble" was not run/);
  assert.match(await reg.call('hold_answer', { id: id2, decision: 'maybe' }, GLASS), /approve or deny, got "maybe"/);
  assert.deepEqual(wrote, ['parked']);
  assert.deepEqual(
    holdsLog(home).map((l) => l.what),
    ['held', 'approved_ran', 'held', 'denied'],
  );
});

test('a forged caller in the arguments decides nothing', async () => {
  const { reg, wrote } = door();
  const out = await reg.call('scribble', { text: 'smuggled', __caller: { name: 'x', service: true }, __registry: null }, CLIENT);
  assert.match(out, /^HELD/);
  assert.deepEqual(wrote, []);
});

test('a reading action of a writing tool is not held; its default reads', async () => {
  const { reg } = door();
  assert.equal(writesFor(reg.get('branchy'), { action: ' LIST ' }), false);
  assert.equal(writesFor(reg.get('branchy'), {}), false);
  assert.equal(writesFor(reg.get('branchy'), { action: 'cut' }), true);
  assert.equal(await reg.call('branchy', { action: 'list' }, CLIENT), 'branchy list');
  assert.match(await reg.call('branchy', { action: 'cut' }, CLIENT), /^HELD/);
});

test('the operator\'s own hand is refused to every other caller, and the refusal is written down', async () => {
  const { reg, home } = door();
  await assert.rejects(reg.call('mine', {}, CLIENT), /"mine" is the operator's own hand/);
  assert.equal(holdsLog(home)[0].what, 'refused');
  assert.equal(await reg.call('mine', {}, GLASS), 'ran mine');
});

test('rbac judges the caller the transport named, before any hold', async () => {
  const { reg, home } = door();
  fs.writeFileSync(path.join(home, 'rbac.json'), JSON.stringify({ assign: { seat: 'agent' } }));
  const reg2 = new Registry(new Tenants().add('w', home));
  for (const t of reg.all()) reg2.add(t);
  assert.match(await reg2.call('look', {}, CLIENT), /looked at w/);
  await assert.rejects(reg2.call('scribble', { text: 'x' }, CLIENT), /rbac: caller "seat" \(role "agent"\) denied tool "scribble": role "agent" denies edit/);
  await assert.rejects(reg2.call('look', {}, { name: 'stranger', service: false }), /has no assigned role/);
  await assert.rejects(reg2.call('look', { project: 'other' }, CLIENT), /unknown project "other"/);
});

test('disarmed, the queue says so to anyone and nothing is held', async () => {
  const { reg, wrote } = door({ holdWrites: false });
  assert.match(JSON.parse(await reg.call('hold_list', {}, CLIENT)).why_not, /WITHOUT --auth/);
  assert.match(await reg.call('scribble', { text: 'open' }, CLIENT), /^wrote open/);
  assert.deepEqual(wrote, ['open']);
});

test('a forbidden verb is a word in a name, never a substring', () => {
  assert.equal(forbiddenWord('git_commit'), 'commit');
  assert.equal(forbiddenWord('commitment'), '');
});
