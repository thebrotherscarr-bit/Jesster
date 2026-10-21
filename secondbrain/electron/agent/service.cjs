/**
 * The agent service: one door for every way of talking to the agent — the
 * Agent tab, Telegram, scheduled automations, subagents. It owns the tool
 * registry, the live sessions, and approvals for risky tools.
 */
const crypto = require('crypto');
const { Registry, core } = require('./tools.cjs');
const { runTurn, newSessionId, saveSession, messagesFromNote } = require('./agent.cjs');

class AgentService {
  /**
   * getVault(): the vault; getModel(): { host, model, maxSteps };
   * emit(channel, payload): to the window; extras(): system prompt pieces
   * (memory, skills index) added by later features.
   */
  constructor({ getVault, getModel, emit = () => {}, extras = () => [] }) {
    this.getVault = getVault;
    this.getModel = getModel;
    this.emit = emit;
    this.extras = extras;
    this.registry = new Registry().add(core);
    this.sessions = new Map(); // id -> { messages, busy, abort }
    this.pending = new Map(); // approval id -> resolve
    this.alwaysAllow = new Set();
  }

  session(id) {
    if (!this.sessions.has(id)) {
      const note = this.getVault().load().find((n) => n.id === id);
      this.sessions.set(id, { messages: note ? messagesFromNote(note) : [], busy: false, abort: null });
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
  async ask({ text, sessionId, source = 'app', approve, only, onEvent, save = true, maxSteps }) {
    const id = sessionId || newSessionId();
    const s = this.session(id);
    if (s.busy) throw new Error('this session is still working on the last message');
    s.busy = true;
    s.abort = new AbortController();
    s.messages.push({ role: 'user', content: text });
    const { host, model, maxSteps: defaultSteps } = this.getModel();
    const vault = this.getVault();
    const send = (e) => {
      this.emit('agent:event', { sessionId: id, ...e });
      onEvent?.(e);
    };
    send({ type: 'user', text, source });
    try {
      const answer = await runTurn({
        host,
        model,
        messages: s.messages,
        registry: this.registry,
        ctx: { vault, service: this, sessionId: id, source, approve: approve || this.approveInWindow(id) },
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
