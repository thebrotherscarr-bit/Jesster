const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('../vaultfs.cjs');
const { Schedules, describeWhen, nextRun, runSchedule } = require('./schedules.cjs');
const workflows = require('./workflows.cjs');
const estate = require('../estate.cjs');
const ex = require('./flowExamples.cjs');

// The Flows shelf's built-in examples (the operator, 2026-11-05: "I don't have a way to create my own flows or any of
// the evals built up with examples yet"): an eval flow per eval set file, two recipes; seeded once, never over his.

/** A Steward folder with eval set files as his harness has them (name, tier and runner lines among the rest). */
function stewardWith(sets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  const evals = path.join(dir, 'harness', 'steward', 'evals');
  fs.mkdirSync(evals, { recursive: true });
  for (const [file, name, tier, runner] of sets) fs.writeFileSync(path.join(evals, file), `# a set\r\nname: ${name}\r\ntier: ${tier}\r\nversion: 1\r\nrunner: ${runner}\r\ncases: []\r\n`);
  fs.writeFileSync(path.join(evals, 'baselines.json'), '{}');
  return dir;
}
const SETS = [
  ['t0-small.yaml', 'small', 'T0', 'asks'],
  ['t0-steps.yaml', 'steps', 'T0', 'steps'],
  ['t1-heldout.yaml', 'heldout', 'T1', 'asks'],
  ['ext-bfcl.yaml', 'bfcl', 'ext', 'bfcl'],
  ['ext-aider-py.yaml', 'aider-py', 'ext', 'exercises'],
];

const fresh = () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'flows-')));
  return { vault, schedules: new Schedules(() => vault), vaultDir: vault.dir };
};

test('the eval examples are the yaml files\' sets: Eval: <set>, its tier, eval_start → eval_wait → eval_bars → summarize → note', () => {
  const sets = estate.evalSets(stewardWith(SETS));
  assert.deepEqual(sets, [
    { name: 'aider-py', tier: 'ext', runner: 'exercises' },
    { name: 'bfcl', tier: 'ext', runner: 'bfcl' },
    { name: 'heldout', tier: 'T1', runner: 'asks' },
    { name: 'small', tier: 'T0', runner: 'asks' },
    { name: 'steps', tier: 'T0', runner: 'steps' },
  ]);
  const all = ex.examples(sets);
  assert.deepEqual(all.map((e) => e.name), ['Eval: aider-py', 'Eval: bfcl', 'Eval: heldout', 'Eval: small', 'Eval: steps', 'Repo drift check', 'What shipped this week']);
  const small = all.find((e) => e.name === 'Eval: small');
  assert.deepEqual(small.steps, [{ step: 'eval_start', sets: ['small'], runs: 1 }, 'eval_wait', 'eval_bars']);
  assert.ok(small.summarize && small.deliver.join() === 'note');
  assert.deepEqual(small.tags, ['example', 'eval', 'T0']);
  // ADR-0009: evals run whenever the operator says; no example is marked for the night
  assert.ok(all.every((e) => !('night' in e)), 'no night flag');
  assert.deepEqual(all.find((e) => e.name === 'Repo drift check').steps, ['versions', 'repo_log']);
  assert.deepEqual(all.find((e) => e.name === 'What shipped this week').steps, ['merged_prs', 'releases']);
  // every example is a recipe workflows.cjs takes
  for (const e of all) assert.doesNotThrow(() => workflows.validateSteps(e.steps), e.name);
});

test("on this PC, the eval examples match Steward's own set files", { skip: !fs.existsSync(path.join(process.env.STEWARD_DIR || path.join(__dirname, '..', '..', '..', '..', 'steward'), 'harness', 'steward', 'evals')) }, () => {
  const dir = process.env.STEWARD_DIR || path.join(__dirname, '..', '..', '..', '..', 'steward');
  const folder = path.join(dir, 'harness', 'steward', 'evals');
  const names = fs.readdirSync(folder).filter((f) => f.endsWith('.yaml')).map((f) => /^name:\s*([\w.-]+)/m.exec(fs.readFileSync(path.join(folder, f), 'utf8'))[1]).sort();
  const evalsOnly = ex.examples(estate.evalSets(dir)).filter((e) => e.key.startsWith('eval:'));
  assert.deepEqual(evalsOnly.map((e) => e.name), names.map((n) => `Eval: ${n}`));
});

