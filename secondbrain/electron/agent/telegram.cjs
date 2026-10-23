/**
 * Telegram: talk to SecondBrain from your phone.
 *
 * The user makes a bot with @BotFather and pastes its token in Settings.
 * The app long-polls Telegram while it runs (no server, no webhook, nothing
 * exposed). A chat must be paired first: an unknown chat gets its id and an
 * instruction to approve it in the app — strangers who find the bot get
 * nothing else. Risky tools ask with Allow/Deny buttons in the chat.
 *
 * Commands: /new (fresh conversation), /stop, /status.
 */
const crypto = require('crypto');

const API = 'https://api.telegram.org';
const MAX_TEXT = 4000;

class Telegram {
  /**
   * getConfig(): { token, enabled, allowedChats }; setPending(list): pairing
   * requests for the UI; agent: AgentService; transcribe(buffer, mime): text
   * for voice notes (voice feature), optional.
   */
  constructor({ getConfig, agent, onState = () => {}, apiBase = API, transcribe = null }) {
    this.getConfig = getConfig;
    this.agent = agent;
    this.onState = onState;
    this.apiBase = apiBase;
    this.transcribe = transcribe;
    this.offset = 0;
    this.running = false;
    this.pending = new Map(); // chat id -> { id, name, at }
    this.sessions = new Map(); // chat id -> session id
    this.approvals = new Map(); // approval id -> resolve
    this.me = null;
    this.error = null;
    this.abort = null;
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
    for (const c of chunks) await this.api('sendMessage', { chat_id: chatId, text: c, ...extra });
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
    this.loop();
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

  allowed(chatId) {
    return (this.getConfig().allowedChats || []).map(String).includes(String(chatId));
  }

  /** Ask in the chat before a risky tool runs. */
  approver(chatId) {
    return async (name, args, summary) => {
      const id = crypto.randomBytes(5).toString('hex');
      await this.send(chatId, `The agent wants to use ${name}:\n\n${summary}`.slice(0, 3500), {
        reply_markup: { inline_keyboard: [[{ text: '✅ Allow', callback_data: `ap:${id}:y` }, { text: '❌ Deny', callback_data: `ap:${id}:n` }]] },
      });
      return new Promise((resolve) => {
        this.approvals.set(id, resolve);
        // no answer in 10 minutes: no (and the timer never keeps the app alive)
        setTimeout(() => {
          if (this.approvals.delete(id)) resolve(false);
        }, 600000).unref?.();
      });
    };
  }

  async handle(u) {
    if (u.callback_query) {
      const q = u.callback_query;
      const m = /^ap:([0-9a-f]+):([yn])$/.exec(q.data || '');
      if (m && this.allowed(q.message?.chat?.id)) {
        const resolve = this.approvals.get(m[1]);
        this.approvals.delete(m[1]);
        await this.api('answerCallbackQuery', { callback_query_id: q.id, text: resolve ? (m[2] === 'y' ? 'Allowed' : 'Denied') : 'Expired' });
        if (resolve) resolve(m[2] === 'y');
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
      await this.send(chatId, `This chat isn't paired with SecondBrain yet. Chat id: ${chatId}.\nApprove it in the app: Settings → Telegram.`);
      return;
    }
    let text = msg.text || msg.caption || '';
    if (!text && (msg.voice || msg.audio)) {
      if (!this.transcribe) {
        await this.send(chatId, 'Voice notes need voice to be set up in SecondBrain (Settings → Voice).');
        return;
      }
      const f = await this.api('getFile', { file_id: (msg.voice || msg.audio).file_id });
      const audio = Buffer.from(await (await fetch(`${this.apiBase}/file/bot${this.getConfig().token}/${f.file_path}`)).arrayBuffer());
      text = await this.transcribe(audio, (msg.voice || msg.audio).mime_type || 'audio/ogg');
      await this.send(chatId, `🎙 ${text}`);
    }
    if (!text) return;
    const key = String(chatId);
    if (text === '/new' || text === '/start') {
      this.sessions.delete(key);
      await this.send(chatId, 'New conversation. What do you need?');
      return;
    }
    if (text === '/stop') {
      if (this.sessions.has(key)) this.agent.stop(this.sessions.get(key));
      await this.send(chatId, 'Stopped.');
      return;
    }
    if (text === '/status') {
      await this.send(chatId, `SecondBrain is running. Model: ${this.agent.getModel().model}. Tools: ${this.agent.registry.schemas().length}.`);
      return;
    }
    await this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const r = await this.agent.ask({ text, sessionId: this.sessions.get(key), source: 'telegram', approve: this.approver(chatId) });
    this.sessions.set(key, r.sessionId);
    await this.send(chatId, r.answer);
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

module.exports = { Telegram };
