/**
 * The agent service: one door for every way of talking to the agent — the
 * Agent tab, Telegram, scheduled automations, subagents. It owns the tool
 * registry, the live sessions, and approvals for risky tools.
 */
const crypto = require('crypto');
const { Registry, core } = require('./tools.cjs');
const { runTurn, newSessionId, saveSession, messagesFromNote } = require('./agent.cjs');
const { PLANNING_RESPONSE } = require('./steward.cjs');

class AgentService {
  /**
   * getVault(): the vault; getModel(): { host, model, maxSteps };
   * emit(channel, payload): to the window; extras(): system prompt pieces
   * (memory, skills index) added by later features; steward: { ensure, turn } (steward.cjs),
   * the Agent tab's agent when getModel().backend is 'steward'.
   */
  constructor({ getVault, getModel, emit = () => {}, extras = () => [], steward = null, checker = null, threads = null }) {
    this.getVault = getVault;
    this.getModel = getModel;
    this.emit = emit;
    this.extras = extras;
    this.steward = steward;
    // checker({ turn, signal }) -> Claude's check of a Steward turn, or null while it is switched off
    this.checker = checker;
    // threads: { get(id), set(id, { previous, mode }) } (steward.cjs), so a conversation keeps
    // Steward's thread and mode across a restart
    this.threads = threads;
    this.registry = new Registry().add(core);
    this.sessions = new Map(); // id -> { messages, busy, abort }
    this.pending = new Map(); // approval id -> resolve
    this.alwaysAllow = new Set();
  }

  session(id) {
    if (!this.sessions.has(id)) {
      const note = this.getVault().load().find((n) => n.id === id);
      const thread = this.threads?.get(id);
      this.sessions.set(id, {
        messages: note ? messagesFromNote(note) : [],
        busy: false,
        abort: null,
        ...(thread ? { stewardPrevious: thread.previous, mode: thread.mode } : {}),
      });
    }
    return this.sessions.get(id);
  }

  /** Ask the window's user before a risky tool runs. */
  approveInWindow(sessionId) {
    return (name, args, summary) => {
      const key = `${name}:${summary}`;
      if (this.alwaysAllow.has(key)) return Promise.resolve(true);
      const id = crypto.randomBytes(6).toString('hex');
      this.emit('agent:approval', { id, sessionId, name, args, summary });
      return new Promise((resolve) => this.pending.set(id, { resolve, key }));
    };
  }

  answerApproval(id, allow, always) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (allow && always) this.alwaysAllow.add(p.key);
    p.resolve(Boolean(allow));
    return true;
  }

  /**
   * One user message → the agent's answer. `source` names where it came from
   * (app, telegram, schedule, subagent); `approve` overrides how risky tools
   * are confirmed; `only` limits the tools offered.
   */
  async ask({ text, sessionId, source = 'app', approve, only, onEvent, save = true, maxSteps, mode }) {
    const id = sessionId || newSessionId();
    const s = this.session(id);
    if (s.busy) throw new Error('this session is still working on the last message');
    if (mode) s.mode = mode;
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
      // the Agent tab talks to Steward; schedules and subagents keep the local loop for now
      if (this.steward && backend === 'steward' && source === 'app') {
        return { sessionId: id, answer: await this.askSteward(s, text, id, send, approve) };
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
      send({ type: 'done' });
    }
  }

  /**
   * One turn with Steward: his service is started if needed, the conversation continues from
   * this session's last response id, and his approval requests come to the window's cards.
   */
  async askSteward(s, text, id, send, approve) {
    const base = await this.steward.ensure();
    // plan mode, as the guide's console: the harness starts in plan, and the reply is asked for as
    // MAF's PlanningResponse (a clarification or an approval); Steward's mode_set calls move it
    const mode = s.mode || 'plan';
    const r = await this.steward.turn({ base, text, previous: s.stewardPrevious, approve: approve || this.approveInWindow(id), onEvent: send, signal: s.abort.signal, responseFormat: mode === 'plan' ? PLANNING_RESPONSE : null });
    s.stewardPrevious = r.previous;
    const set = r.calls.filter((c) => c.name === 'mode_set' && c.arguments?.mode).pop();
    s.mode = set ? String(set.arguments.mode).toLowerCase() : mode;
    this.threads?.set(id, { previous: s.stewardPrevious, mode: s.mode });
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

  list() {
    return this.getVault()
      .load()
      .filter((n) => n.tags.includes('agent-session'))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
      .map((n) => ({ id: n.id, title: n.title, updatedAt: n.updatedAt, source: n.tags.find((t) => t !== 'agent-session') }));
  }

  open(sessionId) {
    const s = this.session(sessionId);
    return { sessionId, busy: s.busy, messages: s.messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)) };
  }
}

module.exports = { AgentService };