test('seeding adds the examples once, with no when, tagged example; a deleted one stays deleted', () => {
  const { schedules, vaultDir } = fresh();
  const sets = estate.evalSets(stewardWith(SETS));
  const r = ex.seedExamples({ schedules, vaultDir, sets });
  assert.equal(r.added.length, 7);
  const list = schedules.all();
  assert.equal(list.length, 7);
  for (const s of list) {
    assert.deepEqual(s.when, { type: 'manual' }, 'no schedule: Run now only');
    assert.equal(s.next, null);
    assert.equal(s.whenText, '');
    assert.ok(s.tags.includes('example'));
  }
  assert.equal(describeWhen(list[0].when), 'only on Run now');
  assert.equal(schedules.due(Date.now() + 365 * 24 * 3600 * 1000).length, 0, 'never due on a clock');
  // again: nothing added
  assert.deepEqual(ex.seedExamples({ schedules, vaultDir, sets }).added, []);
  assert.equal(schedules.all().length, 7);
  // deleted: it does not come back
  schedules.remove(list.find((s) => s.name === 'Repo drift check').id);
  assert.deepEqual(ex.seedExamples({ schedules, vaultDir, sets }).added, []);
  assert.equal(schedules.all().length, 6);
});

test('seeding never overwrites his own: a flow with an example\'s name is left as it is', () => {
  const { schedules, vaultDir } = fresh();
  const mine = schedules.add({ name: 'What shipped this week', prompt: 'my own words', when: 'daily 08:30', backend: 'steward' });
  const r = ex.seedExamples({ schedules, vaultDir, sets: [] });
  assert.deepEqual(r.added, ['Repo drift check']);
  const kept = schedules.all().find((s) => s.id === mine.id);
  assert.deepEqual(kept, mine, 'his flow unchanged');
  assert.equal(schedules.all().filter((s) => s.name === 'What shipped this week').length, 1);
});

test('an eval set that appears later is seeded then; with no Steward folder the eval examples wait', () => {
  const { schedules, vaultDir } = fresh();
  assert.deepEqual(ex.seedExamples({ schedules, vaultDir, sets: [] }).added, ['Repo drift check', 'What shipped this week']);
  assert.deepEqual(ex.seedExamples({ schedules, vaultDir, sets: [{ name: 'small', tier: 'T0' }] }).added, ['Eval: small']);
  assert.deepEqual(ex.readSeeded(vaultDir), ['eval:small', 'recipe:repo-drift', 'recipe:shipped-week']);
});

test('a flow with no when runs on Run now and stays unscheduled; edit can give it a when and take it away', async () => {
  const { vault, schedules } = fresh();
  const s = schedules.add({ name: 'Mine', prompt: '', when: '', backend: 'steward', steps: ['versions'], summarize: 'x', deliver: ['note'] });
  assert.equal(nextRun(s.when, Date.now()), null);
  const steward = { runRecipe: async () => ({ run_id: 'r1' }), recipeStatus: async () => ({ state: 'done', ok: true, text: 'done', short: 'ok' }) };
  const r = await runSchedule(s, { schedules, vault, steward, now: Date.now() });
  assert.ok(r.parked, 'run as a workflow');
  assert.equal(schedules.all()[0].next, null, 'still never due');
  const timed = schedules.edit(s.id, { when: 'daily 08:30' });
  assert.equal(timed.when.type, 'daily');
  assert.ok(timed.next);
  const manual = schedules.edit(s.id, { when: '' });
  assert.deepEqual(manual.when, { type: 'manual' });
  assert.equal(manual.next, null);
  assert.equal(manual.whenText, '');
  // tags: kept by edit unless given
  const tagged = schedules.edit(s.id, { tags: ['example'] });
  assert.deepEqual(tagged.tags, ['example']);
  assert.deepEqual(schedules.edit(s.id, { name: 'Mine 2' }).tags, ['example']);
});

