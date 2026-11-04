/**
 * WhatsApp: talk to SecondBrain from your phone, on your own WhatsApp account.
 *
 * The app joins the account as a linked device (WhatsApp → Settings → Linked devices → Link a device, scanning the QR
 * code the Phone view's Setup shows), through Baileys: WhatsApp Web's own multi-device protocol over one outbound
 * WebSocket, from this PC, while the app runs. No browser, no server, no webhook, nothing exposed. Baileys is not
 * WhatsApp's own client, so WhatsApp may restrict an account that uses it; the operator chose it knowing that.
 *
 * The link's keys (Baileys' auth state) live in SecondBrain's own folder (userData\whatsapp-auth): never in the vault,
 * never in git, never logged (Baileys' logger is silenced). Unlink logs the device out and deletes them.
 *
 * Who is answered: the account is his own, so every chat he has reaches this device. Only these are read:
 *   - his own "Message yourself" chat (on by default: linking the device by its QR is that chat's pairing);
 *   - a chat whose number was approved in the app (a person sends "/pair", shows up in Setup, and is approved there).
 * Anyone else is never answered, not even with instructions (they are his contacts); groups, status updates and
 * channels are never read; what he writes in his other chats is never read either.
 *
 * As Telegram (telegram.cjs), which this mirrors: with Steward as the agent each chat is its own conversation with him;
 * his cards are the window's cards, sent here as a numbered reply ("Reply 1 to allow, 2 to deny") and answered through
 * the service like a button; a card answered anywhere says so here. Commands: /new, /stop, /status.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { newSessionId } = require('./agent.cjs');

const MAX_TEXT = 4000;
const CARD_TIMEOUT_MS = 600000; // a card nobody answers in 10 minutes is answered No
const RECONNECT_MS = 5000;
// how an answered card reads in the chat
const ANSWERS = { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', timeout: 'No answer in 10 minutes: denied', keep: 'Kept', drop: 'Dropped', guidance: 'Sent back with guidance' };
const ASK = 'Reply 1 to allow, 2 to deny.';
// Baileys' DisconnectReason codes this needs
const LOGGED_OUT = 401;
const RESTART_REQUIRED = 515; // asked once, right after the QR is scanned
const TIMED_OUT = 408; // also: the QR codes ran out before one was scanned

/** A logger that says nothing: Baileys' own would print its keys and every message. */
const silent = { level: 'silent', child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

/** The bare jid: no device (":12") and no agent part. */
const bare = (jid) => String(jid || '').replace(/:\d+(?=@)/, '').replace(/_\d+(?=@)/, '');
/** A one-to-one chat (a phone number, or WhatsApp's hidden-number id); never a group, a status update or a channel. */
const personal = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid || ''));
/** "+15551234567" from a phone-number jid; null for a hidden-number (@lid) one. */
const number = (jid) => {
  const m = /^(\d+)@s\.whatsapp\.net$/.exec(bare(jid));
  return m ? `+${m[1]}` : null;
};

/** The text of a message, through WhatsApp's wrappers (disappearing, view-once, edited). */
function textOf(m) {
  if (!m) return '';
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message;
  if (inner) return textOf(inner);
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
}
function audioOf(m) {
  if (!m) return null;
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message;
  return inner ? audioOf(inner) : m.audioMessage || null;
}

/** The QR code as an image the page can show (a data: URL), from the text WhatsApp gives. */
function qrImage(text) {
  const qrcode = require('qrcode-generator');
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 3);
}

/**
 * Baileys, loaded only when WhatsApp starts (it is an ES module): the socket, with its auth state in `authDir`.
 * Returns the socket; its creds are saved as they change.
 */
async function baileysSocket(authDir) {
  const b = await import('baileys');
  const makeWASocket = b.makeWASocket || b.default;
  const { state, saveCreds } = await b.useMultiFileAuthState(authDir);
  const sock = makeWASocket({
    auth: state,
    logger: silent,
    browser: b.Browsers.windows('Jesster'),
    markOnlineOnConnect: false, // his phone keeps getting its notifications
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false, // his chats' history is never fetched
    emitOwnEvents: false,
  });
  sock.ev.on('creds.update', saveCreds);
  sock.download = (msg) => b.downloadMediaMessage(msg, 'buffer', {});
  return sock;
}

