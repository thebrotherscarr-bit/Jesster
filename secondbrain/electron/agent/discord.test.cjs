const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Discord, INTENTS } = require('./discord.cjs');
const { AgentService } = require('./service.cjs');
const { Vault } = require('../vaultfs.cjs');

/** One unmasked server frame (text, or close with a code). */
function frame(payload, opcode = 1) {
  const body = Buffer.from(payload);
  const head = body.length < 126 ? Buffer.from([0x80 | opcode, body.length]) : body.length < 65536 ? Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255]) : null;
  if (head) return Buffer.concat([head, body]);
  const h = Buffer.alloc(10);
  h[0] = 0x80 | opcode;
  h[1] = 127;
  h.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([h, body]);
}

/**
 * A fake Discord: the REST API (what the bot sends is recorded) and the Gateway, a small WebSocket server that says
 * Hello, answers Identify with READY, acks heartbeats, and lets the test push DMs and button presses.
 */
function fakeDiscord({ heartbeat = 100 } = {}) {
  const sent = []; // REST calls the bot made
  const frames = []; // gateway payloads the bot sent
  const conns = [];
  let seq = 0;
  let nextId = 1;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      const ok = (result, status = 200) => {
        res.statusCode = status;
        res.end(result === null ? '' : JSON.stringify(result));
      };
      // an attachment's CDN link needs no token
      if (req.url === '/voice.ogg') return res.end('OGGDATA');
      if (req.headers.authorization !== 'Bot TOKEN') return ok({ message: '401: Unauthorized', code: 0 }, 401);
      const url = req.url;
      if (req.method === 'GET' && url === '/users/@me') return ok({ id: 'BOT', username: 'jesster_bot' });
      if (req.method === 'GET' && url === '/gateway/bot') return ok({ url: `ws://127.0.0.1:${server.address().port}` });
      if (req.method === 'POST' && url === '/users/@me/channels') {
        sent.push({ kind: 'open', recipient: body.recipient_id });
        return ok({ id: `dm-${body.recipient_id}` });
      }
      let m;
      if ((m = /^\/channels\/([^/]+)\/messages$/.exec(url)) && req.method === 'POST') {
        const id = String(nextId++);
        sent.push({ kind: 'send', id, channel: m[1], content: body.content, components: body.components });
        return ok({ id, channel_id: m[1], content: body.content });
      }
      if ((m = /^\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url)) && req.method === 'PATCH') {
        sent.push({ kind: 'edit', channel: m[1], id: m[2], content: body.content, components: body.components });
        return ok({ id: m[2] });
      }
      if ((m = /^\/channels\/([^/]+)\/typing$/.exec(url))) {
        sent.push({ kind: 'typing', channel: m[1] });
        return ok(null, 204);
      }
      if ((m = /^\/interactions\/([^/]+)\/([^/]+)\/callback$/.exec(url))) {
        sent.push({ kind: 'callback', id: m[1], type: body.type, content: body.data?.content, flags: body.data?.flags });
        return ok(null, 204);
      }
      return ok({ message: 'Not Found' }, 404);
    });
  });
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = {
      identified: null,
      send: (p) => socket.write(frame(JSON.stringify(p))),
      close: (code = 1000) => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(code);
        socket.write(frame(b, 8));
        socket.end();
      },
    };
    conns.push(conn);
    let buf = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15;
        let len = buf[1] & 127;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const mask = buf[1] & 128 ? buf.subarray(off, off + 4) : null;
        if (mask) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (op === 8) {
          socket.end();
          return;
        }
        if (op !== 1) continue;
        const p = JSON.parse(payload.toString('utf8'));
        frames.push(p);
        if (p.op === 1) conn.send({ op: 11 });
        if (p.op === 2) {
          if (p.d.token !== 'TOKEN') return conn.close(4004);
          conn.identified = p.d;
          conn.send({ op: 0, t: 'READY', s: ++seq, d: { v: 10, user: { id: 'BOT', username: 'jesster_bot', bot: true }, session_id: 's' } });
        }
      }
    });
    conn.send({ op: 10, d: { heartbeat_interval: heartbeat } });
  });
  const live = () => conns.filter((c) => c.identified).at(-1);
  const dispatch = (t, d) => live().send({ op: 0, t, s: ++seq, d });
  let msgId = 1000;
  const dm = (userId, content, extra = {}) =>
    dispatch('MESSAGE_CREATE', { id: String(msgId++), channel_id: `dm-${userId}`, author: { id: String(userId), username: `user${userId}`, global_name: extra.name }, content, ...extra.fields });
  let itId = 1;
  const press = (userId, customId, messageId = '1') =>
    dispatch('INTERACTION_CREATE', { id: `it${itId}`, token: `itok${itId++}`, type: 3, user: { id: String(userId) }, channel_id: `dm-${userId}`, data: { custom_id: customId, component_type: 2 }, message: { id: messageId } });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, sent, frames, conns, live, dm, press, dispatch, base: `http://127.0.0.1:${server.address().port}` })));
}

