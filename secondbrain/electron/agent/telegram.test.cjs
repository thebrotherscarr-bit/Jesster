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
    assert.equal(asks[1].sessionId, 's1');
    tg.push({ message: { chat: { id: 42 }, text: '/new' } });
    await until(() => tg.sent.some((s) => /New conversation/.test(s.text || '')));
    // risky tools ask with buttons
    tg.push({ message: { chat: { id: 42 }, text: 'run something risky' } });
    await until(() => tg.sent.some((s) => s.reply_markup));
    assert.equal(asks.at(-1).sessionId, undefined, 'after /new there is no session yet');
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
