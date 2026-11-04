const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Telegram } = require('./telegram.cjs');
const { AgentService } = require('./service.cjs');
const subagents = require('./subagents.cjs');
const { Vault } = require('../vaultfs.cjs');

/** A fake Telegram Bot API: queue updates, record what the bot sends. */
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
      if (!req.url.startsWith('/botTOKEN/')) return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
      if (method === 'getMe') return ok({ username: 'sb_test_bot' });
      if (method === 'getUpdates') {
        const take = () => ok(queue.splice(0).filter((u) => u.update_id >= (body.offset || 0)));
        if (queue.length) return take();
        waiters.push(take);
        return setTimeout(() => { waiters = waiters.filter((w) => w !== take); ok([]); }, 300);
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

const until = async (fn, ms = 5000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 30))) if (fn()) return true;
  throw new Error('timed out waiting');
};

test('pairing, conversation, approvals over buttons, /new and broadcasts', async () => {
  const tg = await fakeTelegram();
  const config = { token: 'TOKEN', enabled: true, allowedChats: [] };
  const asks = [];
  const agent = {
    getModel: () => ({ model: 'gpt-oss:20b' }),
    registry: { schemas: () => [1, 2] },
    stop: () => {},
    ask: async ({ text, sessionId, source, approve }) => {
      asks.push({ text, sessionId, source });
      if (text === 'run something risky') {
        const ok = await approve('terminal_run', {}, 'dir C:\\');
        return { sessionId: sessionId || 's1', answer: ok ? 'ran it' : 'not allowed' };
      }
      return { sessionId: sessionId || 's1', answer: `you said ${text}` };
    },
  };
  const states = [];
  const bot = new Telegram({ getConfig: () => config, agent, apiBase: tg.base, onState: (s) => states.push(s) });
  await bot.start();
  try {
    assert.equal(bot.state().bot, '@sb_test_bot');
    // a stranger gets nothing but pairing instructions
    tg.push({ message: { chat: { id: 42, first_name: 'Kyle' }, text: 'hello' } });
    await until(() => tg.sent.some((s) => /isn't paired/.test(s.text || '')));
    assert.equal(asks.length, 0);
    assert.deepEqual(bot.state().pending.map((p) => [p.id, p.name]), [['42', 'Kyle']]);
    // the user approves the chat in the app
    config.allowedChats = ['42'];
    bot.approvePairing(42);
    tg.push({ message: { chat: { id: 42 }, text: 'what is on my todo?' } });
    await until(() => tg.sent.some((s) => s.text === 'you said what is on my todo?'));
    assert.equal(asks[0].source, 'telegram');
    // follow-ups continue the same session; /new starts a fresh one
    tg.push({ message: { chat: { id: 42 }, text: 'and tomorrow?' } });
    await until(() => asks.length === 2);
    assert.ok(asks[0].sessionId, 'the chat names its session before the turn');
    assert.equal(asks[1].sessionId, asks[0].sessionId);
    tg.push({ message: { chat: { id: 42 }, text: '/new' } });
    await until(() => tg.sent.some((s) => /New conversation/.test(s.text || '')));
    // risky tools ask with buttons
    tg.push({ message: { chat: { id: 42 }, text: 'run something risky' } });
    await until(() => tg.sent.some((s) => s.reply_markup));
    assert.notEqual(asks.at(-1).sessionId, asks[0].sessionId, 'after /new it is a fresh session');
    const prompt = tg.sent.find((s) => s.reply_markup);
    assert.match(prompt.text, /wants to use terminal_run/);
    const yes = prompt.reply_markup.inline_keyboard[0][0].callback_data;
    tg.push({ callback_query: { id: 'cb1', data: yes, message: { chat: { id: 42 } } } });
    await until(() => tg.sent.some((s) => s.text === 'ran it'));
    // a button press from a stranger does nothing
    tg.push({ callback_query: { id: 'cb2', data: yes, message: { chat: { id: 99 } } } });
    // automations can broadcast
    await bot.broadcast('Morning digest\n\nall clear');
    assert.ok(tg.sent.some((s) => s.chat_id === '42' && /all clear/.test(s.text)));
    // long answers are split under Telegram's limit
    await bot.send(42, 'x'.repeat(9000));
    assert.ok(tg.sent.filter((s) => s.method === 'sendMessage').every((s) => s.text.length <= 4000));
  } finally {
    bot.stop();
    tg.server.close();
  }
});

test("with Steward as the agent, a paired chat is a Steward conversation: his cards are buttons, a reply answers a card, /new, /stop and /status", async () => {
  const tg = await fakeTelegram();
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-steward-')));
  // the local loop's Ollama, for the backend that is not Steward
  const ollama = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end(JSON.stringify({ message: { role: 'assistant', content: 'local answer' } })));
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  const model = { backend: 'steward', model: 'gpt-oss:20b', host: `http://127.0.0.1:${ollama.address().port}` };
  const turns = [];
  const decided = [];
  const steward = {
    ensure: async () => 'http://steward',
    up: async () => true,
    turn: async ({ text, previous, approve, review, signal }) => {
      text = text.startsWith('[') ? text.slice(text.indexOf(']') + 2) : text; // the source line withSource adds
      turns.push({ text, previous });
      let answer = `steward: ${text}`;
      if (text === 'fix the test' || text === 'hang') {
        const ok = await approve('approve_plan', { plan: '1. fix' }, 'approve_plan {"plan": "1. fix"}');
        decided.push(ok);
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        answer = ok ? 'fixed' : 'plan declined';
      }
      if (text.startsWith('improve:')) answer = `review said: ${await review({ attempt: 1, passed: true, changed: ['a.py'] })}`;
      if (text === 'long') answer = 'y'.repeat(9000);
      return { answer, previous: `r${turns.length}`, calls: [] };
    },
  };
  const windowCards = [];
  const users = [];
  const service = new AgentService({
    getVault: () => vault,
    getModel: () => model,
    steward,
    emit: (channel, e) => {
      if (channel === 'agent:approval') windowCards.push(e);
      if (channel === 'agent:event' && e.type === 'user') users.push(e);
    },
  });
  const config = { token: 'TOKEN', enabled: true, allowedChats: ['42'] };
  const bot = new Telegram({ getConfig: () => config, agent: service, apiBase: tg.base });
  await bot.start();
  const texts = () => tg.sent.filter((s) => s.method === 'sendMessage').map((s) => s.text);
  const buttonsFor = (re) => tg.sent.filter((s) => s.reply_markup && re.test(s.text)).at(-1).reply_markup.inline_keyboard[0];
  const say = (text, chat = 42) => tg.push({ message: { chat: { id: chat }, text } });
  try {
    // an unpaired chat gets nothing from Steward
    say('hello', 7);
    await until(() => texts().some((t) => /isn't paired/.test(t)));
    assert.equal(turns.length, 0);
    // a paired chat's message reaches Steward, as source telegram, and follow-ups continue his thread
    say('hi');
    await until(() => texts().includes('steward: hi'));
    assert.deepEqual(users.map((u) => u.source), ['telegram']);
    say('again');
    await until(() => texts().includes('steward: again'));
    assert.equal(turns[1].previous, 'r1', 'the chat keeps its Steward conversation');
    // his plan card becomes the chat's buttons (and is the window's card too); the button answers it
    say('fix the test');
    await until(() => tg.sent.some((s) => s.reply_markup && /Steward wants to use approve_plan/.test(s.text)));
    assert.equal(windowCards.length, 1);
    tg.push({ callback_query: { id: 'cb1', data: buttonsFor(/approve_plan/)[0].callback_data, message: { chat: { id: 42 } } } });
    await until(() => texts().includes('fixed'));
    assert.deepEqual(decided, [true]);
    assert.ok(tg.sent.some((s) => s.method === 'answerCallbackQuery' && s.text === 'Allowed'));
    assert.equal(service.cards().length, 0, 'the window card is gone');
    // a message typed while a card waits answers it No, then goes to Steward next
    say('fix the test');
    await until(() => windowCards.length === 2);
    say('no, only read it');
    await until(() => texts().includes('steward: no, only read it'));
    assert.deepEqual(decided, [true, false]);
    assert.ok(texts().includes('plan declined'));
    assert.ok(texts().some((t) => /answered No/.test(t)));
    // a message typed at a review card is its guidance
    say('improve: shorter steps');
    await until(() => windowCards.length === 3);
    assert.equal(windowCards[2].kind, 'review');
    say('keep the steps short');
    await until(() => texts().includes('review said: keep the steps short'));
    // /new starts a fresh Steward conversation
    say('/new');
    await until(() => texts().some((t) => /New conversation/.test(t)));
    say('fresh');
    await until(() => texts().includes('steward: fresh'));
    assert.equal(turns.at(-1).previous, undefined);
    // /stop stops his run, and a card still waiting is answered No
    say('hang');
    await until(() => windowCards.length === 4);
    say('/stop');
    await until(() => texts().filter((t) => t === 'Stopped.').length === 2);
    assert.equal(decided.at(-1), false);
    // /status says whether his service is up
    say('/status');
    await until(() => texts().some((t) => /Steward is the agent; his service is up/.test(t)));
    // a long answer is split under Telegram's limit
    say('long');
    await until(() => texts().filter((t) => /^y+$/.test(t)).length === 3);
    assert.ok(texts().every((t) => t.length <= 4000));
    // another backend: the local loop answers, Steward is not asked
    const before = turns.length;
    model.backend = 'ollama';
    say('local please');
    await until(() => texts().includes('local answer'));
    assert.equal(turns.length, before);
  } finally {
    bot.stop();
    tg.server.close();
    ollama.close();
  }
});

test("a Steward card answered in the window loses its buttons in the chat and shows the answer; one nobody answers is No after the timeout; both are kept in the history", async () => {
  const approvals = require('../approvals.cjs');
  const tg = await fakeTelegram();
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cards-')));
  const history = approvals.history(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-history-')), approvals.HISTORY_FILE));
  const decided = [];
  const steward = {
    ensure: async () => 'http://steward',
    turn: async ({ text, approve }) => {
      text = text.startsWith('[') ? text.slice(text.indexOf(']') + 2) : text; // the source line withSource adds
      const ok = await approve('service_control', { service: 'ollama', action: 'restart' }, `service_control ${text}`);
      decided.push(ok);
      return { answer: ok ? 'done' : 'not done', previous: 'r', calls: [] };
    },
  };
  const service = new AgentService({ getVault: () => vault, getModel: () => ({ backend: 'steward' }), steward, history });
  const bot = new Telegram({ getConfig: () => ({ token: 'TOKEN', enabled: true, allowedChats: ['42'] }), agent: service, apiBase: tg.base, cardTimeout: 1500 });
  await bot.start();
  const edits = () => tg.sent.filter((s) => s.method === 'editMessageText');
  try {
    tg.push({ message: { chat: { id: 42 }, text: 'first' } });
    await until(() => service.cards().length === 1 && bot.cards.get(service.cards()[0].id)?.messageId);
    const card = tg.sent.find((s) => s.reply_markup && /service_control first/.test(s.text));
    // answered in the window (agent:approve), before Telegram's timeout
    service.answerApproval(service.cards()[0].id, true, false);
    await until(() => edits().length === 1);
    const edit = edits()[0];
    assert.equal(edit.chat_id, '42');
    assert.equal(edit.message_id, tg.sent.indexOf(card) + 1, 'the card message itself');
    assert.match(edit.text, /service_control first\n\n— Allowed in Jesster$/);
    assert.deepEqual(edit.reply_markup, { inline_keyboard: [] }, 'its buttons are gone');
    assert.equal(bot.cards.size, 0, 'the card is forgotten here');
    await until(() => decided.length === 1);
    assert.deepEqual(decided, [true]);
    // nobody answers: after the timeout it is No, as the local loop's cards are
    tg.push({ message: { chat: { id: 42 }, text: 'second' } });
    await until(() => decided.length === 2, 5000);
    assert.equal(decided[1], false);
    await until(() => edits().length === 2);
    assert.match(edits()[1].text, /— No answer in 10 minutes: denied$/);
    assert.equal(service.cards().length, 0);
    const kept = history.read(10);
    assert.deepEqual(kept.map((h) => [h.tool, h.answer, h.where]), [['service_control', 'timeout', 'telegram'], ['service_control', 'allow', 'window']]);
    assert.match(kept[1].summary, /service_control first/);
    assert.ok(kept.every((h) => h.id && !Number.isNaN(Date.parse(h.time))));
  } finally {
    bot.stop();
    tg.server.close();
  }
});

test("the phone's exchange is kept for the Phone view (text, reply, card and its answer), and a chat keeps its Steward conversation across a restart", async () => {
  const phone = require('./phone.cjs');
  const tg = await fakeTelegram();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-phone-'));
  const vault = new Vault(dir);
  const log = phone.log(path.join(dir, 'phone-log.jsonl'));
  const sessionsFile = path.join(dir, 'phone-sessions.json');
  const seen = [];
  const steward = {
    ensure: async () => 'http://steward',
    turn: async ({ text, approve, previous }) => {
      seen.push({ text, previous });
      const ok = await approve('write_note', {}, 'write_note x');
      return { answer: ok ? 'written' : 'not written', previous: 'r1', calls: [] };
    },
  };
  const config = { token: 'TOKEN', enabled: true, allowedChats: ['42'] };
  const service = new AgentService({ getVault: () => vault, getModel: () => ({ backend: 'steward' }), steward });
  let bot = new Telegram({ getConfig: () => config, agent: service, apiBase: tg.base, phone: log, sessions: phone.chatSessions(sessionsFile, 'telegram') });
  await bot.start();
  try {
    tg.push({ message: { chat: { id: 42, first_name: 'Kyle' }, text: 'note this' } });
    await until(() => service.cards().length === 1);
    service.answerApproval(service.cards()[0].id, true, false); // answered in the window, as the Phone view does
    await until(() => log.read('telegram', '42').some((e) => e.kind === 'reply'));
    assert.deepEqual(log.read('telegram', '42').map((e) => e.kind).reverse(), ['user', 'card', 'answer', 'reply']);
    assert.equal(log.list()[0].label, 'Telegram · Kyle');
    assert.match(seen[0].text, /^\[from the phone \(Telegram\)\]\nnote this$/);
    const sid = phone.chatSessions(sessionsFile, 'telegram').get('42');
    assert.ok(sid, 'the chat map is on disk');
    // a restart: a new bot over the same file continues the same session
    bot.stop();
    await bot.polling; // the old poll ends, so the next update can only reach the new bot
    bot = new Telegram({ getConfig: () => config, agent: service, apiBase: tg.base, phone: log, sessions: phone.chatSessions(sessionsFile, 'telegram') });
    await bot.start();
    tg.push({ message: { chat: { id: 42, first_name: 'Kyle' }, text: 'and again' } });
    await until(() => service.cards().length === 1);
    service.answerApproval(service.cards()[0].id, false, false);
    await until(() => log.read('telegram', '42')[0]?.kind === 'reply' && log.read('telegram', '42')[0].text === 'not written');
    assert.equal(seen[1].previous, 'r1', "Steward's thread continues");
    assert.ok(log.read('telegram', '42').every((e) => e.sessionId === sid));
  } finally {
    bot.stop();
    tg.server.close();
  }
});

test('a wrong token is reported, not crashed on', async () => {
  const tg = await fakeTelegram();
  const bot = new Telegram({ getConfig: () => ({ token: 'BAD', enabled: true, allowedChats: [] }), agent: {}, apiBase: tg.base });
  const s = await bot.start();
  tg.server.close();
  assert.equal(s.running, false);
  assert.match(s.error, /Unauthorized/);
});

test('subagents: delegate runs independent jobs and returns their results', async () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'sub-')));
  const seenTools = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = JSON.parse(b);
      const first = body.messages.find((m) => m.role === 'user').content;
      const last = body.messages.at(-1);
      seenTools.push(body.tools.map((t) => t.function.name));
      const reply = (m) => res.end(JSON.stringify({ message: { role: 'assistant', ...m } }));
      if (first === 'research two things' && last.role === 'user') {
        return reply({ content: '', tool_calls: [{ function: { name: 'delegate', arguments: { tasks: ['find A', 'find B'], tools: ['current_time', 'delegate'] } } }] });
      }
      if (first === 'research two things') return reply({ content: `combined:\n${last.content}` });
      return reply({ content: `result for ${first}` });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const svc = new AgentService({ getVault: () => vault, getModel: () => ({ host: `http://127.0.0.1:${server.address().port}`, model: 'm' }) });
  svc.registry.add(subagents.tools(() => svc));
  const r = await svc.ask({ text: 'research two things', approve: async () => true });
  server.close();
  assert.match(r.answer, /Subagent 1: find A\nresult for find A/);
  assert.match(r.answer, /Subagent 2: find B\nresult for find B/);
  assert.ok(seenTools.some((t) => t.length === 1 && t[0] === 'current_time'), 'subagents get only the tools asked for, never delegate');
  assert.equal(vault.load().filter((n) => n.tags.includes('subagent')).length, 2, 'subagent sessions are kept');
});
