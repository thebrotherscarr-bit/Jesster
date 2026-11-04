/**
 * The agent service: one door for every way of talking to the agent — the
 * Agent tab, Telegram, scheduled automations, subagents. It owns the tool
 * registry, the live sessions, and approvals for risky tools.
 */
const crypto = require('crypto');
const { Registry, core } = require('./tools.cjs');
const { runTurn, newSessionId, saveSession, messagesFromNote } = require('./agent.cjs');

// where a turn to Steward comes from, told to him on its first line (the operator, 2026-11-04: "this is the pc" and
// "this is the phone"); the phone's channels are kept off the Agent tab's chat list (they are the Phone view's)
const SOURCES = { app: 'from the PC (Agent tab)', telegram: 'from the phone (Telegram)', whatsapp: 'from the phone (WhatsApp)', discord: 'from the phone (Discord)' };
const PHONE = ['telegram', 'whatsapp', 'discord'];

/** The text Steward is sent: a short line naming where it came from, then the message (an improve: word stays first). */
function withSource(text, source) {
  const line = SOURCES[source];
  if (!line) return text;
  return /^\s*improve:/i.test(text) ? `${text}\n\n[${line}]` : `[${line}]\n${text}`;
}

class AgentService {
  /**
   * getVault(): the vault; getModel(): { host, model, maxSteps };
   * emit(channel, payload): to the window; extras(): system prompt pieces
   * (memory, skills index) added by later features; steward: { ensure, turn, up } (steward.cjs),
   * the agent of the Agent tab and of Telegram when getModel().backend is 'steward'.
   */
  constructor({ getVault, getModel, emit = () => {}, extras = () => [], steward = null, checker = null, threads = null, history = null }) {
    this.getVault = getVault;
    this.getModel = getModel;
    this.emit = emit;
    this.extras = extras;
    this.steward = steward;
    // checker({ turn, signal }) -> Claude's check of a Steward turn, or null while it is switched off
    this.checker = checker;
    // threads: { get(id), set(id, { previous }) } (steward.cjs), so a conversation keeps
    // Steward's thread across a restart
    this.threads = threads;
    // history: { append(entry) } (approvals.cjs history()): every answered card is kept there
    this.history = history;
    // told of every answered card (Telegram drops the card's buttons and shows the answer)
    this.answeredHooks = [];
    this.registry = new Registry().add(core);
    this.sessions = new Map(); // id -> { messages, busy, abort }
    this.pending = new Map(); // approval id -> { resolve, key, sessionId, name, args, summary, at, kind? }
    // Always allow: key `${name}:${summary}` -> { name, summary, at }; in memory, so it ends when SecondBrain does
    this.alwaysAllow = new Map();
  }

  session(id) {
    if (!this.sessions.has(id)) {
      const note = this.getVault().load().find((n) => n.id === id);
      const thread = this.threads?.get(id);
      this.sessions.set(id, {
        messages: note ? messagesFromNote(note) : [],
        busy: false,
        abort: null,
        ...(thread ? { stewardPrevious: thread.previous, improve: Boolean(thread.improve) } : {}),
      });
    }
    return this.sessions.get(id);
  }

  /**
   * Ask the window's user before a risky tool runs. `onCard(card)`, when given, is told of each card
   * as well (Telegram shows it as Allow/Deny buttons); the card is the window's, so it is answered by
   * answerApproval from either place, and a message typed while it waits is handled the same way.
   */
  approveInWindow(sessionId, onCard) {
    return (name, args, summary) => {
      const key = `${name}:${summary}`;
      if (this.alwaysAllow.has(key)) return Promise.resolve(true);
      const id = crypto.randomBytes(6).toString('hex');
      this.emit('agent:approval', { id, sessionId, name, args, summary });
      const answer = new Promise((resolve) => this.pending.set(id, { resolve, key, sessionId, name, args, summary, at: Date.now() }));
      this.tellCard(onCard, { id, sessionId, name, args, summary });
      return answer;
    };
  }

  /** A card's other place (Telegram) is told of it; a failure there leaves the card in the window. */
  tellCard(onCard, card) {
    if (!onCard) return;
    Promise.resolve()
      .then(() => onCard(card))
      .catch(() => {});
  }