const until = async (fn, ms = 5000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 20))) if (fn()) return true;
  throw new Error('timed out waiting');
};

test('Discord: the gateway identifies with DMs only and heartbeats; pairing, conversation, buttons, /new, strangers and broadcasts', async () => {
  const dc = await fakeDiscord();
  const config = { token: 'TOKEN', enabled: true, allowedUsers: [] };
  const asks = [];
  const agent = {
    getModel: () => ({ model: 'gpt-oss:20b' }),
    registry: { schemas: () => [1, 2] },
    stop: () => {},
    ask: async ({ text, sessionId, source, approve }) => {
      asks.push({ text, sessionId, source });
      if (text === 'run something risky') {
        const ok = await approve('terminal_run', {}, 'dir C:\\');
        return { sessionId, answer: ok ? 'ran it' : 'not allowed' };
      }
      return { sessionId, answer: `you said ${text}` };
    },
  };
  const bot = new Discord({ getConfig: () => config, agent, apiBase: dc.base });
  const sends = () => dc.sent.filter((s) => s.kind === 'send');
  await bot.start();
  try {
    await until(() => bot.ready);
    assert.equal(bot.state().bot, 'jesster_bot');
    assert.equal(dc.live().identified.intents, INTENTS);
    assert.equal(INTENTS, 4096, 'DIRECT_MESSAGES only: no server channels, no privileged intent');
    // it heartbeats on the interval Hello gave
    await until(() => dc.frames.filter((f) => f.op === 1).length >= 2);
    // a stranger gets nothing but pairing instructions
    dc.dm(42, 'hello', { name: 'Kyle' });
    await until(() => sends().some((s) => /isn't paired/.test(s.content)));
    assert.equal(asks.length, 0);
    assert.deepEqual(bot.state().pending.map((p) => [p.id, p.name]), [['42', 'Kyle']]);
    // a message in a server channel, or from a bot, is never read
    dc.dm(42, 'in a server', { fields: { guild_id: 'G1' } });
    dc.dm('BOT', 'my own echo');
    // the user approves himself in the app
    config.allowedUsers = ['42'];
    bot.approvePairing(42);
    assert.deepEqual(bot.state().pending, []);
    dc.dm(42, 'what is on my todo?');
    await until(() => sends().some((s) => s.content === 'you said what is on my todo?'));
    assert.equal(asks.length, 1, 'the server message and the echo were ignored');
    assert.equal(asks[0].source, 'discord');
    assert.equal(sends().at(-1).channel, 'dm-42', 'the reply goes to his DM');
    assert.ok(dc.sent.some((s) => s.kind === 'typing'));
    // follow-ups continue the same session; /new starts a fresh one
    dc.dm(42, 'and tomorrow?');
    await until(() => asks.length === 2);
    assert.ok(asks[0].sessionId);
    assert.equal(asks[1].sessionId, asks[0].sessionId);
    dc.dm(42, '/new');
    await until(() => sends().some((s) => /New conversation/.test(s.content)));
    // risky tools ask with buttons
    dc.dm(42, 'run something risky');
    await until(() => sends().some((s) => s.components));
    assert.notEqual(asks.at(-1).sessionId, asks[0].sessionId, 'after /new it is a fresh session');
    const prompt = sends().find((s) => s.components);
    assert.match(prompt.content, /wants to use terminal_run/);
    const [allow, deny] = prompt.components[0].components;
    assert.deepEqual([allow.label, deny.label, allow.style, deny.style], ['Allow', 'Deny', 3, 4]);
    // a stranger's press does nothing
    dc.press(99, allow.custom_id);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!sends().some((s) => s.content === 'ran it'));
    assert.ok(!dc.sent.some((s) => s.kind === 'callback'));
    dc.press(42, allow.custom_id);
    await until(() => sends().some((s) => s.content === 'ran it'));
    const cb = dc.sent.find((s) => s.kind === 'callback');
    assert.deepEqual([cb.type, cb.content, cb.flags], [4, 'Allowed', 64], 'only he sees the answer');
    // the test message reaches every paired user
    await bot.broadcast('Jesster is connected to this chat.');
    assert.ok(sends().some((s) => s.channel === 'dm-42' && /connected/.test(s.content)));
    // long answers are split under Discord's limit
    await bot.send(42, 'x'.repeat(4500));
    assert.ok(sends().every((s) => s.content.length <= 2000));
    assert.equal(sends().filter((s) => /^x+$/.test(s.content)).length, 3);
  } finally {
    bot.stop();
    dc.server.close();
  }
});

test("Discord with Steward as the agent: the source line, his cards as buttons (and the window's), answered either place, /stop, /status, the Phone view's log", async () => {
  const phone = require('./phone.cjs');
  const approvals = require('../approvals.cjs');
  const dc = await fakeDiscord({ heartbeat: 41250 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-steward-'));
  const vault = new Vault(dir);
  const log = phone.log(path.join(dir, 'phone-log.jsonl'));
  const history = approvals.history(path.join(dir, approvals.HISTORY_FILE));
  const seen = [];
  const decided = [];
  const steward = {
    ensure: async () => 'http://steward',
    up: async () => true,
    turn: async ({ text, previous, approve, signal }) => {
      seen.push({ text, previous });
      const said = text.slice(text.indexOf(']') + 2);
      let answer = `steward: ${said}`;
      if (said.startsWith('do ') || said === 'hang') {
        const ok = await approve('write_note', {}, `write_note ${said}`);
        decided.push(ok);
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        answer = ok ? 'written' : 'not written';
      }
      return { answer, previous: `r${seen.length}`, calls: [] };
    },
  };
  const windowCards = [];
  const service = new AgentService({ getVault: () => vault, getModel: () => ({ backend: 'steward', model: 'm' }), steward, history, emit: (ch, e) => ch === 'agent:approval' && windowCards.push(e) });
  const config = { token: 'TOKEN', enabled: true, allowedUsers: ['42'] };
  const bot = new Discord({ getConfig: () => config, agent: service, apiBase: dc.base, phone: log, sessions: phone.chatSessions(path.join(dir, 'phone-sessions.json'), 'discord') });
  const sends = () => dc.sent.filter((s) => s.kind === 'send');
  const edits = () => dc.sent.filter((s) => s.kind === 'edit');
  await bot.start();
  try {
    await until(() => bot.ready);
    dc.dm(42, 'hi', { name: 'Kyle' });
    await until(() => sends().some((s) => s.content === 'steward: hi'));
    assert.match(seen[0].text, /^\[from the phone \(Discord\)\]\nhi$/);
    // his card: the window's card and the DM's buttons; the button answers it
    dc.dm(42, 'do one', { name: 'Kyle' });
    await until(() => sends().some((s) => s.components && /Steward wants to use write_note/.test(s.content)));
    assert.equal(windowCards.length, 1);
    const card = sends().find((s) => s.components);
    dc.press(42, card.components[0].components[0].custom_id, card.id);
    await until(() => sends().some((s) => s.content === 'written'));
    assert.equal(seen[1].previous, 'r1', 'the DM keeps his conversation');
    assert.equal(service.cards().length, 0);
    await until(() => edits().length === 1);
    assert.deepEqual([edits()[0].channel, edits()[0].id, edits()[0].components], ['dm-42', card.id, []]);
    assert.match(edits()[0].content, /— Allowed$/);
    // answered in the window: the DM's buttons go, and it says where
    dc.dm(42, 'do two', { name: 'Kyle' });
    await until(() => service.cards().length === 1 && bot.cards.get(service.cards()[0].id)?.messageId);
    service.answerApproval(service.cards()[0].id, false, false);
    await until(() => edits().length === 2);
    assert.match(edits()[1].content, /write_note do two\n\n— Denied in Jesster$/);
    assert.deepEqual(decided, [true, false]);
    assert.deepEqual(history.read(10).map((h) => [h.answer, h.where]), [['deny', 'window'], ['allow', 'discord']]);
    // /stop stops his run and answers a waiting card No
    dc.dm(42, 'hang', { name: 'Kyle' });
    await until(() => windowCards.length === 3);
    dc.dm(42, '/stop', { name: 'Kyle' });
    await until(() => sends().some((s) => s.content === 'Stopped.'));
    await until(() => decided.length === 3);
    assert.equal(decided[2], false);
    // /status says whether his service is up
    dc.dm(42, '!status', { name: 'Kyle' });
    await until(() => sends().some((s) => /Steward is the agent; his service is up/.test(s.content)));
    // the Phone view's log: channel discord, his name, the exchange as it happened
    const lines = log.read('discord', '42').reverse();
    assert.deepEqual(lines.slice(0, 2).map((e) => [e.kind, e.text]), [['user', 'hi'], ['reply', 'steward: hi']]);
    assert.deepEqual(lines.slice(2, 6).map((e) => e.kind), ['user', 'card', 'answer', 'reply']);
    assert.equal(lines[4].where, 'discord');
    assert.equal(log.list()[0].label, 'Discord · Kyle');
    assert.ok(phone.chatSessions(path.join(dir, 'phone-sessions.json'), 'discord').get('42'), 'his conversation survives a restart');
  } finally {
    bot.stop();
    dc.server.close();
  }
});

test('Discord: a voice message is transcribed and sent on; without voice it says how to set it up', async () => {
  const dc = await fakeDiscord({ heartbeat: 41250 });
  const asks = [];
  const agent = { getModel: () => ({}), ask: async ({ text, sessionId }) => (asks.push(text), { sessionId, answer: `heard ${text}` }) };
  const heard = [];
  const bot = new Discord({ getConfig: () => ({ token: 'TOKEN', enabled: true, allowedUsers: ['42'] }), agent, apiBase: dc.base, transcribe: async (buf, mime) => (heard.push([buf.toString(), mime]), 'buy milk') });
  await bot.start();
  try {
    await until(() => bot.ready);
    dc.dm(42, '', { fields: { attachments: [{ url: `${dc.base}/voice.ogg`, content_type: 'audio/ogg' }] } });
    await until(() => dc.sent.some((s) => s.content === 'heard buy milk'));
    assert.deepEqual(heard, [['OGGDATA', 'audio/ogg']]);
    bot.transcribe = null;
    dc.dm(42, '', { fields: { attachments: [{ url: `${dc.base}/voice.ogg`, content_type: 'audio/ogg' }] } });
    await until(() => dc.sent.some((s) => /Voice messages need voice/.test(s.content || '')));
    assert.deepEqual(asks, ['buy milk']);
  } finally {
    bot.stop();
    dc.server.close();
  }
});

test('Discord: a dropped gateway connection is opened again and identifies afresh; a wrong token is reported, not crashed on', async () => {
  const dc = await fakeDiscord({ heartbeat: 41250 });
  const bot = new Discord({ getConfig: () => ({ token: 'TOKEN', enabled: true, allowedUsers: [] }), agent: {}, apiBase: dc.base, reconnectDelay: 50 });
  await bot.start();
  try {
    await until(() => bot.ready);
    dc.live().close(1001);
    await until(() => dc.conns.filter((c) => c.identified).length === 2);
    await until(() => bot.ready);
  } finally {
    bot.stop();
  }
  const bad = new Discord({ getConfig: () => ({ token: 'BAD', enabled: true, allowedUsers: [] }), agent: {}, apiBase: dc.base });
  const s = await bad.start();
  dc.server.close();
  assert.equal(s.running, false);
  assert.match(s.error, /Unauthorized/);
  // switched off or without a token it does not start
  const off = new Discord({ getConfig: () => ({ token: 'TOKEN', enabled: false }), agent: {}, apiBase: dc.base });
  assert.equal((await off.start()).running, false);
});
