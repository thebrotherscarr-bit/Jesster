/**
 * The agent service: one door for every way of talking to the agent — the
 * Agent tab, Telegram, scheduled automations, subagents. It owns the tool
 * registry, the live sessions, and approvals for risky tools.
 */
const crypto = require('crypto');
const { Registry, core } = require('./tools.cjs');
const { runTurn, newSessionId, saveSession, messagesFromNote } = require('./agent.cjs');
const { stewardTransport } = require('../settings.cjs');

// where a turn to Steward comes from, told to him on its first line (the operator, 2026-11-04: "this is the pc" and
// "this is the phone"); the phone's channels are kept off the Agent tab's chat list (they are the Phone view's)
const SOURCES = { app: 'from the PC (Agent tab)', telegram: 'from the phone (Telegram)', whatsapp: 'from the phone (WhatsApp) — chat and research only, no changes', discord: 'from the phone (Discord)' };
const PHONE = ['telegram', 'whatsapp', 'discord'];
// a channel that is chat and research only (the operator, 2026-11-04: "WhatsApp doesn't have the approve/deny cards"):
// its turns never raise a card; any approval asked during one is answered No at once, kept in the history with this answer
const READ_ONLY = { whatsapp: 'no — WhatsApp is chat and research only' };
// what such a channel's reply says when something was refused
const NEEDS_APPROVAL = 'That needs approval — ask from the PC or Telegram.';
// a card raised from outside (askCard): Steward under his MCP host, for Manjuel and Aurora; answered No after 10 minutes
const OUTSIDE = 'Manjuel / MCP';
const CARD_TIMEOUT_MS = 600000;
// a scheduled automation's turn to Steward (schedules.cjs runSchedule, a schedule with backend steward): nobody is
// watching, so its cards go to the window, the Approvals shelf and Telegram like any other, and unanswered in
// CARD_TIMEOUT_MS they are answered No. An automation never approves itself.
const AUTOMATION = 'automation';

/** The line naming where a turn came from; an automation's names its schedule (schedules.cjs, backend steward). */
function sourceLine(source, automation) {
  if (source === AUTOMATION) return `from an automation (${String(automation || '').trim() || 'unnamed'})`;
  return SOURCES[source];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n) => String(n).padStart(2, '0');

/**
 * The time now, read from this machine's clock and zone (no time service), local with its offset and UTC (the
 * operator, 2026-11-05: "knowing UTC and local would be good, a system time check from jesster"), e.g.
 * "Thu 2026-11-05 09:12 local (UTC-07:00) | 16:12 UTC"; the UTC side names its day when that differs.
 */