  /**
   * The improvement loop's review (step 6) on the window's own approval card (Kyle, 2026-11-02: "use what is
   * there"): Allow keeps the change, Deny drops it, and a message typed while it waits goes back to the fixer as
   * guidance. Resolves the reply text.
   */
  reviewInWindow(sessionId, onCard) {
    return (request) => {
      const id = crypto.randomBytes(6).toString('hex');
      const r = request || {};
      const changed = Array.isArray(r.changed) && r.changed.length ? r.changed.join(', ') : 'nothing';
      const summary =
        `Improvement round: attempt ${r.attempt ?? '?'}, checks ${r.passed ? 'passed' : 'failed'}. Changed: ${changed}.\n` +
        `Allow once = keep the change. Deny = drop it. Or type guidance in the box to send it back for another attempt.\n\n` +
        String(r.output || '').slice(-1500);
      this.emit('agent:approval', { id, sessionId, name: 'review', kind: 'review', args: request || {}, summary });
      const answer = new Promise((resolve) => this.pending.set(id, { resolve, key: `review:${id}`, sessionId, kind: 'review', name: 'review', args: request || {}, summary, at: Date.now() }));
      this.tellCard(onCard, { id, sessionId, name: 'review', kind: 'review', args: request || {}, summary });
      return answer;
    };
  }

  /** `fn(entry)` is told of every answered card, with the entry kept in the history. */
  onAnswered(fn) {
    this.answeredHooks.push(fn);
  }

