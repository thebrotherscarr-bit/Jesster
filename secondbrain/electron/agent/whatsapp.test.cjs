const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WhatsApp, bare, number, textOf } = require('./whatsapp.cjs');
const { AgentService } = require('./service.cjs');
const { Vault } = require('../vaultfs.cjs');

const ME = '15550001111@s.whatsapp.net';
const ME_LID = '987654321@lid';

/**
 * A fake WhatsApp: each connect() makes a fake Baileys socket (its `ev`, sendMessage, presence, end, logout). Nothing
 * reaches WhatsApp's servers. The test drives it: a QR, the link opening, a close with a code, a message arriving.
 */
function fakeWhatsApp() {
  const socks = [];
  const sent = []; // { to, text, id }
  let n = 0;
  const socket = async (authDir) => {
    const ev = new EventEmitter();
    const sock = {
      authDir,
      ev,
      user: null,
      ended: false,
      loggedOut: false,
      presence: [],
      sendMessage: async (to, content) => {
        const id = `OUT${++n}`;
        sent.push({ to, text: content.text, id });
        // as WhatsApp would, the device's own send can come back (as 'append'); never read as his
        ev.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: to, fromMe: true, id }, message: { conversation: content.text } }] });
        return { key: { remoteJid: to, fromMe: true, id } };
      },
      sendPresenceUpdate: async (kind, to) => sock.presence.push([kind, to]),
      end: () => {
        sock.ended = true;
      },
      logout: async () => {
        sock.loggedOut = true;
      },
      download: async () => Buffer.from('OGGDATA'),
    };
    socks.push(sock);
    return sock;
  };
  const live = () => socks.at(-1);
  const open = (user = { id: '15550001111:7@s.whatsapp.net', lid: '987654321:7@lid', name: 'Kyle' }) => {
    live().user = user;
    live().ev.emit('connection.update', { connection: 'open' });
  };
  const close = (code) => live().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
  let id = 1;
  /** A message arriving: from a chat (`from`), his own when fromMe. */
  const message = (from, text, { fromMe = false, name = '', alt, message: m, type = 'notify' } = {}) =>
    live().ev.emit('messages.upsert', { type, messages: [{ key: { remoteJid: from, fromMe, id: `IN${id++}`, ...(alt ? { remoteJidAlt: alt } : {}) }, pushName: name, message: m || { conversation: text } }] });
  return { socket, socks, sent, live, open, close, message };
}

const until = async (fn, ms = 5000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 10))) if (fn()) return true;
  throw new Error('timed out waiting');
};
const tick = () => new Promise((r) => setTimeout(r, 50));