class WhatsApp {
  /**
   * getConfig(): { enabled, allowedChats, selfChat }; agent: AgentService; onState(state) for the UI; authDir: where
   * the link's keys are kept; phone: phone.cjs log(); sessions: chat id -> session id (phone.cjs chatSessions), else in
   * memory; transcribe(buffer, mime): text for voice notes, optional. `socket(authDir)` makes the connection (Baileys';
   * a test gives a fake).
   */
  constructor({ getConfig, agent, authDir, onState = () => {}, socket = baileysSocket, transcribe = null, cardTimeout = CARD_TIMEOUT_MS, reconnectDelay = RECONNECT_MS, phone = null, sessions = null }) {
    this.getConfig = getConfig;
    this.agent = agent;
    this.authDir = authDir;
    this.onState = onState;
    this.socket = socket;
    this.transcribe = transcribe;
    this.cardTimeout = cardTimeout;
    this.reconnectDelay = reconnectDelay;
    this.phone = phone;
    this.running = false;
    this.connected = false;
    this.sock = null;
    this.generation = 0; // a closed connection's late events are ignored
    this.qr = null; // the QR code to scan, while one is shown
    this.me = null; // his own number and ids, once linked
    this.error = null;
    this.pending = new Map(); // chat id -> { id, name, at }
    this.sessions = sessions || new Map(); // chat id -> session id
    this.titles = new Map(); // chat id -> a name for the Phone view
    this.approvals = new Map(); // the local loop's card id -> { chat, resolve }
    this.cards = new Map(); // Steward's card id -> { chat, timer, sent, answer }
    this.waiting = new Map(); // chat id -> card ids waiting for a 1 or a 2, oldest first
    this.sent = new Set(); // ids of messages this device sent, never read back as his
    // a card answered anywhere (the window, a reply here, the timeout) says so here
    if (agent && typeof agent.onAnswered === 'function') agent.onAnswered((entry) => this.cardAnswered(entry));
  }

  /** Whether a link is kept (its keys are on disk). */
  linked() {
    try {
      return fs.existsSync(path.join(this.authDir, 'creds.json'));
    } catch {
      return false;
    }
  }

  state() {
    const cfg = this.getConfig() || {};
    return {
      running: this.running,
      connected: this.connected,
      linked: this.connected || this.linked(),
      bot: this.me ? this.me.number || this.me.name || 'linked' : null,
      qr: this.qr,
      error: this.error,
      selfChat: cfg.selfChat !== false,
      pending: [...this.pending.values()],
      allowed: (cfg.allowedChats || []).map(String),
    };
  }

  emit() {
    this.onState(this.state());
  }

  async start() {
    const cfg = this.getConfig() || {};
    if (this.running || !cfg.enabled) return this.state();
    this.running = true;
    this.error = null;
    await this.connect();
    return this.state();
  }

  stop() {
    this.running = false;
    this.connected = false;
    this.qr = null;
    this.generation += 1;
    const s = this.sock;
    this.sock = null;
    try {
      s?.end?.(undefined);
    } catch {
      /* already closed */
    }
    this.emit();
  }

  /** Log this device out of his account and forget the link's keys; showing a QR again needs Link. */
  async unlink() {
    const s = this.sock;
    this.generation += 1; // the logout's own close is not a reason to reconnect
    try {
      await s?.logout?.();
    } catch {
      /* the keys go anyway; his phone drops the device the next time it looks */
    }
    this.stop();
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.me = null;
    this.emit();
    return this.state();
  }

  /** One connection; while running, a closed one is opened again after a pause. */
  async connect() {
    if (!this.running) return;
    const gen = ++this.generation;
    let sock;
    try {
      fs.mkdirSync(this.authDir, { recursive: true });
      sock = await this.socket(this.authDir);
    } catch (e) {
      if (gen !== this.generation) return;
      this.running = false;
      this.error = `WhatsApp could not start: ${e.message}`;
      this.emit();
      return;
    }
    if (gen !== this.generation) {
      try {
        sock.end?.(undefined);
      } catch {
        /* closed */
      }
      return;
    }
    this.sock = sock;
    sock.ev.on('connection.update', (u) => gen === this.generation && this.connection(u, sock));
    sock.ev.on('messages.upsert', (up) => {
      if (gen !== this.generation) return;
      // 'notify': a new message; 'append' is history or this device's own sends, never read as a request
      if (up?.type !== 'notify') return;
      for (const m of up.messages || [])
        this.handle(m).catch((e) => {
          this.error = e.message;
          this.emit();
        });
    });
    this.emit();
  }