test('the stale ag-ui is taken off saved eval flows once: only eval_start steps whose sets are not all asks sets, nothing else', () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-')));
  const schedules = new Schedules(() => vault);
  const sets = estate.evalSets(stewardWith([...SETS, ['t0-direct.yaml', 'direct', 'T0', 'plans']]));
  // as the vault held them on 2026-11-06: examples seeded while AG-UI was the default, and one of his own
  const stale = (set, extra = {}) => schedules.add({ name: `Eval: ${set}`, when: '', backend: 'steward', tags: ['example', 'eval'], steps: [{ step: 'eval_start', sets: [set], runs: 1, transport: 'ag-ui' }, { step: 'eval_wait', hours: 8 }, 'eval_bars'], summarize: 'Say it.', ...extra });
  for (const set of ['bfcl', 'steps', 'direct', 'aider-py', 'small', 'heldout']) stale(set);
  const mine = schedules.add({ name: 'Mine', when: 'daily 23:00', backend: 'steward', steps: [{ step: 'eval_start', sets: ['small', 'bfcl'], runs: 2, transport: 'responses' }, 'eval_wait'], summarize: 'Mine.' });
  const inproc = schedules.add({ name: 'In', when: '', steps: [{ step: 'eval_start', sets: ['bfcl'], transport: 'in-process' }] });
  const before = schedules.all();

  const { changed } = ex.dropStaleTransports({ schedules, vaultDir: vault.dir, sets });
  assert.deepEqual(changed, ['Eval: bfcl', 'Eval: steps', 'Eval: direct', 'Eval: aider-py', 'Mine']);
  const after = Object.fromEntries(schedules.all().map((s) => [s.name, s]));
  for (const set of ['bfcl', 'steps', 'direct', 'aider-py']) assert.deepEqual(after[`Eval: ${set}`].steps[0], { step: 'eval_start', sets: [set], runs: 1 }, set);
  for (const set of ['small', 'heldout']) assert.equal(after[`Eval: ${set}`].steps[0].transport, 'ag-ui', `${set} is an asks set: ag-ui is valid there`);
  assert.deepEqual(after.Mine.steps[0], { step: 'eval_start', sets: ['small', 'bfcl'], runs: 2 }, 'his own: only the transport goes');
  assert.equal(after.In.steps[0].transport, 'in-process', 'in-process is never stale');
  // nothing else on any flow changed: id, name, when, tags, summarize, the other steps, the run log
  for (const b of before) {
    const a = schedules.all().find((x) => x.id === b.id);
    const strip = (s) => ({ ...s, steps: s.steps.map((x) => (x && x.step === 'eval_start' ? { ...x, transport: undefined } : x)) });
    assert.deepEqual(JSON.parse(JSON.stringify(strip(a))), JSON.parse(JSON.stringify(strip(b))), b.name);
  }
  assert.equal(mine.id, after.Mine.id);
  assert.equal(inproc.id, after.In.id);

  // once: a transport he puts back afterwards is his
  schedules.update(after['Eval: bfcl'].id, { steps: [{ step: 'eval_start', sets: ['bfcl'], transport: 'ag-ui' }] });
  assert.deepEqual(ex.dropStaleTransports({ schedules, vaultDir: vault.dir, sets }).changed, []);
  assert.equal(schedules.all().find((x) => x.name === 'Eval: bfcl').steps[0].transport, 'ag-ui');
  assert.deepEqual(JSON.parse(fs.readFileSync(ex.migrationsFile(vault.dir), 'utf8')).done, [ex.STALE_TRANSPORT]);
});

test('with no Steward folder (no runners known) nothing is touched and the fix waits; the seeded examples carry no transport', () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-')));
  const schedules = new Schedules(() => vault);
  schedules.add({ name: 'Eval: bfcl', when: '', steps: [{ step: 'eval_start', sets: ['bfcl'], transport: 'ag-ui' }] });
  assert.deepEqual(ex.dropStaleTransports({ schedules, vaultDir: vault.dir, sets: [] }).changed, []);
  assert.equal(schedules.all()[0].steps[0].transport, 'ag-ui');
  assert.equal(fs.existsSync(ex.migrationsFile(vault.dir)), false, 'tried again on the next read');
  for (const e of ex.examples(estate.evalSets(stewardWith(SETS)))) {
    for (const s of e.steps) assert.ok(typeof s === 'string' || !('transport' in s), `${e.name} seeds no transport`);
  }
});
