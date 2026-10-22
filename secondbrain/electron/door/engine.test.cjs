const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Engines, renderRun, runHead, splitCommand, sittingOpen, suiteStamp, suiteTail, releaseMark } = require('./engine.cjs');
const { build } = require('./index.cjs');

// A stand-in for manjuel.py --headless: PROTOCOL 1 over its pipes, and nothing else.
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
say({ event: 'opened', sitting: 7, session: 'S1', git: 'main@abc clean', rack_ok: true, pipeline: 'default', seats: 'Steward Router' });
rl.on('line', (l) => {
  const c = JSON.parse(l);
  if (c.cmd === 'objective' && c.text === 'ask me') return say({ event: 'needs_answer', prompt: 'retry, skip or abort?' });
  if (c.cmd === 'objective') {
    say({ event: 'token', text: 'h' });
    say({ event: 'tool_result', action: 'git_status', failed: false });
    return say({ event: 'delivery', text: 'did: ' + c.text + (c.model ? ' on ' + c.model : ''), pipeline: 'default', elapsed: 1.5,
      steps: [{ seat: 'Steward', elapsed: 1.2 }], transcript: 'logs/x.md' });
  }
  if (c.cmd === 'answer') return say({ event: 'delivery', text: 'answered ' + c.text, pipeline: 'default', elapsed: 0.1 });
  if (c.cmd === 'close') process.exit(0);
});
`;

function world() {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'door-engine-'));
  fs.mkdirSync(path.join(g, 'sessions'));
  return g;
}
const fakeSpawn = () => spawn(process.execPath, ['-e', FAKE], { stdio: ['pipe', 'pipe', 'pipe'] });

test('an engine opens, runs a turn, answers a question, and closes with its toll', async () => {
  const g = world();
  const engines = new Engines();
  const e = await engines.openOne('research', g, 'python manjuel.py', fakeSpawn);
  assert.strictEqual(e.opened.sitting, 7);
  assert.strictEqual(engines.get(g), e);
  const run = await e.run('look', '', '', { model: 'gpt-oss:20b' });
  assert.match(renderRun('research', 'look', run), /did: look on gpt-oss:20b[\s\S]*tool git_status\s+ok[\s\S]*seat Steward/);
  assert.strictEqual(run.tokens, 1);
  const asked = await e.run('ask me', '', '', {});
  assert.ok(asked.waiting);
  assert.match(renderRun('research', 'ask me', asked), /WAITING[\s\S]*retry, skip or abort\?/);
  await assert.rejects(() => e.run('again', '', '', {}), /waiting on an answer/);
  const ans = await e.answer('skip');
  assert.strictEqual(ans.final.text, 'answered skip');
  assert.strictEqual(await engines.closeOne(g), true);
  assert.strictEqual(engines.get(g), null);
});

test('a world with an open sitting, or an unreadable ledger, is refused', async () => {
  const g = world();
  const led = path.join(g, 'sessions', 'sessions.jsonl');
  fs.writeFileSync(led, JSON.stringify({ n: 3, started: '2026-10-22T10:00:00', ended: '', pid: process.pid }) + '\n');
  assert.deepStrictEqual(sittingOpen(g), [3, '2026-10-22T10:00:00', true]);
  await assert.rejects(() => new Engines().openOne('research', g, 'python manjuel.py', fakeSpawn), /open sitting \(3/);
  fs.writeFileSync(led, '{not json\n');
  await assert.rejects(() => new Engines().openOne('research', g, 'python manjuel.py', fakeSpawn), /cannot read/);
  fs.writeFileSync(led, JSON.stringify({ n: 3, ended: '2026-10-22T11:00:00' }) + '\n');
  assert.deepStrictEqual(sittingOpen(g), [0, '', false]);
});

test('no command wired, and a world that is not a folder, are refused by name', async () => {
  await assert.rejects(() => new Engines().openOne('research', world(), '', fakeSpawn), /no engine wired/);
  await assert.rejects(() => new Engines().openOne('research', path.join(os.tmpdir(), 'no-such-world-x'), 'python m.py', fakeSpawn), /not a directory/);
});

test('the head of a turn: voice, voices, and a shape that is refused', () => {
  assert.deepStrictEqual(runHead({ voice: ' qwen3-coder:30b ' }), { model: 'qwen3-coder:30b', voices: null });
  assert.deepStrictEqual(runHead({ voices: '{"Steward":"gpt-oss:20b"}' }).voices, { Steward: 'gpt-oss:20b' });
  assert.throws(() => runHead({ voices: '{"Steward":""}' }), /names no model/);
  assert.throws(() => runHead({ voices: '[1]' }), /JSON object/);
});

test('the ported engine tools refuse as the Go door does', async () => {
  const { Registry } = require('./registry.cjs');
  const { Tenants } = require('./tenant.cjs');
  const { engineTools } = require('./engine.cjs');
  const g = world();
  const tenants = new Tenants();
  tenants.add('research', g);
  const reg = new Registry(tenants);
  reg.coreCmd = '';
  for (const t of engineTools) reg.add(t);
  assert.match(await reg.call('env_open', {}, { name: 'a client', service: false }), /^HELD: "env_open" writes/);
  await assert.rejects(() => reg.call('env_open', {}, { name: 'op', service: true }), /no engine wired/);
  await assert.rejects(() => reg.call('run_start', { objective: 'x' }, { name: 'op', service: true }), /env_open first/);
  await assert.rejects(() => reg.call('suite_run', { set: 'nope' }, { name: 'c', service: false }), /strokes, smoke and both/);
  await assert.rejects(() => reg.call('ask_steward', { question: 'q' }, { name: 'op', service: true }), /no engine wired for project/);
  // in the door itself they are forwarded for now, with the flows that need them
  const door = build([['research', g]], { defaultProject: 'research' });
  for (const n of ['env_open', 'run_start', 'suite_run', 'env_list']) assert.ok(door.get(n).forwarded, n);
});

test('the release step, the stamp and the tail', () => {
  assert.ok(releaseMark('v0.2.7') && !releaseMark('0.2.7') && !releaseMark('v1.2'));
  const g = world();
  fs.mkdirSync(path.join(g, 'tests'));
  fs.writeFileSync(path.join(g, 'tests', 'last_run.json'), JSON.stringify({ strokes: { passed: 10, total: 10, green: true }, smoke: { state: 'running' } }));
  assert.strictEqual(suiteStamp(g, 'strokes'), '10/10 green');
  assert.match(suiteStamp(g, 'smoke'), /DID NOT FINISH/);
  assert.strictEqual(suiteTail('[PASS] a\n[FAIL] b\nend line'), '[FAIL] b\nend line');
  assert.deepStrictEqual(splitCommand('python "C:/a b/manjuel.py" -x'), ['python', 'C:/a b/manjuel.py', '-x']);
});
