/**
 * The away loop without a phone (Steward's ADR-0016 and ExecPlan 0005, M1; capabilities N1 to N4): a fake Telegram Bot
 * API carries the operator's message and his button press, the real Telegram bridge and AgentService carry the turn,
 * and the real AG-UI client (agui.cjs) talks to a fake AG-UI host speaking the events Steward's ag_ui_app.py streams.
 *
 *   Yes: the card's Allow continues the same run on the same thread from the card's checkpoint, the change runs, and
 *        the phone gets his answer and then the summary (what was asked, ran, changed, done).
 *   No: the resume carries approved false, nothing runs after the card, the summary says where it stopped and what is
 *        left.
 *   No answer: after the card wait the card is a No, and the summary says so.
 *   Failure: the run errors; the phone gets the error and a summary saying it failed.
 *
 * Red when unplugged: the service's run record (service.cjs ask), the summary (summary.cjs), Telegram's reply sending
 * it (telegram.cjs reply), or agui.cjs's resume.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Telegram } = require('./telegram.cjs');
const { AgentService } = require('./service.cjs');
const agui = require('./agui.cjs');
const { Vault } = require('../vaultfs.cjs');

/** A fake Telegram Bot API: queue updates, record what the bot sends. Nothing leaves this machine. */
function fakeTelegram() {
  const queue = [];
  const sent = [];
  let waiters = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      const method = req.url.split('/').pop();
      const ok = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') return ok({ username: 'sb_test_bot' });
      if (method === 'getUpdates') {
        const take = () => ok(queue.splice(0).filter((u) => u.update_id >= (body.offset || 0)));
        if (queue.length) return take();
        waiters.push(take);
        return setTimeout(() => {
          waiters = waiters.filter((w) => w !== take);
          ok([]);
        }, 300);
      }
      sent.push({ method, ...body });
      if (method === 'sendMessage') return ok({ message_id: sent.length, chat: { id: body.chat_id }, text: body.text });
      return ok(true);
    });
  });
  let id = 1;
  const push = (u) => {
    queue.push({ update_id: id++, ...u });
    const w = waiters.shift();
    if (w) w();
  };
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, sent, push, base: `http://127.0.0.1:${server.address().port}` })));
}