  connection(u, sock) {
    if (u.qr) {
      try {
        this.qr = qrImage(u.qr);
      } catch (e) {
        this.error = `the QR code could not be drawn: ${e.message}`;
      }
      this.emit();
    }
    if (u.connection === 'open') {
      this.connected = true;
      this.qr = null;
      this.error = null;
      const user = sock.user || {};
      this.me = { id: bare(user.id), lid: user.lid ? bare(user.lid) : null, number: number(user.id), name: user.name || '' };
      this.emit();
      return;
    }
    if (u.connection !== 'close') return;
    this.connected = false;
    this.sock = null;
    const code = u.lastDisconnect?.error?.output?.statusCode;
    if (!this.running) return this.emit();
    if (code === LOGGED_OUT) {
      // unlinked from the phone: the keys are dead; a new QR needs Link
      this.running = false;
      this.qr = null;
      this.me = null;
      fs.rmSync(this.authDir, { recursive: true, force: true });
      this.error = 'This device was unlinked in WhatsApp. Press Link a phone to link it again.';
      this.emit();
      return;
    }
    if (code === TIMED_OUT && this.qr && !this.linked()) {
      // the QR codes ran out unscanned: stop asking WhatsApp for more until he presses Link again
      this.running = false;
      this.qr = null;
      this.error = 'The QR code expired before it was scanned. Press Link a phone for a new one.';
      this.emit();
      return;
    }
    this.emit();
    setTimeout(() => this.connect(), code === RESTART_REQUIRED ? 0 : this.reconnectDelay).unref?.();
  }

  /** Send text to a chat, in pieces under the limit; the last piece's id. */
  async send(chatId, text) {
    if (!this.sock) throw new Error('WhatsApp is not connected');
    let last = null;
    for (let s = String(text || '(empty)'); s.length; s = s.slice(MAX_TEXT)) {
      last = await this.sock.sendMessage(chatId, { text: s.slice(0, MAX_TEXT) });
      if (last?.key?.id) this.sent.add(last.key.id);
    }
    if (this.sent.size > 500) this.sent = new Set([...this.sent].slice(-200));
    return last;
  }

  /** One line of a chat's exchange into the phone log; a log that cannot be written never stops the chat. */
  record(chatId, line) {
    if (!this.phone) return;
    try {
      this.phone.append({ channel: 'whatsapp', chatId: String(chatId), title: this.titles.get(String(chatId)) || '', sessionId: this.sessions.get(String(chatId)) || null, ...line });
    } catch {
      /* not kept */
    }
  }

  /** His own "Message yourself" chat. */
  isSelf(jid) {
    if (!this.me) return false;
    const j = bare(jid);
    return j === this.me.id || (this.me.lid && j === this.me.lid);
  }

  allowed(...jids) {
    const list = (this.getConfig().allowedChats || []).map(String);
    return jids.some((j) => j && list.includes(bare(j)));
  }

  /** A card waits in a chat for a 1 or a 2. */
  wait(chatId, id) {
    const list = this.waiting.get(chatId) || [];
    list.push(id);
    this.waiting.set(chatId, list);
  }

  unwait(chatId, id) {
    const list = (this.waiting.get(chatId) || []).filter((x) => x !== id);
    if (list.length) this.waiting.set(chatId, list);
    else this.waiting.delete(chatId);
  }

  /** Ask in the chat before a risky tool runs (the local loop). */
  approver(chatId) {
    return async (name, args, summary) => {
      const id = crypto.randomBytes(5).toString('hex');
      await this.send(chatId, `The agent wants to use ${name}:\n\n${String(summary).slice(0, 3500)}\n\n${ASK}`);
      return new Promise((resolve) => {
        this.approvals.set(id, { chat: chatId, resolve });
        this.wait(chatId, id);
        // no answer in 10 minutes: no (and the timer never keeps the app alive)
        setTimeout(() => {
          if (!this.approvals.delete(id)) return;
          this.unwait(chatId, id);
          resolve(false);
        }, this.cardTimeout).unref?.();
      });
    };
  }

