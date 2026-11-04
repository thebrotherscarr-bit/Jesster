const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const phone = require('./phone.cjs');
const { AgentService } = require('./service.cjs');

// The Phone view (the operator, 2026-11-04: "this is the pc" and "this is the phone"): the phone's exchanges are kept,
// capped, read newest first; each chat keeps its Steward conversation across a restart; and Steward is told where
// each turn came from.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-phone-'));

test('the phone log keeps the newest lines only and reads a conversation newest first', () => {
  const dir = tmp();
  const told = [];
  const log = phone.log(path.join(dir, 'phone-log.jsonl'), { cap: 5, onAppend: (e) => told.push(e) });
  for (let i = 1; i <= 7; i++) log.append({ channel: 'telegram', chatId: 42, title: 'Kyle', kind: i % 2 ? 'user' : 'reply', text: `line ${i}` });
  log.append({ channel: 'telegram', chatId: 7, title: 'Other', kind: 'user', text: 'elsewhere' });
  const lines = fs.readFileSync(log.file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 5, 'capped');
  assert.deepEqual(log.read('telegram', '42').map((e) => e.text), ['line 7', 'line 6', 'line 5', 'line 4']);
  assert.equal(told.length, 8, 'every line is told to the window');
  const list = log.list();
  assert.deepEqual(list.map((c) => c.label), ['Telegram · Other', 'Telegram · Kyle']);
  assert.throws(() => log.append({ channel: 'sms', chatId: 1, text: 'x' }), /not a phone channel/);
  assert.equal(phone.CAP, 5000);
});

test("a chat's Steward session survives a reload", () => {
  const file = path.join(tmp(), 'phone-sessions.json');
  phone.chatSessions(file, 'telegram').set('42', 's-abc');
  const again = phone.chatSessions(file, 'telegram');
  assert.equal(again.get('42'), 's-abc');
  assert.equal(phone.chatSessions(file, 'discord').get('42'), undefined, 'per channel');
  again.delete('42');
  assert.equal(phone.chatSessions(file, 'telegram').get('42'), undefined);
});

/** A service with Steward as its agent; his turns are recorded, not sent. */
function stewardService() {
  const notes = [];
  const sent = [];
  const svc = new AgentService({
    getVault: () => ({ load: () => notes, save: (n) => notes.splice(0, notes.length, ...notes.filter((x) => x.id !== n.id), n) }),
    getModel: () => ({ backend: 'steward' }),
    steward: { ensure: async () => 'http://x', turn: async ({ text }) => (sent.push(text), { answer: 'ok', previous: 'r1', calls: [] }) },
  });
  return { svc, sent, notes };
}

test('a Telegram turn reaches Steward from the phone and an Agent-tab turn from the PC; the tab lists only its own', async () => {
  const { svc, sent } = stewardService();
  await svc.ask({ text: 'hi from the tab', sessionId: 'pc1', source: 'app' });
  await svc.ask({ text: 'hi from my phone', sessionId: 'ph1', source: 'telegram' });
  await svc.ask({ text: 'improve: the tests', sessionId: 'pc2', source: 'app' });
  assert.equal(sent[0], '[from the PC (Agent tab)]\nhi from the tab');
  assert.equal(sent[1], '[from the phone (Telegram)]\nhi from my phone');
  assert.match(sent[2], /^improve: the tests\n\n\[from the PC \(Agent tab\)\]$/, 'the improve word stays first');
  assert.deepEqual(svc.list().map((s) => s.id).sort(), ['pc1', 'pc2'], 'phone conversations are not on the Agent tab');
  assert.equal(svc.open('ph1').messages[0].content, 'hi from my phone', 'the session keeps the text as typed');
});
