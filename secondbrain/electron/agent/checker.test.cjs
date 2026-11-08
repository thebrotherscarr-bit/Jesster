const test = require('node:test');
const assert = require('node:assert/strict');
const checker = require('./checker.cjs');
const { AgentService } = require('./service.cjs');

test("Claude's check gets the Charter, every tool call with its result, and the answer", async () => {
  let sent = null;
  const chat = async (req) => ((sent = req), 'Holds up.\nNext: run the tests.');
  const turn = {
    text: 'What branch am I on?',
    calls: [{ name: 'get_repo_status', arguments: {}, result: '{"branch": "redo-maf"}' }],
    answer: 'You are on redo-maf.',
  };
  const out = await checker.check({ chat, config: { key: 'k', model: 'claude-x' }, charter: 'Kyle holds the gate.', turn });
  assert.equal(out, 'Holds up.\nNext: run the tests.');
  assert.equal(sent.provider, 'anthropic');
  assert.equal(sent.model, 'claude-x');
  assert.equal(sent.system, checker.SYSTEM);
  const content = sent.messages[0].content;
  for (const part of ['Kyle holds the gate.', 'What branch am I on?', 'get_repo_status', '"branch": "redo-maf"', 'You are on redo-maf.']) {
    assert.ok(content.includes(part), `the check sees ${part}`);
  }
});

test("the check names the system's owner from Settings' owner, today's name by default (ADR-0020)", async () => {
  const fs = require('fs');
  const path = require('path');
  const { DEFAULTS } = require('../settings.cjs');
  assert.equal(DEFAULTS.owner, checker.OWNER);
  assert.equal(checker.SYSTEM, checker.system(DEFAULTS.owner), 'unchanged on this PC');
  let sent = null;
  const chat = async (req) => ((sent = req), 'Holds up.');
  await checker.check({ chat, config: { key: 'k', model: 'm' }, turn: { text: 'q', calls: [], answer: 'a' }, owner: 'Sam' });
  assert.match(sent.system, /for Sam, who owns the system/);
  assert.match(sent.system, /Did he do what Sam asked\?/);
  assert.match(sent.messages[0].content, /^## Sam's message/);
  assert.ok(!/Kyle/.test(sent.system + sent.messages[0].content), 'no other name is left in what the model reads');
  // main.cjs hands Settings' owner to the check
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /owner: getSettings\(\)\.get\('owner'\),/);
});

test('a long tool result is clipped, and a missing one says so', () => {
  const t = checker.transcript({ text: 'q', calls: [{ name: 'read', arguments: {}, result: 'x'.repeat(5000) }, { name: 'ls', arguments: {} }], answer: 'a' });
  assert.match(t, /more characters\)/);
  assert.match(t, /\(no result recorded\)/);
});

test('the Agent tab shows the check under the answer, and a failed check never fails the turn', async () => {
  const events = [];
  const s = { messages: [], abort: new AbortController() };
  const ok = new AgentService({ getVault: () => null, getModel: () => ({}), checker: async () => 'Problems:\n- no tool showed that.' });
  await ok.checkTurn(s, { text: 'q', calls: [], answer: 'a' }, (e) => events.push(e));
  assert.deepEqual(events, [{ type: 'check', text: 'Problems:\n- no tool showed that.' }]);
  assert.match(s.messages[0].content, /^\*\*Claude's check\*\*/);

  const off = new AgentService({ getVault: () => null, getModel: () => ({}), checker: async () => null });
  await off.checkTurn(s, { text: 'q', calls: [], answer: 'a' }, (e) => events.push(e));
  assert.equal(events.length, 1, 'switched off: nothing shown');

  const broken = new AgentService({ getVault: () => null, getModel: () => ({}), checker: async () => { throw new Error('add a Claude API key in Integrations first'); } });
  await broken.checkTurn(s, { text: 'q', calls: [], answer: 'a' }, (e) => events.push(e));
  assert.match(events[1].text, /could not run: add a Claude API key/);
});