test('WhatsApp: the QR, the link, his own chat, strangers never answered, pairing by /pair, no cards, /new, broadcast', async () => {
  const wa = fakeWhatsApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  const config = { enabled: true, allowedChats: [], selfChat: true };
  const asks = [];
  const states = [];
  const agent = {
    getModel: () => ({ model: 'gpt-oss:20b' }),
    registry: { schemas: () => [1, 2] },
    stop: () => {},
    ask: async ({ text, sessionId, source, approve, onCard }) => {
      asks.push({ text, sessionId, source, approve, onCard });
      // the service refused an approval during the turn (service.cjs READ_ONLY)
      if (text === 'run something risky') return { sessionId, answer: 'not allowed', refused: 1, needsApproval: 'That needs approval — ask from the PC or Telegram.' };
      return { sessionId, answer: `you said ${text}` };
    },
  };
  const bot = new WhatsApp({ getConfig: () => config, agent, authDir: path.join(dir, 'whatsapp-auth'), socket: wa.socket, onState: (s) => states.push(s) });
  const texts = (to) => wa.sent.filter((s) => !to || s.to === to).map((s) => s.text);
  await bot.start();
  try {
    assert.equal(wa.socks.length, 1);
    assert.equal(wa.live().authDir, path.join(dir, 'whatsapp-auth'), 'the link keys live in the folder it is given');
    // the QR to scan, as an image the page shows
    wa.live().ev.emit('connection.update', { qr: '2@abc,def,ghi' });
    assert.match(bot.state().qr, /^data:image\/gif;base64,/);
    assert.equal(bot.state().connected, false);
    wa.open();
    assert.equal(bot.state().qr, null, 'scanned: the QR goes');
    assert.deepEqual([bot.state().connected, bot.state().bot], [true, '+15550001111']);
    // a contact writes: never answered, not even with instructions; not listed either
    wa.message('15552223333@s.whatsapp.net', 'hey, dinner tonight?', { name: 'Sam' });
    // a group, a status update, and what he writes to his contacts: never read
    wa.message('120363@g.us', 'group chat');
    wa.message('status@broadcast', 'a status');
    wa.message('15552223333@s.whatsapp.net', 'sure, 7pm', { fromMe: true });
    await tick();
    assert.deepEqual(asks, []);
    assert.deepEqual(wa.sent, []);
    assert.deepEqual(bot.state().pending, []);
    // his own "Message yourself" chat is answered (its id may be his number or his hidden-number id)
    wa.message(ME, 'what is on my todo?', { fromMe: true });
    await until(() => texts(ME).includes('you said what is on my todo?'));
    assert.equal(asks[0].source, 'whatsapp');
    assert.deepEqual(wa.live().presence[0], ['composing', ME]);
    wa.message(ME_LID, 'and tomorrow?', { fromMe: true });
    await until(() => asks.length === 2);
    assert.equal(asks.length, 2, 'his own replies (the device echoing them) were never read back as his');
    // follow-ups continue the same session (the lid chat is its own); /new starts a fresh one
    wa.message(ME, 'and after?', { fromMe: true });
    await until(() => asks.length === 3);
    assert.equal(asks[2].sessionId, asks[0].sessionId);
    wa.message(ME, '/new', { fromMe: true });
    await until(() => texts(ME).includes('New conversation. What do you need?'));
    // chat and research only: no approver and no card sender are given; a refusal is said plainly in the reply
    wa.message(ME, 'run something risky', { fromMe: true });
    await until(() => texts(ME).includes('not allowed\n\nThat needs approval — ask from the PC or Telegram.'));
    assert.notEqual(asks.at(-1).sessionId, asks[0].sessionId, 'after /new it is a fresh session');
    assert.ok(asks.every((a) => a.approve === undefined && a.onCard === undefined), 'WhatsApp never asks in the chat');
    assert.ok(!texts(ME).some((t) => /Reply 1|wants to use/.test(t)));
    // a 1 or a 2 is just a message
    wa.message(ME, '1', { fromMe: true });
    await until(() => texts(ME).includes('you said 1'));
    // someone who asks to pair shows up to approve, and is told so; until then he is not answered
    wa.message('555000@lid', '/pair', { name: 'Mum', alt: '15554445555@s.whatsapp.net' });
    await until(() => bot.state().pending.length === 1);
    assert.deepEqual(bot.state().pending.map((p) => [p.id, p.name, p.number]), [['555000@lid', 'Mum', '+15554445555']]);
    assert.match(texts('555000@lid')[0], /approved in Jesster/);
    wa.message('555000@lid', 'hello?', { name: 'Mum', alt: '15554445555@s.whatsapp.net' });
    await tick();
    assert.ok(!asks.some((a) => a.text === 'hello?'));
    config.allowedChats = ['555000@lid'];
    bot.approvePairing('555000@lid');
    assert.deepEqual(bot.state().pending, []);
    wa.message('555000@lid', 'hello again', { name: 'Mum', alt: '15554445555@s.whatsapp.net' });
    await until(() => texts('555000@lid').includes('you said hello again'));
    // switched off for his own chat: not answered there
    config.selfChat = false;
    const before = asks.length;
    wa.message(ME, 'are you there?', { fromMe: true });
    await tick();
    assert.equal(asks.length, before);
    config.selfChat = true;
    // the test message reaches his own chat and every approved one
    await bot.broadcast('Jesster is connected to this chat.');
    assert.deepEqual(wa.sent.slice(-2).map((s) => s.to), [ME, '555000@lid']);
    // long answers are split
    await bot.send(ME, 'x'.repeat(9000));
    assert.equal(wa.sent.filter((s) => /^x+$/.test(s.text)).length, 3);
    assert.ok(wa.sent.every((s) => s.text.length <= 4000));
  } finally {
    bot.stop();
  }
  assert.ok(wa.live().ended, 'stop ends the connection');
  assert.ok(states.length > 0);
});

