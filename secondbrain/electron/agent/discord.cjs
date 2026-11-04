/**
 * Discord: talk to SecondBrain from your phone, in a DM with your own bot.
 *
 * The user makes an application in Discord's Developer Portal, copies its bot token into the Phone view's Setup, and
 * adds the bot to a server of his so he can message it. The app connects to Discord's Gateway from this PC while it
 * runs (outbound only: no server, no webhook, nothing exposed) and answers direct messages. A user must be paired
 * first: an unknown user gets his id and an instruction to approve it in the app; strangers get nothing else. Server
 * channels are never read (only the DIRECT_MESSAGES intent is asked for). Risky tools ask with Allow/Deny buttons.
 *
 * As Telegram (telegram.cjs), which this mirrors: with Steward as the agent each paired user is his own conversation
 * with him, his cards are the window's cards shown here as buttons, and a message typed while one waits is handled
 * as in the Agent tab. Commands: /new (fresh conversation), /stop, /status (also with ! for Discord's slash picker).
 *
 * No library: Node's fetch for the REST API and its WebSocket for the Gateway (JSON encoding, no compression).
 */
const crypto = require('crypto');
const { newSessionId } = require('./agent.cjs');

const API = 'https://discord.com/api/v10';
const MAX_TEXT = 2000; // Discord's message limit
const CARD_TIMEOUT_MS = 600000; // a card nobody answers in 10 minutes is answered No
const RECONNECT_MS = 5000;
const INTENTS = 1 << 12; // DIRECT_MESSAGES only; a DM's content needs no privileged intent
const USER_AGENT = 'DiscordBot (https://github.com/thebrotherscarr-bit/Jesster, 1)';
// how an answered card reads in the chat, once its buttons are gone
const ANSWERS = { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', timeout: 'No answer in 10 minutes: denied', keep: 'Kept', drop: 'Dropped', guidance: 'Sent back with guidance' };
const COMMANDS = { new: ['/new', '/start', '!new'], stop: ['/stop', '!stop'], status: ['/status', '!status'] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Discord {
  /**
   * getConfig(): { token, enabled, allowedUsers }; agent: AgentService; onState(state) for the UI; phone: phone.cjs
   * log(); sessions: user id -> session id (phone.cjs chatSessions), else in memory; transcribe(buffer, mime): text
   * for voice messages, optional. apiBase and WebSocket are Discord's own unless a test gives fakes.
   */
  constructor({ getConfig, agent, onState = () => {}, apiBase = API, WebSocket: WS = globalThis.WebSocket, transcribe = null, cardTimeout = CARD_TIMEOUT_MS, reconnectDelay = RECONNECT_MS, phone = null, sessions = null }) {
    this.getConfig = getConfig;
    this.agent = agent;
    this.onState = onState;
    this.apiBase = apiBase;
    this.WS = WS;
    this.transcribe = transcribe;
    this.cardTimeout = cardTimeout;
    this.reconnectDelay = reconnectDelay;
    this.phone = phone;
    this.running = false;
    this.ready = false;
    this.pending = new Map(); // user id -> { id, name, at }
    this.sessions = sessions || new Map(); // user id -> session id
    this.titles = new Map(); // user id -> his name, for the Phone view
    this.channels = new Map(); // user id -> DM channel id
    this.approvals = new Map(); // approval id -> resolve
    // the service's card id (Steward's) -> { chat, channel, messageId, text, timer }: where it was sent, to drop its buttons
    this.cards = new Map();
    this.me = null;
    this.error = null;
    this.ws = null;
    this.generation = 0; // a closed connection's late events are ignored
    this.seq = null;
    this.beat = null;
    this.acked = true;
    // a card answered anywhere (the window, a button here, the timeout) loses its buttons here and shows the answer
    if (agent && typeof agent.onAnswered === 'function') agent.onAnswered((entry) => this.cardAnswered(entry));
  }

  /** One REST call. `what` names it in errors (a route can carry an interaction's token, so it is never shown). */
  async api(method, route, body, what = route) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${this.apiBase}${route}`, {
        method,
        headers: { Authorization: `Bot ${this.getConfig().token}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const raw = r.status === 204 ? '' : await r.text();
      let j = null;
      try {
        j = raw ? JSON.parse(raw) : null;
      } catch {
        /* not JSON */
      }
      // rate limited: wait as told, twice at most
      if (r.status === 429 && attempt < 2) {
        await sleep(Math.min(10000, Math.max(100, (Number(j?.retry_after) || 1) * 1000)));
        continue;
      }
      if (!r.ok) throw new Error(`Discord ${what}: ${j?.message || r.status}`);
      return j;
    }
  }

  /** The DM channel with a user, opened once. */
  async channel(userId) {
    const key = String(userId);
    if (!this.channels.has(key)) this.channels.set(key, (await this.api('POST', '/users/@me/channels', { recipient_id: key }, 'open DM')).id);
    return this.channels.get(key);
  }

  async send(userId, text, components) {
    const ch = await this.channel(userId);
    const chunks = [];
    for (let s = String(text || '(empty)'); s.length; s = s.slice(MAX_TEXT)) chunks.push(s.slice(0, MAX_TEXT));
    // buttons ride on the last piece, so a long card is answered once
    let last = null;
    for (const [i, c] of chunks.entries()) last = await this.api('POST', `/channels/${ch}/messages`, { content: c, ...(components && i === chunks.length - 1 ? { components } : {}) }, 'send');
    return { message: last, channel: ch, text: chunks[chunks.length - 1] };
  }

  state() {
    return {
      running: this.running,
      bot: this.me ? this.me.username : null,
      error: this.error,
      pending: [...this.pending.values()],
      allowed: (this.getConfig().allowedUsers || []).map(String),
    };
  }

  emit() {
    this.onState(this.state());
  }

  async start() {
    const cfg = this.getConfig();
    if (this.running || !cfg.enabled || !cfg.token) return this.state();
    if (typeof this.WS !== 'function') {
      this.error = 'this build has no WebSocket';
      this.emit();
      return this.state();
    }
    try {
      this.me = await this.api('GET', '/users/@me', undefined, 'the bot');
      this.gateway = (await this.api('GET', '/gateway/bot', undefined, 'the gateway')).url;
      this.error = null;
    } catch (e) {
      this.error = e.message;
      this.emit();
      return this.state();
    }
    this.running = true;
    this.emit();
    this.connect();
    return this.state();
  }

  stop() {
    this.running = false;
    this.ready = false;
    this.generation += 1;
    clearInterval(this.beat);
    this.beat = null;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.emit();
  }

  /** One Gateway connection; when it closes while running, a new one after a pause. */
  connect() {
    if (!this.running) return;
    const gen = ++this.generation;
    this.seq = null;
    this.acked = true;
    const ws = new this.WS(`${String(this.gateway).replace(/\/+$/, '')}/?v=10&encoding=json`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      let p;
      try {
        p = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      this.gatewayEvent(p, ws).catch((e) => {
        this.error = e.message;
        this.emit();
      });
    };
    ws.onerror = () => {
      if (gen !== this.generation) return;
      this.error = 'the Discord gateway connection failed';
      this.emit();
    };
    ws.onclose = (ev) => {
      if (gen !== this.generation) return;
      clearInterval(this.beat);
      this.beat = null;
      this.ready = false;
      if (!this.running) return;
      // 4004: the token was refused; trying again would only be refused again
      if (ev && ev.code === 4004) {
        this.running = false;
        this.error = 'Discord refused the bot token';
        this.emit();
        return;
      }
      this.emit();
      setTimeout(() => this.connect(), this.reconnectDelay).unref?.();
    };
  }

  wsSend(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* closing; the reconnect follows */
    }
  }

  heartbeat(ws) {
    // no ack since the last one: the connection is dead though not closed; drop it and reconnect
    if (!this.acked) {
      try {
        ws.close(4000);
      } catch {
        /* already closed */
      }
      return;
    }
    this.acked = false;
    this.wsSend(ws, { op: 1, d: this.seq });
  }

  async gatewayEvent(p, ws) {
    if (p.s !== null && p.s !== undefined) this.seq = p.s;
    if (p.op === 10) {
      // Hello: heartbeat as asked, then identify (the token travels on the socket only, never in a URL)
      clearInterval(this.beat);
      this.beat = setInterval(() => this.heartbeat(ws), p.d.heartbeat_interval);
      this.beat.unref?.();
      this.wsSend(ws, { op: 2, d: { token: this.getConfig().token, intents: INTENTS, properties: { os: process.platform, browser: 'jesster', device: 'jesster' } } });
      return;
    }
    if (p.op === 11) {
      this.acked = true;
      return;
    }
    if (p.op === 1) return this.wsSend(ws, { op: 1, d: this.seq });
    if (p.op === 7 || p.op === 9) {
      // reconnect asked / session invalid: a fresh connection identifies again
      try {
        ws.close(4000);
      } catch {
        /* already closed */
      }
      return;
    }
    if (p.op !== 0) return;
    if (p.t === 'READY') {
      if (p.d?.user) this.me = p.d.user;
      this.ready = true;
      this.error = null;
      this.emit();
      return;
    }
    if (p.t === 'MESSAGE_CREATE') return this.handleMessage(p.d);
    if (p.t === 'INTERACTION_CREATE') return this.handleButton(p.d);
  }

  /** One line of a chat's exchange into the phone log; a log that cannot be written never stops the chat. */
  record(userId, line) {
    if (!this.phone) return;
    try {
      this.phone.append({ channel: 'discord', chatId: String(userId), title: this.titles.get(String(userId)) || '', sessionId: this.sessions.get(String(userId)) || null, ...line });
    } catch {
      /* not kept */
    }
  }

  allowed(userId) {
    return (this.getConfig().allowedUsers || []).map(String).includes(String(userId));
  }

  /** Ask in the DM before a risky tool runs (the local loop). */
  approver(userId) {
    return async (name, args, summary) => {
      const id = crypto.randomBytes(5).toString('hex');
      await this.send(userId, `The agent wants to use ${name}:\n\n${summary}`.slice(0, 1900), buttons(id));
      return new Promise((resolve) => {
        this.approvals.set(id, resolve);
        // no answer in 10 minutes: no (and the timer never keeps the app alive)
        setTimeout(() => {
          if (this.approvals.delete(id)) resolve(false);
        }, this.cardTimeout).unref?.();
      });
    };
  }

  /** Steward's cards in the DM: each is the window's card, shown with buttons; a button answers it through the service. */
  cardSender(userId) {
    return async (card) => {
      const timer = setTimeout(() => this.agent.answerApproval(card.id, false, false, undefined, { where: 'discord', timeout: true }), this.cardTimeout);
      timer.unref?.();
      const entry = { chat: String(userId), channel: null, messageId: null, text: '', timer };
      this.cards.set(card.id, entry);
      // kept when it is asked, before the send: the window can answer it (and the turn reply) while it is on its way
      this.record(userId, { kind: 'card', cardId: card.id, name: card.name, text: card.summary });
      const head = card.kind === 'review' ? '' : `Steward wants to use ${card.name}:\n\n`;
      let sent;
      try {
        sent = await this.send(userId, `${head}${card.summary}`, buttons(card.id));
      } catch (e) {
        // never shown here: it stays the window's card alone, with no timeout
        clearTimeout(timer);
        this.cards.delete(card.id);
        throw e;
      }
      entry.channel = sent.channel;
      entry.messageId = sent.message?.id ?? null;
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
    const line = answer.where === 'discord' ? said : `${said} in Jesster`;
    try {
      await this.api('PATCH', `/channels/${entry.channel}/messages/${entry.messageId}`, { content: `${entry.text}\n\n— ${line}`.slice(0, MAX_TEXT), components: [] }, 'edit');
    } catch (e) {
      this.error = e.message;
      this.emit();
    }
  }

  /** A button pressed under one of the cards (a MESSAGE_COMPONENT interaction). Strangers' presses are ignored. */
  async handleButton(d) {
    if (!d || d.type !== 3) return;
    const user = String(d.user?.id || d.member?.user?.id || '');
    const m = /^ap:([0-9a-f]+):([yn])$/.exec(d.data?.custom_id || '');
    if (!m || !this.allowed(user)) return;
    const yes = m[2] === 'y';
    const resolve = this.approvals.get(m[1]);
    this.approvals.delete(m[1]);
    let answered = Boolean(resolve);
    if (resolve) resolve(yes);
    else if (this.cards.get(m[1])?.chat === user) {
      // a card of Steward's: answered where the window's are, unless it was answered there first
      answered = this.agent.answerApproval(m[1], yes, false, undefined, { where: 'discord' });
      this.cards.delete(m[1]);
    }
    // only the presser sees this (ephemeral)
    await this.api('POST', `/interactions/${d.id}/${d.token}/callback`, { type: 4, data: { content: answered ? (yes ? 'Allowed' : 'Denied') : 'Expired', flags: 64 } }, 'answer a button');
  }

  async handleMessage(msg) {
    // DMs only; never the bot's own messages or another bot's
    if (!msg || msg.guild_id || !msg.author || msg.author.bot || (this.me && msg.author.id === this.me.id)) return;
    const userId = String(msg.author.id);
    if (msg.channel_id) this.channels.set(userId, String(msg.channel_id));
    const name = msg.author.global_name || msg.author.username || '';
    if (!this.allowed(userId)) {
      if (!this.pending.has(userId)) {
        this.pending.set(userId, { id: userId, name: name || 'unknown', at: Date.now() });
        this.emit();
      }
      await this.send(userId, `This chat isn't paired with Jesster yet. Your user id: ${userId}.\nApprove it in the app: Phone → Setup → Discord.`);
      return;
    }
    let text = String(msg.content || '').trim();
    const audio = !text && (msg.attachments || []).find((a) => /^audio\//.test(a.content_type || ''));
    if (audio) {
      if (!this.transcribe) {
        await this.send(userId, 'Voice messages need voice to be set up in Jesster (Settings → Voice).');
        return;
      }
      const got = await fetch(audio.url, { signal: AbortSignal.timeout(60000) });
      if (!got.ok) throw new Error(`Discord voice message: ${got.status}`);
      const bytes = Buffer.from(await got.arrayBuffer());
      text = await this.transcribe(bytes, audio.content_type || 'audio/ogg');
      await this.send(userId, `🎙 ${text}`);
    }
    if (!text) return;
    this.titles.set(userId, name);
    const command = text.toLowerCase();
    if (COMMANDS.new.includes(command)) {
      this.sessions.delete(userId);
      await this.send(userId, 'New conversation. What do you need?');
      return;
    }
    if (COMMANDS.stop.includes(command)) {
      const sid = this.sessions.get(userId);
      if (sid) {
        this.agent.stop(sid);
        // a card still waiting (Steward's) is answered No, so his stopped turn can end
        for (const c of this.agent.cards?.() || []) if (c.sessionId === sid) this.agent.answerApproval(c.id, false, false, undefined, { where: 'discord' });
      }
      await this.send(userId, 'Stopped.');
      return;
    }
    if (COMMANDS.status.includes(command)) {
      const m = this.agent.getModel();
      if (m.backend === 'steward' && this.agent.steward) {
        const up = await Promise.resolve()
          .then(() => this.agent.steward.up?.())
          .catch(() => false);
        await this.send(userId, `Jesster is running. Steward is the agent; his service is ${up ? 'up' : 'not answering (the next message starts it)'}.`);
        return;
      }
      await this.send(userId, `Jesster is running. Model: ${m.model}. Tools: ${this.agent.registry.schemas().length}.`);
      return;
    }
    await this.channel(userId)
      .then((ch) => this.api('POST', `/channels/${ch}/typing`, undefined, 'typing'))
      .catch(() => {});
    // the user's session is named before the turn, so a message typed while a card waits finds it
    const sessionId = this.sessions.get(userId) || newSessionId();
    if (this.sessions.get(userId) !== sessionId) this.sessions.set(userId, sessionId);
    this.record(userId, { kind: 'user', text });
    const reply = (r) => {
      this.record(userId, { kind: 'reply', text: r.answer });
      return this.send(userId, r.answer).catch((e) => {
        this.error = e.message;
        this.emit();
      });
    };
    let r;
    try {
      r = await this.agent.ask({
        text,
        sessionId,
        source: 'discord',
        approve: this.approver(userId), // the local loop's risky tools
        onCard: this.cardSender(userId), // Steward's cards
        onAnswer: reply, // the answer to a message that waited behind a card
      });
    } catch (e) {
      await this.send(userId, e.message); // e.g. still working on the last message
      return;
    }
    if (r.answeredReview) return this.send(userId, 'Sent back to the fixer as guidance.');
    if (r.queued) return this.send(userId, 'The waiting card was answered No; this message goes to Steward next.');
    await reply(r);
  }

  /** To every paired user (the Phone view's test message). */
  async broadcast(text) {
    const users = this.getConfig().allowedUsers || [];
    if (!this.getConfig().token || !users.length) throw new Error('Discord is not set up');
    for (const u of users) await this.send(u, text);
  }

  approvePairing(userId) {
    this.pending.delete(String(userId));
    this.emit();
  }
}

/** Allow/Deny buttons for one card: one action row, two buttons (green, red). */
function buttons(id) {
  return [{ type: 1, components: [{ type: 2, style: 3, label: 'Allow', custom_id: `ap:${id}:y` }, { type: 2, style: 4, label: 'Deny', custom_id: `ap:${id}:n` }] }];
}

module.exports = { Discord, INTENTS };
