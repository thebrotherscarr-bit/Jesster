const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { queue, readPolicy } = require('./approvals.cjs');
const { AgentService } = require('./agent/service.cjs');

/** An agent service with no vault or model: only its cards are used here. */
function agentWith(emitted = []) {
  return new AgentService({ getVault: () => ({ load: () => [] }), getModel: () => ({}), emit: (channel, payload) => emitted.push({ channel, payload }) });
}

/** The door's hold_list answer, as door.call gives it. */
const holdList = (held) => async () => ({ text: JSON.stringify({ armed: true, held }), isError: false });

test("one queue holds the Agent tab's cards and the door's holds, newest first", async () => {
  const svc = agentWith();
  const ask = svc.approveInWindow('session-1');
  ask('terminal_run', { command: 'dir' }, 'dir');
  const card = svc.cards()[0];
  const hold = { id: 'h-1', tool: 'git_push', caller: 'steward', project: 'research', when: '2000-01-01T00:00:00Z', args: { branch: 'main' } };
  const late = { ...hold, id: 'h-2', when: '2999-01-01T00:00:00Z' };
  const q = await queue({ cards: () => svc.cards(), holds: holdList([hold, late]) });
  assert.deepEqual(
    q.items.map((i) => [i.plane, i.id]),
    [
      ['door', 'h-2'],
      ['agent', card.id],
      ['door', 'h-1'],
    ]
  );
  const agentItem = q.items.find((i) => i.plane === 'agent');
  assert.equal(agentItem.tool, 'terminal_run');
  assert.equal(agentItem.sessionId, 'session-1');
  assert.equal(agentItem.summary, 'dir');
  assert.deepEqual(agentItem.args, { command: 'dir' });
  const doorItem = q.items.find((i) => i.id === 'h-1');
  assert.equal(doorItem.project, 'research');
  assert.equal(doorItem.caller, 'steward');
  assert.equal(q.doorError, undefined);
});

test("a door that cannot be read leaves the Agent tab's cards standing and says why", async () => {
  const svc = agentWith();
  svc.reviewInWindow('session-2')({ attempt: 1, passed: true, changed: ['a.py'] });
  const q = await queue({ cards: () => svc.cards(), holds: async () => ({ text: 'The Atlas ground was not found.', isError: true }) });
  assert.deepEqual(
    q.items.map((i) => [i.plane, i.tool, i.kind]),
    [['agent', 'review', 'review']]
  );
  assert.match(q.doorError, /The Atlas ground was not found/);
});

test('Always allow keeps that exact call, answers it without a card, and Reset forgets it', async () => {
  const emitted = [];
  const svc = agentWith(emitted);
  const ask = svc.approveInWindow('s');
  const cards = () => emitted.filter((e) => e.channel === 'agent:approval').map((e) => e.payload);

  const first = ask('terminal_run', { command: 'dir' }, 'dir');
  assert.equal(svc.answerApproval(cards()[0].id, true, true), true);
  assert.equal(await first, true);
  assert.ok(emitted.some((e) => e.channel === 'agent:approval-done' && e.payload.id === cards()[0].id), 'the answered card leaves every view');
  assert.deepEqual(
    svc.always().map((a) => [a.key, a.name, a.summary]),
    [['terminal_run:dir', 'terminal_run', 'dir']]
  );

  // the same call again: allowed, and no card is raised
  assert.equal(await ask('terminal_run', { command: 'dir' }, 'dir'), true);
  assert.equal(cards().length, 1);
  // other arguments still ask
  ask('terminal_run', { command: 'del x' }, 'del x');
  assert.equal(cards().length, 2);
  svc.answerApproval(cards()[1].id, false);

  // Reset one, by its key: the call asks again
  assert.deepEqual(svc.resetAlways('terminal_run:dir'), []);
  ask('terminal_run', { command: 'dir' }, 'dir');
  assert.equal(cards().length, 3);
});

test('Reset with no key forgets every entry; a review and a plain Allow store nothing', async () => {
  const svc = agentWith();
  const ask = svc.approveInWindow('s');
  for (const cmd of ['a', 'b']) {
    ask('terminal_run', { command: cmd }, cmd);
    svc.answerApproval(svc.cards()[0].id, true, true);
  }
  assert.equal(svc.always().length, 2);
  ask('terminal_run', { command: 'c' }, 'c');
  svc.answerApproval(svc.cards()[0].id, true, false);
  svc.reviewInWindow('s')({ attempt: 1 });
  svc.answerApproval(svc.cards()[0].id, true, true);
  assert.equal(svc.always().length, 2);
  assert.deepEqual(svc.resetAlways(), []);
  assert.deepEqual(svc.always(), []);
});