  /**
   * Answer a waiting card. `where` is the place it was answered ('window' or 'telegram'); `timeout` marks a card
   * nobody answered in time (answered No). The answer is kept in the history and told to onAnswered's listeners.
   */
  answerApproval(id, allow, always, text, { where = 'window', timeout = false } = {}) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    // the card is gone wherever it shows (the Agent tab, the Services window's Approvals)
    this.emit('agent:approval-done', { id, sessionId: p.sessionId });
    const guidance = typeof text === 'string' && text.trim() ? text.trim() : '';
    const answer = p.kind === 'review' ? (guidance ? 'guidance' : allow ? 'keep' : 'drop') : timeout ? 'timeout' : allow ? (always ? 'always' : 'allow') : 'deny';
    this.answered({ id, tool: p.name, summary: p.summary, answer, where, time: new Date().toISOString() });
    if (p.kind === 'review') {
      p.resolve(guidance || (allow ? 'keep' : 'drop'));
      return true;
    }
    if (allow && always) this.alwaysAllow.set(p.key, { name: p.name, summary: p.summary, at: Date.now() });
    p.resolve(Boolean(allow));
    return true;
  }

  /** One answered card into the history and to the listeners; neither failing stops the answer. */
  answered(entry) {
    try {
      this.history?.append(entry);
    } catch {
      /* a history that cannot be written still answers the card */
    }
    for (const fn of this.answeredHooks) {
      try {
        fn(entry);
      } catch {
        /* one listener failing leaves the others told */
      }
    }
  }

  /** The cards waiting now, as the window was sent them, with when each was asked. */
  cards() {
    return [...this.pending].map(([id, p]) => ({ id, sessionId: p.sessionId, name: p.name, args: p.args, summary: p.summary, at: p.at, ...(p.kind ? { kind: p.kind } : {}) }));
  }

  /** The standing Always allow entries: each is one tool with the exact text its card showed. */
  always() {
    return [...this.alwaysAllow].map(([key, a]) => ({ key, name: a.name, summary: a.summary, at: a.at }));
  }

  /** Forget one Always allow entry by its key, or every one when no key is given; the entries left. */
  resetAlways(key) {
    if (typeof key === 'string' && key) this.alwaysAllow.delete(key);
    else this.alwaysAllow.clear();
    return this.always();
  }

  /**
   * One user message → the agent's answer. `source` names where it came from
   * (app, telegram, schedule, subagent); `approve` overrides how risky tools
   * are confirmed; `only` limits the tools offered. With Steward, `onCard(card)` is told of each of
   * his cards (Telegram's buttons), and `onAnswer(result)` gets the result of a message that was
   * queued behind a card (it runs after the turn it interrupted, so ask() cannot return it).
   */
  async ask(request) {
    const { text, sessionId, source = 'app', approve, only, onEvent, save = true, maxSteps, onCard } = request;
    const id = sessionId || newSessionId();
    const s = this.session(id);
    if (s.busy) {
      // a message typed while a card waits: the card is answered No (nothing runs, and his
      // workflow ends the run), and the message goes to him next, as a new request
      const waiting = [...this.pending].filter(([, p]) => p.sessionId === id);
      if (!waiting.length) throw new Error('this session is still working on the last message');
      // a message typed at a waiting review is its guidance (a No would drop the fixer's work)
      const review = waiting.find(([, p]) => p.kind === 'review');
      const how = { where: source === 'telegram' ? 'telegram' : 'window' };
      if (review) {
        this.answerApproval(review[0], true, false, text, how);
        return { sessionId: id, answeredReview: true };
      }
      s.next = { ...request, sessionId: id };
      for (const [key] of waiting) this.answerApproval(key, false, false, undefined, how);
      return { sessionId: id, queued: true };
    }
    s.busy = true;
    s.abort = new AbortController();
    s.messages.push({ role: 'user', content: text });
    const { host, model, maxSteps: defaultSteps, backend } = this.getModel();
    const vault = this.getVault();
    const send = (e) => {
      this.emit('agent:event', { sessionId: id, ...e });
      onEvent?.(e);
    };
    send({ type: 'user', text, source });
    try {
      // the Agent tab and Telegram talk to Steward; schedules and subagents keep the local loop for now
      if (this.steward && backend === 'steward' && (source === 'app' || source === 'telegram')) {
        return { sessionId: id, answer: await this.askSteward(s, text, id, send, approve, onCard, source) };
      }
      const answer = await runTurn({
        host,
        model,
        messages: s.messages,
        registry: this.registry,
        ctx: { vault, service: this, sessionId: id, source, signal: s.abort.signal, approve: approve || this.approveInWindow(id) },
        onEvent: send,
        maxSteps: maxSteps || defaultSteps || 12,
        signal: s.abort.signal,
        system: await this.extras({ source }),
        only,
      });
      return { sessionId: id, answer };
    } catch (e) {
      const msg = e.name === 'AbortError' || e.message === 'stopped' ? 'Stopped.' : e.message;
      s.messages.push({ role: 'assistant', content: msg });
      send({ type: 'error', text: msg });
      return { sessionId: id, answer: msg, error: true };
    } finally {
      s.busy = false;
      s.abort = null;
      if (save) {
        try {
          saveSession(vault, id, s.messages, source);
          this.emit('vault:changed');
        } catch {
          /* a session that cannot be saved is still answered */
        }
      }
      // a message typed while a card waited runs now, as its own turn; the tab stays busy
      const next = s.next;
      s.next = null;
      if (next) this.ask(next).then((r) => next.onAnswer?.(r), () => {});
      else send({ type: 'done' });
    }
  }

  /**
   * One turn with Steward: his service is started if needed, the conversation continues from
   * this session's last response id, and his approval requests come to the window's cards (and,
   * with `onCard`, to Telegram's buttons too: then the cards are always the window's own).
   */
  async askSteward(s, text, id, send, approve, onCard, source = 'app') {
    const base = await this.steward.ensure();
    // his service runs his MAF workflow, which keeps the plan and execute modes itself: the plan
    // comes as an approval request (a card), and the tab sends only the text
    // a conversation that starts with "improve:" is an improvement round (step 6): every turn of it names the loop
    if (!s.stewardPrevious && /^\s*improve:/i.test(text)) s.improve = true;
    const r = await this.steward.turn({
      base,
      text: withSource(text, source),
      previous: s.stewardPrevious,
      approve: onCard ? this.approveInWindow(id, onCard) : approve || this.approveInWindow(id),
      review: this.reviewInWindow(id, onCard),
      metadata: s.improve ? { steward_workflow: 'improve' } : undefined,
      onEvent: send,
      signal: s.abort.signal,
    });
    s.stewardPrevious = r.previous;
    this.threads?.set(id, { previous: s.stewardPrevious, ...(s.improve ? { improve: true } : {}) });
    // the session note shows his tool calls the way it shows the local loop's
    if (r.calls.length) s.messages.push({ role: 'assistant', content: '', tool_calls: r.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) });
    s.messages.push({ role: 'assistant', content: r.answer });
    await this.checkTurn(s, { text, calls: r.calls, answer: r.answer }, send);
    return r.answer;
  }

  /** Claude's check of the turn, shown under the answer and kept in the session note. */
  async checkTurn(s, turn, send) {
    if (!this.checker) return;
    try {
      const check = await this.checker({ turn, signal: s.abort?.signal });
      if (!check) return;
      send({ type: 'check', text: check });
      s.messages.push({ role: 'assistant', content: `**Claude's check**\n\n${check}` });
    } catch (e) {
      if (e.name !== 'AbortError') send({ type: 'check', text: `Claude's check could not run: ${e.message}` });
    }
  }

  stop(sessionId) {
    this.sessions.get(sessionId)?.abort?.abort();
  }

  /** The Agent tab's conversations: the phone's (Telegram, ...) are the Phone view's, not listed here. */
  list() {
    return this.getVault()
      .load()
      .filter((n) => n.tags.includes('agent-session') && !n.tags.some((t) => PHONE.includes(t)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
      .map((n) => ({ id: n.id, title: n.title, updatedAt: n.updatedAt, source: n.tags.find((t) => t !== 'agent-session') }));
  }

  open(sessionId) {
    const s = this.session(sessionId);
    return { sessionId, busy: s.busy, messages: s.messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)) };
  }
}

module.exports = { AgentService, withSource, SOURCES, PHONE };