test("WhatsApp with Steward as the agent: the source line, chat and research only (any approval answered No at once, never a card, kept in the history), Telegram's cards unchanged, /stop, /status, the Phone view's log", async () => {
  const phone = require('./phone.cjs');
  const approvals = require('../approvals.cjs');
  const wa = fakeWhatsApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-steward-'));
  const vault = new Vault(dir);
  const log = phone.log(path.join(dir, 'phone-log.jsonl'));
  const history = approvals.history(path.join(dir, approvals.HISTORY_FILE));
  const seen = [];
  const decided = [];
  const steward = {
    ensure: async () => 'http://steward',
    up: async () => true,
    turn: async ({ text, previous, approve, review }) => {
      seen.push({ text, previous });
      const said = text.slice(text.indexOf(']') + 2);
      let answer = `steward: ${said}`;
      if (said.startsWith('do ')) {
        const ok = await approve('write_note', {}, `write_note ${said}`);
        decided.push(ok);
        answer = ok ? 'written' : 'not written';
      }
      if (said === 'improve it') answer = `review: ${await review({ attempt: 1, passed: true, changed: ['a.py'] })}`;
      return { answer, previous: `r${seen.length}`, calls: [] };
    },
  };
  const windowCards = [];
  const told = [];
  const service = new AgentService({ getVault: () => vault, getModel: () => ({ backend: 'steward', model: 'm' }), steward, history, emit: (ch, e) => ch === 'agent:approval' && windowCards.push(e) });
  service.onAnswered((e) => told.push(e));
  const bot = new WhatsApp({
    getConfig: () => ({ enabled: true, allowedChats: [], selfChat: true }),
    agent: service,
    authDir: path.join(dir, 'whatsapp-auth'),
    socket: wa.socket,
    phone: log,
    sessions: phone.chatSessions(path.join(dir, 'phone-sessions.json'), 'whatsapp'),
  });
  const texts = () => wa.sent.map((s) => s.text);
  await bot.start();
  try {
    wa.open();
    wa.message(ME, 'hi', { fromMe: true });
    await until(() => texts().includes('steward: hi'));
    assert.match(seen[0].text, /^\[from the phone \(WhatsApp\) — chat and research only, no changes \| [^\]]+ local \(UTC[+-]\d\d:\d\d\) \| [^\]]*\d\d:\d\d UTC\]\nhi$/);
    // an approval he asks during a WhatsApp turn: answered No at once, no card in the window or the chat
    wa.message(ME, 'do one', { fromMe: true });
    await until(() => texts().includes('not written\n\nThat needs approval — ask from the PC or Telegram.'));
    assert.deepEqual(decided, [false]);
    assert.equal(windowCards.length, 0, 'no card in the window');
    assert.equal(service.cards().length, 0);
    assert.ok(!texts().some((t) => /Reply 1|wants to use|Allowed|Denied/.test(t)), 'no card sent to the chat');
    assert.equal(seen[1].previous, 'r1', 'the chat keeps his conversation');
    assert.deepEqual(history.read(10).map((h) => [h.tool, h.answer, h.where]), [['write_note', 'no — WhatsApp is chat and research only', 'whatsapp']]);
    assert.equal(told.length, 1);
    // an improvement review during a WhatsApp turn: dropped at once, no card
    wa.message(ME, 'improve it', { fromMe: true });
    await until(() => texts().some((t) => t.startsWith('review: drop')));
    assert.equal(windowCards.length, 0);
    assert.equal(history.read(10)[0].answer, 'no — WhatsApp is chat and research only');
    // nothing refused: the reply is his answer alone
    wa.message(ME, 'plain', { fromMe: true });
    await until(() => texts().at(-1) === 'steward: plain');
    // Telegram's cards on the same service are unchanged: the window's card, told to its onCard, answered there
    const tgCards = [];
    const tg = service.ask({ text: 'do three', sessionId: 'tg-1', source: 'telegram', onCard: (c) => tgCards.push(c) });
    await until(() => windowCards.length === 1 && tgCards.length === 1);
    assert.equal(service.cards().length, 1);
    service.answerApproval(service.cards()[0].id, true, false, undefined, { where: 'telegram' });
    const tr = await tg;
    assert.equal(tr.answer, 'written');
    assert.equal(tr.refused, undefined);
    assert.deepEqual(history.read(1).map((h) => [h.answer, h.where]), [['allow', 'telegram']]);
    // /stop stops his run
    wa.message(ME, '/stop', { fromMe: true });
    await until(() => texts().includes('Stopped.'));
    // /status says whether his service is up
    wa.message(ME, '/status', { fromMe: true });
    await until(() => texts().some((t) => /Steward is the agent; his service is up/.test(t)));
    // the Phone view's log: channel whatsapp, his own chat, the exchange as it happened, no cards
    const lines = log.read('whatsapp', ME).reverse();
    assert.deepEqual(lines.slice(0, 2).map((e) => [e.kind, e.text]), [['user', 'hi'], ['reply', 'steward: hi']]);
    assert.deepEqual(lines.slice(2, 4).map((e) => e.kind), ['user', 'reply']);
    assert.ok(!lines.some((e) => e.kind === 'card'));
    assert.equal(log.list()[0].label, 'WhatsApp · Message yourself');
    assert.ok(phone.chatSessions(path.join(dir, 'phone-sessions.json'), 'whatsapp').get(ME), 'his conversation survives a restart');
  } finally {
    bot.stop();
  }
});

