/**
 * Telegram: talk to SecondBrain from your phone.
 *
 * The user makes a bot with @BotFather and pastes its token in Settings.
 * The app long-polls Telegram while it runs (no server, no webhook, nothing
 * exposed). A chat must be paired first: an unknown chat gets its id and an
 * instruction to approve it in the app — strangers who find the bot get
 * nothing else. Risky tools ask with Allow/Deny buttons in the chat.
 *
 * When Steward is the agent (Settings → agent.backend 'steward'), each chat is
 * its own conversation with him, as an Agent-tab session is: his cards (the
 * plan, his tools, a review) are the window's cards, shown here as the same
 * buttons, and a message typed while one waits is handled as in the Agent tab.
 *
 * Commands: /new (fresh conversation), /stop, /status.
 */
const crypto = require('crypto');
const { newSessionId } = require('./agent.cjs');

const API = 'https://api.telegram.org';
const MAX_TEXT = 4000;
const CARD_TIMEOUT_MS = 600000; // a card nobody answers in 10 minutes is answered No
// how an answered card reads in the chat, once its buttons are gone
const ANSWERS = { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', timeout: 'No answer in 10 minutes: denied', keep: 'Kept', drop: 'Dropped', guidance: 'Sent back with guidance' };

class Telegram {
  /**
   * getConfig(): { token, enabled, allowedChats }; setPending(list): pairing
   * requests for the UI; agent: AgentService; transcribe(buffer, mime): text
   * for voice notes (voice feature), optional.
   */
  /**
   * phone: phone.cjs log(), where each exchange is kept for the Phone view; sessions: chat id -> session id, kept
   * across restarts (phone.cjs chatSessions), else in memory.
   */
  constructor({ getConfig, agent, onState = () => {}, apiBase = API, transcribe = null, cardTimeout = CARD_TIMEOUT_MS, phone = null, sessions = null }) {
    this.getConfig = getConfig;
    this.agent = agent;
    this.onState = onState;
    this.apiBase = apiBase;
    this.transcribe = transcribe;
    this.offset = 0;
    this.running = false;
    this.pending = new Map(); // chat id -> { id, name, at }
    this.sessions = sessions || new Map(); // chat id -> session id
    this.phone = phone;
    this.titles = new Map(); // chat id -> the chat's name, for the Phone view
    this.approvals = new Map(); // approval id -> resolve
    // the service's card id (Steward's) -> { chat, messageId, text, timer }: where it was sent, to drop its buttons
    this.cards = new Map();
    this.cardTimeout = cardTimeout;
    this.me = null;
    this.error = null;
    this.abort = null;
    // a card answered anywhere (the window, a button here, the timeout) loses its buttons here and shows the answer
    if (agent && typeof agent.onAnswered === 'function') agent.onAnswered((entry) => this.cardAnswered(entry));
  }

  url(method) {
    return `${this.apiBase}/bot${this.getConfig().token}/${method}`;
  }

  async api(method, body, timeoutMs = 35000) {
    const r = await fetch(this.url(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
    return j.result;
  }

  async send(chatId, text, extra = {}) {
    const chunks = [];
    for (let s = String(text || '(empty)'); s.length; s = s.slice(MAX_TEXT)) chunks.push(s.slice(0, MAX_TEXT));
    // buttons ride on the last piece, so a long card is answered once
    let last = null;
    for (const [i, c] of chunks.entries()) last = await this.api('sendMessage', { chat_id: chatId, text: c, ...(i === chunks.length - 1 ? extra : {}) });
    return { message: last, text: chunks[chunks.length - 1] }; // the last piece, which carries the buttons
  }

  state() {
    return {
      running: this.running,
      bot: this.me ? `@${this.me.username}` : null,
      error: this.error,
      pending: [...this.pending.values()],
      allowed: this.getConfig().allowedChats || [],
    };
  }

  emit() {
    this.onState(this.state());
  }

  async start() {
    const cfg = this.getConfig();
    if (this.running || !cfg.enabled || !cfg.token) return this.state();
    try {
      this.me = await this.api('getMe', {}, 15000);
      this.error = null;
    } catch (e) {
      this.error = e.message;
      this.emit();
      return this.state();
    }
    this.running = true;
    this.emit();
    this.polling = this.loop(); // settles once stop() is called and the poll in flight has returned
    return this.state();
  }

  stop() {
    this.running = false;
    this.emit();
  }

  async loop() {
    while (this.running) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          this.handle(u).catch((e) => {
            this.error = e.message;
            this.emit();
          });
        }
        if (this.error) {
          this.error = null;
          this.emit();
        }
      } catch (e) {
        if (!this.running) break;
        this.error = e.message;
        this.emit();
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /** One line of a chat's exchange into the phone log; a log that cannot be written never stops the chat. */
  record(chatId, line) {
    if (!this.phone) return;
    try {
      this.phone.append({ channel: 'telegram', chatId: String(chatId), title: this.titles.get(String(chatId)) || '', sessionId: this.sessions.get(String(chatId)) || null, ...line });
    } catch {
      /* not kept */
    }
  }

  allowed(chatId) {
    return (this.getConfig().allowedChats || []).map(String).includes(String(chatId));
  }

  /** Ask in the chat before a risky tool runs. */
  approver(chatId) {
    return async (name, args, summary) => {
      const id = crypto.randomBytes(5).toString('hex');
      await this.send(chatId, `The agent wants to use ${name}:\n\n${summary}`.slice(0, 3500), { reply_markup: buttons(id) });
      return new Promise((resolve) => {
        this.approvals.set(id, resolve);
        // no answer in 10 minutes: no (and the timer never keeps the app alive)
        setTimeout(() => {
          if (this.approvals.delete(id)) resolve(false);
        }, this.cardTimeout).unref?.();
      });
    };
  }

  /**
   * Steward's cards in the chat: each is the window's card (AgentService), shown with the same
   * buttons; a button answers it through the service, as the Agent tab's Allow/Deny do.
   */
  cardSender(chatId) {
    return async (card) => {
      // no answer in 10 minutes, here or in the window: answered No, as the local loop's cards are
      const timer = setTimeout(() => this.agent.answerApproval(card.id, false, false, undefined, { where: 'telegram', timeout: true }), this.cardTimeout);
      timer.unref?.();
      const entry = { chat: String(chatId), messageId: null, text: '', timer };
      this.cards.set(card.id, entry);
      // kept when it is asked, before the send: the window can answer it (and the turn reply) while it is on its way
      this.record(chatId, { kind: 'card', cardId: card.id, name: card.name, text: card.summary });
      const head = card.kind === 'review' ? '' : `Steward wants to use ${card.name}:\n\n`;
      let sent;
      try {
        sent = await this.send(chatId, `${head}${card.summary}`, { reply_markup: buttons(card.id) });
      } catch (e) {
        // never shown here: it stays the window's card alone, with no timeout
        clearTimeout(timer);
        this.cards.delete(card.id);
        throw e;
      }
      entry.messageId = sent.message?.message_id ?? null;
      entry.text = sent.text;
      // answered while it was being sent: its buttons go now
      if (!this.cards.has(card.id) && entry.answer) await this.dropButtons(entry, entry.answer);
    };
  }

  /** A card of Steward's was answered (anywhere): its message here shows the answer, without buttons. */
  async cardAnswered(answer) {
    const entry = this.cards.get(answer.id);
    if (!entry) return;
    this.cards.delete(answer.id);
    clearTimeout(entry.timer);
    entry.answer = answer;
    this.record(entry.chat, { kind: 'answer', cardId: answer.id, answer: answer.answer, where: answer.where, text: ANSWERS[answer.answer] || answer.answer });
    if (entry.messageId !== null) await this.dropButtons(entry, answer);
  }

  async dropButtons(entry, answer) {
    const said = ANSWERS[answer.answer] || answer.answer;
    const line = answer.where === 'telegram' ? said : `${said} in Jesster`;
    try {
      await this.api('editMessageText', { chat_id: entry.chat, message_id: entry.messageId, text: `${entry.text}\n\n— ${line}`.slice(0, 4096), reply_markup: { inline_keyboard: [] } });
    } catch (e) {
      this.error = e.message;
      this.emit();
    }
  }

  async handle(u) {
    if (u.callback_query) {
      const q = u.callback_query;
      const m = /^ap:([0-9a-f]+):([yn])$/.exec(q.data || '');
      const chat = String(q.message?.chat?.id);
      if (m && this.allowed(chat)) {
        const yes = m[2] === 'y';
        const resolve = this.approvals.get(m[1]);
        this.approvals.delete(m[1]);
        let answered = Boolean(resolve);
        if (resolve) resolve(yes);
        else if (this.cards.get(m[1])?.chat === chat) {
          // a card of Steward's: answered where the window's are, unless it was answered there first
          answered = this.agent.answerApproval(m[1], yes, false, undefined, { where: 'telegram' });
          this.cards.delete(m[1]);
        }
        await this.api('answerCallbackQuery', { callback_query_id: q.id, text: answered ? (yes ? 'Allowed' : 'Denied') : 'Expired' });
      }
      return;
    }
    const msg = u.message;
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;
    if (!this.allowed(chatId)) {
      if (!this.pending.has(String(chatId))) {
        const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.title || msg.chat.username || 'unknown';
        this.pending.set(String(chatId), { id: String(chatId), name, at: Date.now() });
        this.emit();
      }
      await this.send(chatId, `This chat isn't paired with Jesster yet. Chat id: ${chatId}.\nApprove it in the app: Settings → Telegram.`);
      return;
    }
    let text = msg.text || msg.caption || '';
    if (!text && (msg.voice || msg.audio)) {
      if (!this.transcribe) {
        await this.send(chatId, 'Voice notes need voice to be set up in Jesster (Settings → Voice).');
        return;
      }
      const f = await this.api('getFile', { file_id: (msg.voice || msg.audio).file_id });
      const audio = Buffer.from(await (await fetch(`${this.apiBase}/file/bot${this.getConfig().token}/${f.file_path}`)).arrayBuffer());
      text = await this.transcribe(audio, (msg.voice || msg.audio).mime_type || 'audio/ogg');
      await this.send(chatId, `🎙 ${text}`);
    }
    if (!text) return;
    const key = String(chatId);
    this.titles.set(key, [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.title || msg.chat.username || '');
    if (text === '/new' || text === '/start') {
      this.sessions.delete(key);
      await this.send(chatId, 'New conversation. What do you need?');
      return;
    }
    if (text === '/stop') {
      const sid = this.sessions.get(key);
      if (sid) {
        this.agent.stop(sid);
        // a card still waiting (Steward's) is answered No, so his stopped turn can end
        for (const c of this.agent.cards?.() || []) if (c.sessionId === sid) this.agent.answerApproval(c.id, false, false, undefined, { where: 'telegram' });
      }
      await this.send(chatId, 'Stopped.');
      return;
    }
    if (text === '/status') {
      const m = this.agent.getModel();
      if (m.backend === 'steward' && this.agent.steward) {
        const up = await Promise.resolve()
          .then(() => this.agent.steward.up?.())
          .catch(() => false);
        await this.send(chatId, `Jesster is running. Steward is the agent; his service is ${up ? 'up' : 'not answering (the next message starts it)'}.`);
        return;
      }
      await this.send(chatId, `Jesster is running. Model: ${m.model}. Tools: ${this.agent.registry.schemas().length}.`);
      return;
    }
    await this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    // the chat's session is named before the turn, so a message typed while a card waits finds it
    const sessionId = this.sessions.get(key) || newSessionId();
    if (this.sessions.get(key) !== sessionId) this.sessions.set(key, sessionId);
    this.record(chatId, { kind: 'user', text });
    const reply = (r) => {
      this.record(chatId, { kind: 'reply', text: r.answer });
      return this.send(chatId, r.answer).catch((e) => {
        this.error = e.message;
        this.emit();
      });
    };
    let r;
    try {
      r = await this.agent.ask({
        text,
        sessionId,
        source: 'telegram',
        approve: this.approver(chatId), // the local loop's risky tools
        onCard: this.cardSender(chatId), // Steward's cards
        onAnswer: reply, // the answer to a message that waited behind a card
      });
    } catch (e) {
      await this.send(chatId, e.message); // e.g. still working on the last message
      return;
    }
    if (r.answeredReview) return this.send(chatId, 'Sent back to the fixer as guidance.');
    if (r.queued) return this.send(chatId, 'The waiting card was answered No; this message goes to Steward next.');
    await reply(r);
  }

  /** For automations: send to every paired chat. */
  async broadcast(text) {
    const chats = this.getConfig().allowedChats || [];
    if (!this.getConfig().token || !chats.length) throw new Error('Telegram is not set up');
    for (const c of chats) await this.send(c, text);
  }

  approvePairing(chatId) {
    this.pending.delete(String(chatId));
    this.emit();
  }
}

/** Allow/Deny buttons for one card. */
function buttons(id) {
  return { inline_keyboard: [[{ text: '✅ Allow', callback_data: `ap:${id}:y` }, { text: '❌ Deny', callback_data: `ap:${id}:n` }]] };
}

module.exports = { Telegram };