function clockStamp(now = new Date()) {
  const off = -now.getTimezoneOffset();
  const zone = `UTC${off < 0 ? '-' : '+'}${two(Math.floor(Math.abs(off) / 60))}:${two(Math.abs(off) % 60)}`;
  const local = `${DAYS[now.getDay()]} ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  const sameDay = now.getUTCDate() === now.getDate();
  const utcDay = sameDay ? '' : `${DAYS[now.getUTCDay()]} ${now.getUTCFullYear()}-${two(now.getUTCMonth() + 1)}-${two(now.getUTCDate())} `;
  return `${local} local (${zone}) | ${utcDay}${two(now.getUTCHours())}:${two(now.getUTCMinutes())} UTC`;
}

/**
 * The text Steward is sent: a short line naming where it came from and the time it was sent (clockStamp, read fresh
 * each message), then the message (an improve: word stays first).
 */
function withSource(text, source, automation, now = new Date()) {
  const where = sourceLine(source, automation);
  if (!where) return text;
  const line = `${where} | ${clockStamp(now)}`;
  return /^\s*improve:/i.test(text) ? `${text}\n\n[${line}]` : `[${line}]\n${text}`;
}

class AgentService {
  /**
   * getVault(): the vault; getModel(): { host, model, maxSteps };
   * emit(channel, payload): to the window; extras(): system prompt pieces
   * (memory, skills index) added by later features; steward: { ensure, turn, up } (steward.cjs),
   * the agent of the Agent tab and of Telegram when getModel().backend is 'steward'.
   */
  constructor({ getVault, getModel, emit = () => {}, extras = () => [], steward = null, checker = null, threads = null, history = null, log = (line) => console.warn(line) }) {
    // one line in the console when a turn falls back from AG-UI to Responses
    this.log = log;
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
  approveInWindow(sessionId, onCard, { timeoutMs = 0, label = '' } = {}) {
    return (name, args, summary) => {
      const key = `${name}:${summary}`;
      if (this.alwaysAllow.has(key)) return Promise.resolve(true);
      const id = crypto.randomBytes(6).toString('hex');
      // an automation's card (label) says so on its first line, as askCard's do, and the history keeps the label
      const shown = label ? `[${label}]\n${summary}` : summary;
      this.emit('agent:approval', { id, sessionId, name, args, summary: shown });
      const answer = new Promise((resolve) => this.pending.set(id, { resolve, key, sessionId, name, args, summary: shown, at: Date.now(), ...(label ? { source: label } : {}) }));
      this.timeOut(id, timeoutMs);
      this.tellCard(onCard, { id, sessionId, name, args, summary: shown });
      return answer;
    };
  }

  /** A card nobody answers in `ms` is answered No (a timeout, kept in the history); 0 waits for ever, as the tab's. */
  timeOut(id, ms) {
    if (!ms) return;
    const timer = setTimeout(() => this.answerApproval(id, false, false, undefined, { where: 'window', timeout: true }), ms);
    timer.unref?.();
    const p = this.pending.get(id);
    if (p) p.timer = timer;
  }

  /**
   * A chat-and-research-only channel's approver (READ_ONLY): no card is raised anywhere (not the window, not the
   * chat); the request is answered No at once and kept in the history, and the session counts it for the reply.
   * `review` answers an improvement review: dropped.
   */
  refuseCards(s, source, review = false) {
    return (name, args, summary) => {
      s.refused = (s.refused || 0) + 1;
      const tool = review ? 'review' : name;
      const text = review ? `Improvement round: attempt ${name?.attempt ?? '?'}` : summary;
      this.answered({ id: crypto.randomBytes(6).toString('hex'), tool, summary: text, answer: READ_ONLY[source], where: source, time: new Date().toISOString() });
      return Promise.resolve(review ? 'drop' : false);
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
   * A card raised from outside the window: Steward under his MCP host (Manjuel's `maf` face, Aurora's ask_steward)
   * asks through SecondBrain's approval_ask (atlas.cjs). It is the same card as his Agent-tab ones, in the window, the
   * Approvals shelf and, with `onCard`, Telegram; its summary starts with its `source`, which the history keeps. No
   * answer in `timeoutMs` (10 minutes, as Telegram's cards) answers it No. Resolves { id, approved, answer }.
   */
  askCard({ name, args = {}, summary, sessionId = '', source = OUTSIDE, timeoutMs = CARD_TIMEOUT_MS, onCard } = {}) {
    const text = `[${source}]\n${summary || `${name} ${JSON.stringify(args, null, 2)}`}`;
    const key = `${name}:${text}`;
    if (this.alwaysAllow.has(key)) return Promise.resolve({ id: null, approved: true, answer: 'always' });
    const id = crypto.randomBytes(6).toString('hex');
    const card = { id, sessionId, name, args, summary: text, source };
    this.emit('agent:approval', card);
    const answer = new Promise((resolve) => this.pending.set(id, { resolve, key, sessionId, name, args, summary: text, source, full: true, at: Date.now() }));
    const timer = setTimeout(() => this.answerApproval(id, false, false, undefined, { where: 'window', timeout: true }), timeoutMs);
    timer.unref?.();
    this.tellCard(onCard, card);
    return answer.then((r) => (clearTimeout(timer), { id, ...r }));
  }

  /**
   * The improvement loop's review (step 6) on the window's own approval card (Kyle, 2026-11-02: "use what is
   * there"): Allow keeps the change, Deny drops it, and a message typed while it waits goes back to the fixer as
   * guidance. Resolves the reply text.
   */
  reviewInWindow(sessionId, onCard, { timeoutMs = 0 } = {}) {
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
      this.timeOut(id, timeoutMs);
      this.tellCard(onCard, { id, sessionId, name: 'review', kind: 'review', args: request || {}, summary });
      return answer;
    };
  }

  /** `fn(entry)` is told of every answered card, with the entry kept in the history. */
  onAnswered(fn) {
    this.answeredHooks.push(fn);
  }

  /**
   * Answer a waiting card. `where` is the place it was answered ('window' or a phone channel: 'telegram', 'whatsapp', 'discord'); `timeout` marks a card
   * nobody answered in time (answered No). The answer is kept in the history and told to onAnswered's listeners.
   */
  answerApproval(id, allow, always, text, { where = 'window', timeout = false } = {}) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    // the card is gone wherever it shows (the Agent tab, the Services window's Approvals)
    this.emit('agent:approval-done', { id, sessionId: p.sessionId });
    const guidance = typeof text === 'string' && text.trim() ? text.trim() : '';
    const answer = p.kind === 'review' ? (guidance ? 'guidance' : allow ? 'keep' : 'drop') : timeout ? 'timeout' : allow ? (always ? 'always' : 'allow') : 'deny';
    this.answered({ id, tool: p.name, summary: p.summary, answer, where, time: new Date().toISOString(), ...(p.source ? { source: p.source } : {}) });
    if (p.kind === 'review') {
      p.resolve(guidance || (allow ? 'keep' : 'drop'));
      return true;
    }
    if (allow && always) this.alwaysAllow.set(p.key, { name: p.name, summary: p.summary, at: Date.now() });
    // a card from outside (askCard) is told how it was answered, a timeout included
    p.resolve(p.full ? { approved: Boolean(allow), answer } : Boolean(allow));
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
    return [...this.pending].map(([id, p]) => ({ id, sessionId: p.sessionId, name: p.name, args: p.args, summary: p.summary, at: p.at, ...(p.kind ? { kind: p.kind } : {}), ...(p.source ? { source: p.source } : {}) }));
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
    const { text, sessionId, source = 'app', approve, only, onEvent, save = true, maxSteps, onCard, automation, cardTimeoutMs = CARD_TIMEOUT_MS } = request;
    const id = sessionId || newSessionId();
    const s = this.session(id);
    if (s.busy) {
      // a message typed while a card waits: the card is answered No (nothing runs, and his
      // workflow ends the run), and the message goes to him next, as a new request
      const waiting = [...this.pending].filter(([, p]) => p.sessionId === id);
      if (!waiting.length) throw new Error('this session is still working on the last message');
      // a message typed at a waiting review is its guidance (a No would drop the fixer's work)
      const review = waiting.find(([, p]) => p.kind === 'review');
      const how = { where: PHONE.includes(source) ? source : 'window' };
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
    // a chat-and-research-only channel (READ_ONLY): every approval of this turn is refused, and counted for its reply
    const readOnly = Boolean(READ_ONLY[source]);
    s.refused = 0;
    const result = (answer, extra = {}) => ({ sessionId: id, answer, ...extra, ...(s.refused ? { refused: s.refused, needsApproval: NEEDS_APPROVAL } : {}) });
    s.messages.push({ role: 'user', content: text });
    const { host, model, maxSteps: defaultSteps, backend } = this.getModel();
    const vault = this.getVault();
    const send = (e) => {
      this.emit('agent:event', { sessionId: id, ...e });
      onEvent?.(e);
    };
    send({ type: 'user', text, source });
    try {
      // the Agent tab and the phone (Telegram, Discord, ...) talk to Steward; so does a schedule with backend steward
      // (source AUTOMATION), whatever the tab's backend; other schedules and subagents keep the local loop for now
      if (source === AUTOMATION) {
        if (!this.steward) throw new Error('Steward is not set up in this SecondBrain, so a Steward automation cannot run.');
        return result(await this.askSteward(s, text, id, send, null, onCard, source, { name: automation, timeoutMs: cardTimeoutMs }));
      }
      if (this.steward && backend === 'steward' && (source === 'app' || PHONE.includes(source))) {
        return result(await this.askSteward(s, text, id, send, approve, onCard, source));
      }
      const answer = await runTurn({
        host,
        model,
        messages: s.messages,
        registry: this.registry,
        ctx: { vault, service: this, sessionId: id, source, signal: s.abort.signal, approve: readOnly ? this.refuseCards(s, source) : approve || this.approveInWindow(id) },
        onEvent: send,
        maxSteps: maxSteps || defaultSteps || 12,
        signal: s.abort.signal,
        system: await this.extras({ source }),
        only,
      });
      return result(answer);
    } catch (e) {
      const msg = e.name === 'AbortError' || e.message === 'stopped' ? 'Stopped.' : e.message;
      s.messages.push({ role: 'assistant', content: msg });
      send({ type: 'error', text: msg });
      return result(msg, { error: true });
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
  async askSteward(s, text, id, send, approve, onCard, source = 'app', automation = null) {
    // his service runs his MAF workflow, which keeps the plan and execute modes itself: the plan
    // comes as an approval request (a card), and the tab sends only the text
    // a conversation that starts with "improve:" is an improvement round (step 6): every turn of it names the loop
    if (!s.stewardPrevious && /^\s*improve:/i.test(text)) s.improve = true;
    // a chat-and-research-only channel (READ_ONLY): his approvals and reviews are refused at once, no card raised
    const readOnly = Boolean(READ_ONLY[source]);
    // an automation's turn (AUTOMATION): its cards are the window's, the shelf's and Telegram's, each saying it came
    // from the automation, answered No when nobody answers in time; never one it answers itself (no `approve`)
    const cards = automation ? { timeoutMs: automation.timeoutMs, label: sourceLine(source, automation.name) } : {};
    const approver = readOnly ? this.refuseCards(s, source) : onCard ? this.approveInWindow(id, onCard, cards) : (!automation && approve) || this.approveInWindow(id, undefined, cards);
    const said = withSource(text, source, automation && automation.name);
    // Settings' agent.transport 'ag-ui': the turn goes to his AG-UI host (agui.cjs), with the same cards; an improve
    // conversation stays on his service, whose review card has no AG-UI answer yet
    // AG-UI is the default (settings.cjs stewardTransport); its host down, the turn falls back to Responses, said once
    if (this.steward.agui && stewardTransport(this.getModel()) === 'ag-ui' && !s.improve) {
      let url = null;
      try {
        url = await this.steward.agui.ensure();
      } catch (e) {
        this.log(`[SecondBrain] steward: the AG-UI host (43122) is down (${e.message}); this turn goes over Responses (43120)`);
      }
      if (url) return this.askStewardAgui(s, text, id, send, approver, said, url);
    }
    const base = await this.steward.ensure();
    const r = await this.steward.turn({
      base,
      text: said,
      previous: s.stewardPrevious,
      approve: approver,
      review: readOnly ? this.refuseCards(s, source, true) : this.reviewInWindow(id, onCard, cards),
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

  /**
   * One turn with Steward over AG-UI (agui.cjs): his AG-UI host is started if needed, the thread is this conversation's
   * id and the history its own messages; his cards come to `approve` as askSteward's do, and the turn is kept in the
   * session note the same way.
   */
  async askStewardAgui(s, text, id, send, approve, said, url) {
    const { turn } = this.steward.agui;
    const r = await turn({ url, threadId: id, messages: s.messages.slice(0, -1), text: said, approve, onEvent: send, signal: s.abort.signal });
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

  /** Whether any conversation is mid-turn now (the Agent tab, the phone, an automation): an eval workflow waits for it. */
  busy() {
    return [...this.sessions.values()].some((s) => s.busy);
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

module.exports = { AgentService, withSource, sourceLine, clockStamp, AUTOMATION, SOURCES, PHONE, READ_ONLY, NEEDS_APPROVAL, OUTSIDE, CARD_TIMEOUT_MS };
