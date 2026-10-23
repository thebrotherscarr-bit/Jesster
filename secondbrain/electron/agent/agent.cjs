/**
 * The agent loop, Hermes-style: the model answers or asks for tools; tools
 * run and their results go back; repeat until it answers. Talks to Ollama's
 * /api/chat (gpt-oss supports tool calls). Every conversation is a session,
 * kept as a note in the vault (tag agent-session) so it is searchable later.
 */
const crypto = require('crypto');

const TIMEOUT_MS = 10 * 60 * 1000;

function systemPrompt(extra = []) {
  return [
    "You are SecondBrain, the user's local assistant. You run on their own PC through Ollama.",
    "Their notes are your memory of their work: search them before answering questions about their projects, and save what is worth keeping as notes.",
    'Use tools when they help; answer directly when they do not. Be concise. Cite notes by title.',
    `Now: ${new Date().toString()}.`,
    ...extra.filter(Boolean),
  ].join('\n\n');
}

async function chat(host, body, signal) {
  const url = `${String(host || 'http://localhost:11434').replace(/\/+$/, '')}/api/chat`;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === 'AbortError' && signal?.aborted) throw e;
    throw new Error(`Ollama at ${url} did not answer (${e.message}). Is Ollama running?`);
  }
  if (!r.ok) throw new Error(`Ollama: ${r.status} ${await r.text()}`);
  return r.json();
}

function args(call) {
  const a = call.function?.arguments;
  if (typeof a === 'string') {
    try {
      return JSON.parse(a);
    } catch {
      return {};
    }
  }
  return a || {};
}

/**
 * Run one user turn. `messages` is the conversation so far (without the
 * system prompt); it is extended in place. Events: step, tool, result,
 * answer. Returns the final answer text.
 */
async function runTurn({ host, model, messages, registry, ctx, onEvent = () => {}, maxSteps = 12, signal, system = [], only }) {
  const tools = registry.schemas(only);
  for (let step = 1; step <= maxSteps; step++) {
    onEvent({ type: 'step', step });
    const res = await chat(
      host,
      {
        model,
        messages: [{ role: 'system', content: systemPrompt(system) }, ...messages],
        tools,
        stream: false,
        keep_alive: '10m',
        options: { temperature: 0.3 },
      },
      signal
    );
    const msg = res.message || {};
    const calls = msg.tool_calls || [];
    messages.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      onEvent({ type: 'answer', text: msg.content || '' });
      return msg.content || '';
    }
    for (const call of calls) {
      const name = call.function?.name;
      const a = args(call);
      onEvent({ type: 'tool', name, args: a });
      const out = await registry.run(name, a, ctx);
      const text = typeof out === 'string' ? out : `Error: ${out.error}`;
      onEvent({ type: 'result', name, text: text.slice(0, 2000) });
      messages.push({ role: 'tool', tool_name: name, content: text });
      if (signal?.aborted) throw new Error('stopped');
    }
  }
  const text = `I stopped after ${maxSteps} steps without a final answer. Ask me to continue if you want me to keep going.`;
  messages.push({ role: 'assistant', content: text });
  onEvent({ type: 'answer', text });
  return text;
}

// ---- sessions as notes -------------------------------------------------

function newSessionId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `session-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${crypto.randomBytes(2).toString('hex')}`;
}

/** The readable transcript a session note holds (tool chatter summarised). */
function transcript(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push(`### You\n\n${m.content}`);
    else if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push(m.tool_calls.map((c) => `> used \`${c.function?.name}\` ${JSON.stringify(args(c)).slice(0, 200)}`).join('\n'));
    } else if (m.role === 'assistant' && m.content) out.push(`### SecondBrain\n\n${m.content}`);
  }
  return out.join('\n\n');
}

function saveSession(vault, id, messages, source = 'app') {
  const first = messages.find((m) => m.role === 'user')?.content || 'Agent session';
  const old = vault.load().find((n) => n.id === id);
  const now = Date.now();
  const note = {
    id,
    title: old?.title || `Agent: ${first.replace(/\s+/g, ' ').slice(0, 60)}`,
    content: transcript(messages),
    tags: ['agent-session', source],
    category: 'archives',
    isPinned: false,
    createdAt: old?.createdAt || now,
    updatedAt: now,
  };
  vault.save(note);
  return note;
}

/** The message list a session note can be continued from. */
function messagesFromNote(note) {
  const msgs = [];
  for (const part of String(note.content || '').split(/\n(?=### )/)) {
    const m = /^### (You|SecondBrain)\n\n([\s\S]*)$/.exec(part.trim());
    if (m) msgs.push({ role: m[1] === 'You' ? 'user' : 'assistant', content: m[2].replace(/\n\n> used [\s\S]*$/, '').trim() });
  }
  return msgs;
}

module.exports = { runTurn, chat, systemPrompt, newSessionId, transcript, saveSession, messagesFromNote };