/** A fake AG-UI host: `script(body, n)` gives each run's events; every request body is kept in `seen`. */
function fakeHost(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const run = { threadId: body.threadId, runId: body.runId };
      for (const e of [{ type: 'RUN_STARTED', ...run }, ...script(body, seen.length)]) {
        res.write(`data: ${JSON.stringify(e.type === 'RUN_FINISHED' ? { ...run, ...e } : e)}\n\n`);
      }
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/` })));
}

const words = (id, text) => [{ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text }, { type: 'TEXT_MESSAGE_END', messageId: id }];
const toolCall = (id, name, args, result) => [
  { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name },
  { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(args) },
  { type: 'TOOL_CALL_END', toolCallId: id },
  { type: 'TOOL_CALL_RESULT', toolCallId: id, messageId: `r-${id}`, content: result },
];
/** A card as ag_ui_app.py raises it: the request_info call and an interrupt outcome naming its checkpoint. */
function card(fc, checkpoint) {
  const call = `rq-${fc.name}`;
  return [
    { type: 'TOOL_CALL_START', toolCallId: call, toolCallName: 'request_info' },
    { type: 'TOOL_CALL_ARGS', toolCallId: call, delta: JSON.stringify({ request_id: call }) },
    { type: 'TOOL_CALL_END', toolCallId: call },
    {
      type: 'RUN_FINISHED',
      outcome: { type: 'interrupt', interrupts: [{ id: call, reason: 'tool_call', toolCallId: call, metadata: { agent_framework: { function_call: { name: fc.name, arguments: JSON.stringify(fc.arguments) }, checkpoint_id: checkpoint } } }] },
    },
  ];
}

const ASK = "Add a line 'away test' to harness/steward/working/sample-project-2/NOTES.md";
const EDIT = { name: 'file_access_write', arguments: { path: 'harness/steward/working/sample-project-2/NOTES.md', content: 'away test' } };

/**
 * Steward's host for the away ask: run 1 reads the file and raises the write's card; the resume writes it when
 * approved, or ends saying so when not.
 */
function stewardHost() {
  return fakeHost((body, n) => {
    if (n === 1) return [...toolCall('t1', 'file_access_read', { path: EDIT.arguments.path }, '# notes'), ...card(EDIT, 'ck-away')];
    const yes = body.resume?.[0]?.payload?.approved === true;
    if (yes) return [...toolCall('t2', EDIT.name, EDIT.arguments, 'written'), ...words('a', "Added 'away test' to NOTES.md."), { type: 'RUN_FINISHED' }];
    return [...words('a', 'Stopped: the write was not approved, so nothing was changed.'), { type: 'RUN_FINISHED' }];
  });
}

/** The real bridge and service, Steward on the fake host over AG-UI, the chat paired. */
async function away(t, host, { cardTimeout } = {}) {
  const tg = await fakeTelegram();
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'away-')));
  const service = new AgentService({
    getVault: () => vault,
    getModel: () => ({ backend: 'steward' }),
    steward: { ensure: async () => assert.fail('the Responses service is not used'), agui: { ensure: async () => host.url, turn: agui.turn } },
  });
  const bot = new Telegram({ getConfig: () => ({ token: 'TOKEN', enabled: true, allowedChats: ['42'] }), agent: service, apiBase: tg.base, ...(cardTimeout ? { cardTimeout } : {}) });
  await bot.start();
  t.after(() => {
    bot.stop();
    tg.server.close();
    host.server.close();
  });
  const texts = () => tg.sent.filter((s) => s.method === 'sendMessage').map((s) => s.text);
  const summary = () => texts().find((x) => x.startsWith('Summary'));
  const until = async (fn, ms = 5000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 20))) if (fn()) return;
    throw new Error(`timed out; the phone saw: ${JSON.stringify(texts())}`);
  };
  const press = async (yes) => {
    await until(() => tg.sent.some((s) => s.reply_markup?.inline_keyboard?.length));
    const button = tg.sent.find((s) => s.reply_markup?.inline_keyboard?.length).reply_markup.inline_keyboard[0][yes ? 0 : 1];
    tg.push({ callback_query: { id: 'cb', data: button.callback_data, message: { chat: { id: 42 } } } });
  };
  tg.push({ message: { chat: { id: 42, first_name: 'Kyle' }, text: ASK } });
  return { tg, texts, summary, until, press, service };
}

test('away, Yes: the card on the phone continues the same run from its checkpoint, the write runs, and the summary follows', async (t) => {
  const host = await stewardHost();
  const { texts, summary, until, press } = await away(t, host);
  await until(() => texts().some((x) => /Steward wants to use file_access_write/.test(x)));
  await press(true);
  await until(() => summary());
  // the same run: one thread, the resume names the card's interrupt and checkpoint
  assert.equal(host.seen.length, 2);
  assert.equal(host.seen[1].threadId, host.seen[0].threadId);
  assert.deepEqual(host.seen[1].resume, [{ interruptId: 'rq-file_access_write', status: 'resolved', payload: { approved: true } }]);
  assert.equal(host.seen[1].forwardedProps.checkpointId, 'ck-away');
  assert.match(host.seen[0].messages.at(-1).content, /^\[from the phone \(Telegram\) \|/);
  // his answer, then one summary, in that order, nothing else after the card
  const said = texts();
  assert.equal(said.indexOf("Added 'away test' to NOTES.md."), said.length - 2);
  assert.equal(said.filter((x) => x.startsWith('Summary')).length, 1);
  assert.equal(
    summary(),
    [
      'Summary',
      `Asked: ${ASK}`,
      'Ran: file_access_read, file_access_write',
      'Changed: harness/steward/working/sample-project-2/NOTES.md',
      'Result: done (1 card approved).',
    ].join('\n'),
  );
});

test('away, No: the resume says not approved, nothing runs after the card, and the summary says what is done and left', async (t) => {
  const host = await stewardHost();
  const { texts, summary, until, press } = await away(t, host);
  await press(false);
  await until(() => summary());
  assert.deepEqual(host.seen[1].resume, [{ interruptId: 'rq-file_access_write', status: 'resolved', payload: { approved: false } }]);
  assert.equal(host.seen.length, 2, 'the run ended after the No');
  assert.ok(texts().includes('Stopped: the write was not approved, so nothing was changed.'));
  const s = summary();
  assert.match(s, /^Ran: file_access_read$/m);
  assert.doesNotMatch(s, /^Changed:/m);
  assert.match(s, /^Result: stopped at the file_access_write card: you answered No\.$/m);
  assert.match(s, /^Done: file_access_read\. Left: file_access_write and what the plan had after it; nothing after the card ran\.$/m);
});

test('away, no answer: after the card wait the card is a No, and the summary says it ended for lack of an answer', async (t) => {
  const host = await stewardHost();
  const { tg, summary, until } = await away(t, host, { cardTimeout: 600 });
  await until(() => summary());
  assert.equal(host.seen[1].resume[0].payload.approved, false);
  assert.equal(host.seen.length, 2, 'the run ended after the No');
  await until(() => tg.sent.some((s) => s.method === 'editMessageText' && /— No answer in .*: denied$/.test(s.text)));
  assert.match(summary(), /^Result: stopped at the file_access_write card: no answer in 1 second \(counted as No\)\.$/m);
  assert.match(summary(), /^Done: file_access_read\. Left: file_access_write and what the plan had after it/m);
});

test('away, failure: a run that errors reaches the phone with the error and a summary saying it failed', async (t) => {
  const host = await fakeHost(() => [...toolCall('t1', 'file_access_read', { path: 'NOTES.md' }, 'error: not found'), { type: 'RUN_ERROR', message: 'the model is not loaded' }]);
  const { texts, summary, until } = await away(t, host);
  await until(() => summary());
  assert.ok(texts().includes('Steward: the model is not loaded'), 'the error itself');
  assert.match(summary(), /^Ran: file_access_read$/m);
  assert.match(summary(), /^Result: failed: Steward: the model is not loaded$/m);
});

test('a plain chat answer with no tool, card or error gets no summary: the answer is the end of that run', async (t) => {
  const host = await fakeHost(() => [...words('a', 'Hello.'), { type: 'RUN_FINISHED' }]);
  const { texts, until } = await away(t, host);
  await until(() => texts().includes('Hello.'));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!texts().some((x) => x.startsWith('Summary')));
});

// The card wait is the operator's 30 minutes (2026-11-08), one value for Telegram, the service and the summary
// (cardwait.cjs): on fake timers, a card is still waiting a millisecond before, and is a No at 30 minutes, said so in
// the card's edited text and the summary. Red when any of them keeps its own wait.
test("the card wait is 30 minutes, one value: Telegram's card, its edited text and the summary all say so", async (t) => {
  const { CARD_WAIT_MS } = require('./cardwait.cjs');
  assert.equal(CARD_WAIT_MS, 30 * 60000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'away-wait-')));
  const decided = [];
  const steward = {
    ensure: async () => 'http://steward',
    turn: async ({ approve }) => {
      const ok = await approve('secondbrain_service_control', { service: 'door', action: 'restart' }, 'service_control door restart');
      decided.push(ok);
      return { answer: ok ? 'Restarted.' : 'Not restarted.', previous: 'r1', calls: [] };
    },
  };
  const service = new AgentService({ getVault: () => vault, getModel: () => ({ backend: 'steward', transport: 'responses', transportChosen: true }), steward });
  const bot = new Telegram({ getConfig: () => ({ token: 'TOKEN', enabled: true, allowedChats: ['42'] }), agent: service });
  const sent = [];
  const edits = [];
  bot.api = async (method, body) => {
    if (method === 'editMessageText') edits.push(body.text);
    return true;
  };
  bot.send = async (chat, text) => (sent.push(text), { message: { message_id: sent.length }, text });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const done = bot.handle({ message: { chat: { id: 42 }, text: 'Restart the door.' } });
  await settle();
  assert.equal(service.cards().length, 1);
  t.mock.timers.tick(CARD_WAIT_MS - 1);
  await settle();
  assert.equal(service.cards().length, 1, 'still waiting a millisecond before 30 minutes');
  t.mock.timers.tick(1);
  await done;
  assert.deepEqual(decided, [false]);
  assert.deepEqual(edits.map((e) => e.split('\n').at(-1)), ['— No answer in 30 minutes: denied']);
  assert.match(sent.at(-1), /^Result: stopped at the secondbrain_service_control card: no answer in 30 minutes \(counted as No\)\.$/m);
});