test('WhatsApp: the connection; restart after the scan, reconnect after a drop, an unscanned QR stops, unlinked in the phone forgets the keys, Unlink logs out', async () => {
  const wa = fakeWhatsApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-conn-'));
  const authDir = path.join(dir, 'whatsapp-auth');
  const config = { enabled: true, allowedChats: [] };
  const bot = new WhatsApp({ getConfig: () => config, agent: {}, authDir, socket: wa.socket, reconnectDelay: 20 });
  await bot.start();
  // WhatsApp asks for a restart right after the QR is scanned: a new connection at once
  wa.live().ev.emit('connection.update', { qr: 'q1' });
  fs.writeFileSync(path.join(authDir, 'creds.json'), '{}'); // what Baileys keeps once scanned
  wa.close(515);
  await until(() => wa.socks.length === 2);
  wa.open();
  assert.equal(bot.state().linked, true);
  // a dropped connection is opened again after the pause; a closed one's late events change nothing
  const old = wa.live();
  wa.close(428);
  assert.equal(bot.state().connected, false);
  await until(() => wa.socks.length === 3);
  old.ev.emit('connection.update', { connection: 'open' });
  assert.equal(bot.state().connected, false);
  wa.open();
  // unlinked from the phone: stopped, the keys gone, and it says how to link again
  wa.close(401);
  assert.equal(bot.state().running, false);
  assert.match(bot.state().error, /unlinked in WhatsApp/);
  assert.ok(!fs.existsSync(authDir));
  await tick();
  assert.equal(wa.socks.length, 3, 'no reconnect after a logout');
  // QR codes that run out unscanned: it stops asking WhatsApp for more
  await bot.start();
  wa.live().ev.emit('connection.update', { qr: 'q2' });
  wa.close(408);
  assert.equal(bot.state().running, false);
  assert.match(bot.state().error, /expired/);
  await tick();
  assert.equal(wa.socks.length, 4);
  // Unlink: logged out of his account, the keys deleted
  await bot.start();
  wa.open();
  fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');
  const s = wa.live();
  const st = await bot.unlink();
  assert.ok(s.loggedOut);
  assert.ok(s.ended);
  assert.ok(!fs.existsSync(authDir));
  assert.deepEqual([st.running, st.linked, st.bot], [false, false, null]);
  // switched off it does not start; a socket that cannot be made is reported, not crashed on
  config.enabled = false;
  assert.equal((await bot.start()).running, false);
  config.enabled = true;
  const broken = new WhatsApp({ getConfig: () => config, agent: {}, authDir, socket: async () => { throw new Error('no network'); } });
  const b = await broken.start();
  assert.equal(b.running, false);
  assert.match(b.error, /could not start: no network/);
});

test('WhatsApp: a voice note is transcribed and sent on; without voice it says how to set it up', async () => {
  const wa = fakeWhatsApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-voice-'));
  const asks = [];
  const heard = [];
  const agent = { getModel: () => ({}), ask: async ({ text, sessionId }) => (asks.push(text), { sessionId, answer: `heard ${text}` }) };
  const bot = new WhatsApp({ getConfig: () => ({ enabled: true, allowedChats: [] }), agent, authDir: path.join(dir, 'a'), socket: wa.socket, transcribe: async (buf, mime) => (heard.push([buf.toString(), mime]), 'buy milk') });
  await bot.start();
  try {
    wa.open();
    const voice = { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } };
    wa.message(ME, '', { fromMe: true, message: voice });
    await until(() => wa.sent.some((s) => s.text === 'heard buy milk'));
    assert.deepEqual(heard, [['OGGDATA', 'audio/ogg; codecs=opus']]);
    assert.ok(wa.sent.some((s) => s.text === '🎙 buy milk'));
    bot.transcribe = null;
    wa.message(ME, '', { fromMe: true, message: { ephemeralMessage: { message: voice } } });
    await until(() => wa.sent.some((s) => /Voice notes need voice/.test(s.text)));
    assert.deepEqual(asks, ['buy milk']);
  } finally {
    bot.stop();
  }
});

test("WhatsApp's helpers, and Baileys and the QR drawer are installed with what this uses (loaded, never connected)", async () => {
  assert.equal(bare('15550001111:7@s.whatsapp.net'), '15550001111@s.whatsapp.net');
  assert.equal(number('15550001111:7@s.whatsapp.net'), '+15550001111');
  assert.equal(number('987654321@lid'), null);
  assert.equal(textOf({ ephemeralMessage: { message: { extendedTextMessage: { text: 'hi' } } } }), 'hi');
  const b = await import('baileys');
  assert.equal(typeof (b.makeWASocket || b.default), 'function');
  assert.equal(typeof b.useMultiFileAuthState, 'function');
  assert.equal(typeof b.downloadMediaMessage, 'function');
  assert.equal(b.Browsers.windows('Jesster')[1], 'Jesster');
  assert.equal(b.DisconnectReason.loggedOut, 401);
  assert.equal(b.DisconnectReason.restartRequired, 515);
  assert.equal(b.DisconnectReason.timedOut, 408);
  assert.equal(typeof require('qrcode-generator'), 'function');
});