test("Steward's tool policy: absent, malformed, and present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  assert.deepEqual(readPolicy(null), { state: 'absent', file: null });
  const file = path.join(dir, 'storage', 'tool-policy.json');
  assert.deepEqual(readPolicy(dir), { state: 'absent', file });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.equal(readPolicy(dir).state, 'malformed');
  assert.match(readPolicy(dir).error, /not JSON/);
  fs.writeFileSync(file, JSON.stringify({ ts: 'x' }));
  assert.match(readPolicy(dir).error, /no "tools" list/);
  fs.writeFileSync(file, JSON.stringify({ tools: [{ name: 'git_push', approval: 'sometimes' }] }));
  assert.match(readPolicy(dir).error, /git_push: approval is "sometimes"/);
  fs.writeFileSync(file, JSON.stringify({ tools: [{ approval: 'never' }] }));
  assert.match(readPolicy(dir).error, /tool 1 has no name/);

  fs.writeFileSync(
    file,
    JSON.stringify({
      ts: '2026-11-04T10:00:00Z',
      tools: [
        { name: 'read_note', source: 'secondbrain', approval: 'never' },
        { name: 'git_push', source: 'door', approval: 'always', notes: 'his word each time' },
        { name: 'shell_run', source: 'door', approval: 'rule' },
      ],
    })
  );
  assert.deepEqual(readPolicy(dir), {
    state: 'ok',
    file,
    ts: '2026-11-04T10:00:00Z',
    tools: [
      { name: 'read_note', source: 'secondbrain', approval: 'never' },
      { name: 'git_push', source: 'door', approval: 'always', notes: 'his word each time' },
      { name: 'shell_run', source: 'door', approval: 'rule' },
    ],
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every answered card is kept in the history, newest first, capped to its newest lines', async () => {
  const { history, HISTORY_FILE } = require('./approvals.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-history-'));
  const h = history(path.join(dir, HISTORY_FILE), { cap: 5 });
  const svc = new AgentService({ getVault: () => ({ load: () => [] }), getModel: () => ({}), history: h });
  const told = [];
  svc.onAnswered((e) => told.push(e));
  const ask = svc.approveInWindow('s1');
  const a = ask('terminal_run', { command: 'dir' }, 'dir');
  const b = ask('write_note', { title: 'x' }, 'write x');
  const c = ask('git_push', {}, 'push');
  const [ida, idb, idc] = svc.cards().map((x) => x.id);
  svc.answerApproval(ida, true, false);
  svc.answerApproval(idb, true, true);
  svc.answerApproval(idc, false, false, undefined, { where: 'telegram' });
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, false]);
  const kept = h.read(10);
  assert.deepEqual(kept.map((e) => [e.id, e.tool, e.summary, e.answer, e.where]), [
    [idc, 'git_push', 'push', 'deny', 'telegram'],
    [idb, 'write_note', 'write x', 'always', 'window'],
    [ida, 'terminal_run', 'dir', 'allow', 'window'],
  ]);
  assert.ok(kept.every((e) => !Number.isNaN(Date.parse(e.time))));
  assert.deepEqual(told.map((e) => e.id), [ida, idb, idc], 'and told to the listeners (Telegram)');
  // a review's answer too
  const review = svc.reviewInWindow('s1')({ attempt: 1, passed: true });
  const idr = svc.cards()[0].id;
  svc.answerApproval(idr, false, false);
  assert.equal(await review, 'drop');
  assert.equal(h.read(1)[0].answer, 'drop');
  // capped: the newest 5 lines stay
  for (let i = 0; i < 4; i++) h.append({ id: `x${i}`, tool: 't', summary: '', answer: 'allow', where: 'window', time: new Date().toISOString() });
  const lines = fs.readFileSync(h.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  assert.deepEqual(h.read(200).map((e) => e.id), ['x3', 'x2', 'x1', 'x0', idr]);
  assert.equal(h.read(2).length, 2);
  assert.equal(h.read(100000).length, 5, 'read is held to 200 and to what is there');
  fs.rmSync(dir, { recursive: true, force: true });
});