  /** Steward's cards in the chat: each is the window's card, sent as a numbered reply; a 1 or a 2 answers it. */
  cardSender(chatId) {
    return async (card) => {
      const timer = setTimeout(() => this.agent.answerApproval(card.id, false, false, undefined, { where: 'whatsapp', timeout: true }), this.cardTimeout);
      timer.unref?.();
      const entry = { chat: chatId, timer, sent: false, answer: null };
      this.cards.set(card.id, entry);
      this.wait(chatId, card.id);
      // kept when it is asked, before the send: the window can answer it (and the turn reply) while it is on its way
      this.record(chatId, { kind: 'card', cardId: card.id, name: card.name, text: card.summary });
      const head = card.kind === 'review' ? '' : `Steward wants to use ${card.name}:\n\n`;
      const ask = card.kind === 'review' ? 'Reply 1 to keep, 2 to drop, or write guidance.' : ASK;
      try {
        await this.send(chatId, `${head}${card.summary}\n\n${ask}`);
      } catch (e) {
        // never shown here: it stays the window's card alone, with no timeout
        clearTimeout(timer);
        this.cards.delete(card.id);
        this.unwait(chatId, card.id);
        throw e;
      }
      entry.sent = true;
      // answered while it was being sent: the answer follows it now
      if (entry.answer) await this.tellAnswer(entry, entry.answer);
    };
  }

  /** A card of Steward's was answered (anywhere): the chat is told how. */
  async cardAnswered(answer) {
    const entry = this.cards.get(answer.id);
    if (!entry) return;
    this.cards.delete(answer.id);
    this.unwait(entry.chat, answer.id);
    clearTimeout(entry.timer);
    entry.answer = answer;
    this.record(entry.chat, { kind: 'answer', cardId: answer.id, answer: answer.answer, where: answer.where, text: ANSWERS[answer.answer] || answer.answer });
    if (entry.sent) await this.tellAnswer(entry, answer);
  }

  async tellAnswer(entry, answer) {
    const said = ANSWERS[answer.answer] || answer.answer;
    try {
      await this.send(entry.chat, answer.where === 'whatsapp' ? `${said}.` : `${said} in Jesster.`);
    } catch (e) {
      this.error = e.message;
      this.emit();
    }
  }

  /** A 1 or a 2 typed while a card waits in this chat answers the oldest one. True when it did. */
  answerByNumber(chatId, text) {
    const choice = text.trim();
    if (choice !== '1' && choice !== '2') return false;
    const id = (this.waiting.get(chatId) || [])[0];
    if (!id) return false;
    const yes = choice === '1';
    const local = this.approvals.get(id);
    if (local) {
      this.approvals.delete(id);
      this.unwait(chatId, id);
      local.resolve(yes);
      this.send(chatId, yes ? 'Allowed.' : 'Denied.').catch(() => {});
      return true;
    }
    // a card of Steward's: answered where the window's are (cardAnswered tells the chat), unless it was answered first
    if (!this.agent.answerApproval(id, yes, false, undefined, { where: 'whatsapp' })) {
      this.unwait(chatId, id);
      this.cards.delete(id);
      this.send(chatId, 'That card was already answered.').catch(() => {});
    }
    return true;
  }

  async handle(msg) {
    const key = msg?.key;
    if (!key || !msg.message) return;
    const remote = String(key.remoteJid || '');
    if (!personal(remote)) return; // groups, status updates, channels
    if (key.id && this.sent.has(key.id)) return; // this device's own reply
    const self = this.isSelf(remote);
    // what he writes in his other chats is his conversation with them, never a request
    if (key.fromMe && !self) return;
    const chatId = bare(remote);
    const alt = key.remoteJidAlt ? bare(key.remoteJidAlt) : null;
    const cfg = this.getConfig() || {};
    let text = textOf(msg.message).trim();
    const ok = self ? cfg.selfChat !== false : this.allowed(chatId, alt);
    if (!ok) {
      // a stranger (or a contact) is never answered; one who asks to pair shows up in Setup to approve
      if (!self && text.toLowerCase() === '/pair' && !this.pending.has(chatId)) {
        this.pending.set(chatId, { id: chatId, name: msg.pushName || number(alt) || number(chatId) || 'unknown', number: number(alt) || number(chatId), at: Date.now() });
        this.emit();
        await this.send(remote, 'Asked. This number is answered once it is approved in Jesster (Phone → Setup → WhatsApp).');
      }
      return;
    }
    const audio = !text && audioOf(msg.message);
    if (audio) {
      if (!this.transcribe) {
        await this.send(remote, 'Voice notes need voice to be set up in Jesster (Settings → Voice).');
        return;
      }
      const bytes = await this.sock.download(msg);
      text = String(await this.transcribe(Buffer.from(bytes), audio.mimetype || 'audio/ogg')).trim();
      await this.send(remote, `🎙 ${text}`);
    }
    if (!text) return;
    this.titles.set(chatId, self ? 'Message yourself' : msg.pushName || number(alt) || number(chatId) || '');
    if (this.answerByNumber(chatId, text)) return;
    const command = text.toLowerCase();
    if (command === '/new' || command === '/start') {
      this.sessions.delete(chatId);
      await this.send(remote, 'New conversation. What do you need?');
      return;
    }
    if (command === '/stop') {
      const sid = this.sessions.get(chatId);
      if (sid) {
        this.agent.stop(sid);
        // a card still waiting (Steward's) is answered No, so his stopped turn can end
        for (const c of this.agent.cards?.() || []) if (c.sessionId === sid) this.agent.answerApproval(c.id, false, false, undefined, { where: 'whatsapp' });
      }
      await this.send(remote, 'Stopped.');
      return;
    }
    if (command === '/status') {
      const m = this.agent.getModel();
      if (m.backend === 'steward' && this.agent.steward) {
        const up = await Promise.resolve()
          .then(() => this.agent.steward.up?.())
          .catch(() => false);
        await this.send(remote, `Jesster is running. Steward is the agent; his service is ${up ? 'up' : 'not answering (the next message starts it)'}.`);
        return;
      }
      await this.send(remote, `Jesster is running. Model: ${m.model}. Tools: ${this.agent.registry.schemas().length}.`);
      return;
    }
    await Promise.resolve(this.sock?.sendPresenceUpdate?.('composing', remote)).catch(() => {});
    // the chat's session is named before the turn, so a message typed while a card waits finds it
    const sessionId = this.sessions.get(chatId) || newSessionId();
    if (this.sessions.get(chatId) !== sessionId) this.sessions.set(chatId, sessionId);
    this.record(chatId, { kind: 'user', text });
    const reply = (r) => {
      this.record(chatId, { kind: 'reply', text: r.answer });
      return this.send(remote, r.answer).catch((e) => {
        this.error = e.message;
        this.emit();
      });
    };
    let r;
    try {
      r = await this.agent.ask({
        text,
        sessionId,
        source: 'whatsapp',
        approve: this.approver(remote), // the local loop's risky tools
        onCard: this.cardSender(remote), // Steward's cards
        onAnswer: reply, // the answer to a message that waited behind a card
      });
    } catch (e) {
      await this.send(remote, e.message); // e.g. still working on the last message
      return;
    }
    if (r.answeredReview) return this.send(remote, 'Sent back to the fixer as guidance.');
    if (r.queued) return this.send(remote, 'The waiting card was answered No; this message goes to Steward next.');
    await reply(r);
  }

  /** To his own chat (when it is answered) and every approved one: the Phone view's test message. */
  async broadcast(text) {
    const cfg = this.getConfig() || {};
    const to = [...(cfg.selfChat !== false && this.me ? [this.me.id] : []), ...(cfg.allowedChats || []).map(String)];
    if (!this.connected || !to.length) throw new Error('WhatsApp is not linked');
    for (const c of to) await this.send(c, text);
  }

  approvePairing(chatId) {
    this.pending.delete(bare(chatId));
    this.emit();
  }
}

module.exports = { WhatsApp, bare, number, textOf, silent };
