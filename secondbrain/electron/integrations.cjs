/**
 * Integrations: Claude, ChatGPT and Gemini, both ways.
 *
 *  In:  with your API keys, each model answers in the app (Ask Brain), briefed
 *       from your notes like the local model, and every exchange is kept in
 *       today's capture note for that model, so it is searchable later.
 *  Out: their own apps can use your notes. Claude Desktop and Gemini CLI get
 *       the notes kernel as an MCP server in their config file; Claude Code
 *       gets the one command that adds it.
 *
 * Keys live in the app's settings file in your profile (never in the vault,
 * never sent to the page). Calls run here, in the main process.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findCli } = require('./archive.cjs');
const { parseFile, renderFile } = require('./vaultfs.cjs');

const PROVIDERS = {
  anthropic: { label: 'Claude', defaultModel: 'claude-opus-5-5' },
  openai: { label: 'ChatGPT', defaultModel: '' },
  google: { label: 'Gemini', defaultModel: '' },
};
// models that take Anthropic's server-side fallback on a refusal
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const MAX_TOKENS = 16000;

function mask(key) {
  return key ? `••••${String(key).slice(-4)}` : '';
}

// ---------------------------------------------------------------- models --

/** Server-sent events from a fetch response, one parsed `data:` object at a time. */
async function* sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* a keep-alive or a partial line */
      }
    }
  }
}

async function failed(res, who) {
  let detail = '';
  try {
    const j = await res.json();
    detail = (j.error && (j.error.message || j.error.status)) || JSON.stringify(j).slice(0, 200);
  } catch {
    detail = res.statusText;
  }
  return new Error(`${who} said ${res.status}: ${detail}`);
}

function anthropicClient(key, fetchFn) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  return new Anthropic({ apiKey: key, ...(fetchFn ? { fetch: fetchFn } : {}) });
}

/** The models a key can use, newest naming first. */
async function listModels(provider, key, { fetchFn = fetch } = {}) {
  if (!key) throw new Error(`add a ${PROVIDERS[provider].label} API key first`);
  if (provider === 'anthropic') {
    const out = [];
    for await (const m of anthropicClient(key, fetchFn).models.list()) out.push(m.id);
    return out;
  }
  if (provider === 'openai') {
    const res = await fetchFn('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw await failed(res, 'OpenAI');
    const j = await res.json();
    return j.data.map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id)).sort().reverse();
  }
  if (provider === 'google') {
    const res = await fetchFn('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw await failed(res, 'Gemini');
    const j = await res.json();
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((id) => id.startsWith('gemini'));
  }
  throw new Error(`not a provider: ${provider}`);
}

/**
 * One answer, streamed: onText gets each piece; the whole text comes back.
 * messages: [{ role: 'user' | 'assistant', content: string }]
 */
async function chat({ provider, key, model, system, messages, onText = () => {}, signal, fetchFn = fetch }) {
  if (!key) throw new Error(`add a ${PROVIDERS[provider].label} API key in Integrations first`);
  if (!model) throw new Error(`choose a ${PROVIDERS[provider].label} model in Integrations first`);
  let text = '';
  const add = (t) => {
    if (!t) return;
    text += t;
    onText(t);
  };

  if (provider === 'anthropic') {
    const params = { model, max_tokens: MAX_TOKENS, messages };
    if (system) params.system = system;
    if (FALLBACK_MODELS.has(model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    const stream = anthropicClient(key, fetchFn).beta.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') add(event.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') add(`\n\n*Claude declined this request${final.stop_details && final.stop_details.category ? ` (${final.stop_details.category})` : ''}.*`);
    else if (final.stop_reason === 'max_tokens') add('\n\n*(cut off at the length limit)*');
    return text;
  }

  if (provider === 'openai') {
    const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] }),
    });
    if (!res.ok) throw await failed(res, 'OpenAI');
    for await (const e of sse(res)) add(e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.content);
    return text;
  }

  if (provider === 'google') {
    const res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      signal,
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      }),
    });
    if (!res.ok) throw await failed(res, 'Gemini');
    for await (const e of sse(res)) {
      const parts = (e.candidates && e.candidates[0] && e.candidates[0].content && e.candidates[0].content.parts) || [];
      for (const p of parts) add(p.text);
    }
    return text;
  }
  throw new Error(`not a provider: ${provider}`);
}

// --------------------------------------------------------------- capture --

/** Keep one exchange in today's capture note for that model (the kernel's capture.append shape). */
function capture(vault, { source, model, user, assistant, now = new Date() }) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const src = String(source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  const id = `capture-${day}-${src}`;
  const entry = `### ${pad(now.getHours())}:${pad(now.getMinutes())}${model ? ` · ${model}` : ''}\n\n**You:** ${String(user || '').trim()}\n\n**${model || source}:** ${String(assistant || '').trim()}\n`;
  const file = vault.file(id);
  let note;
  if (fs.existsSync(file)) {
    note = parseFile(fs.readFileSync(file, 'utf8'), id, fs.statSync(file).mtimeMs);
    note.content = `${note.content.trimEnd()}\n\n${entry}`;
    note.updatedAt = now.getTime();
  } else {
    note = { id, title: `${source} — ${day}`, content: entry, category: 'inbox', tags: ['capture', src], isPinned: false, createdAt: now.getTime(), updatedAt: now.getTime() };
  }
  fs.writeFileSync(`${file}.tmp`, renderFile(note), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return id;
}

// ------------------------------------------------------- their apps, out --

/** The notes kernel as an MCP server entry: the same one Manjuel and Claude Code use. */
function kernelServer({ python = 'python', cli, vaultDir }) {
  return { command: python, args: [cli, '--vault', vaultDir, 'mcp'] };
}

function appConfigs(home = os.homedir(), platform = process.platform, env = process.env) {
  const claudeDir =
    platform === 'win32'
      ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Claude')
        : path.join(home, '.config', 'Claude');
  return {
    claudeDesktop: { label: 'Claude Desktop', file: path.join(claudeDir, 'claude_desktop_config.json') },
    gemini: { label: 'Gemini CLI', file: path.join(home, '.gemini', 'settings.json') },
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON; fix or move it first (${e.message})`);
  }
}

/** Is `name` in that app's mcpServers? */
function hasServer(file, name) {
  try {
    return Boolean((readJson(file).mcpServers || {})[name]);
  } catch {
    return false;
  }
}

/** Put the server in the app's config, keeping everything else; the old file is kept as .bak. */
function addServer(file, name, entry) {
  const cfg = readJson(file);
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
  }
  cfg.mcpServers = { ...(cfg.mcpServers || {}), [name]: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return { file, backup };
}

function quote(s) {
  return /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s;
}

function claudeCodeCommand(server) {
  return `claude mcp add --scope user secondbrain -- ${[server.command, ...server.args].map(quote).join(' ')}`;
}

// ------------------------------------------------------------------- IPC --

function register({ ipcMain, guard, getSettings, getVault, vaultDir, send }) {
  const running = new Map();
  const cfg = () => getSettings().get('integrations');
  const server = () => {
    const a = getSettings().get('archive');
    const cli = findCli(a.cli, vaultDir());
    return cli ? kernelServer({ python: a.python || 'python', cli, vaultDir: vaultDir() }) : null;
  };
  const view = () => {
    const c = cfg();
    const s = server();
    const apps = appConfigs();
    return {
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, hasKey: Boolean(c[id].key), key: mask(c[id].key), model: c[id].model || p.defaultModel })),
      capture: c.capture !== false,
      kernel: s,
      apps: Object.entries(apps).map(([id, a]) => ({ id, label: a.label, file: a.file, connected: hasServer(a.file, 'secondbrain') })),
      claudeCode: s ? claudeCodeCommand(s) : null,
    };
  };
  const handle = (name, fn) =>
    ipcMain.handle(name, (event, ...args) => {
      guard(event);
      return fn(...args);
    });

  handle('integrations:get', () => view());
  handle('integrations:set', (provider, patch) => {
    if (provider === 'capture') {
      getSettings().set('integrations', { capture: Boolean(patch) });
      return view();
    }
    if (!PROVIDERS[provider] || !patch || typeof patch !== 'object') throw new Error('not a setting');
    const next = {};
    if (typeof patch.key === 'string' && !patch.key.startsWith('••••')) next.key = patch.key.trim();
    if (typeof patch.model === 'string') next.model = patch.model.trim();
    getSettings().set('integrations', { [provider]: next });
    return view();
  });
  handle('integrations:models', (provider) => listModels(provider, PROVIDERS[provider] && cfg()[provider].key));
  handle('integrations:chat', async (id, req) => {
    const c = cfg();
    const p = req && PROVIDERS[req.provider];
    if (!p) throw new Error('not a provider');
    const model = req.model || c[req.provider].model || p.defaultModel;
    const ctl = new AbortController();
    running.set(id, ctl);
    try {
      const text = await chat({
        provider: req.provider,
        key: c[req.provider].key,
        model,
        system: req.system,
        messages: req.messages,
        signal: ctl.signal,
        onText: (t) => send('integrations:chunk', { id, text: t }),
      });
      if (c.capture !== false && req.capture !== false) {
        const last = [...req.messages].reverse().find((m) => m.role === 'user');
        capture(getVault(), { source: p.label, model, user: req.question || (last && last.content), assistant: text });
        send('vault:changed');
      }
      return { text, model };
    } finally {
      running.delete(id);
    }
  });
  handle('integrations:stop', (id) => {
    const ctl = running.get(id);
    if (ctl) ctl.abort();
  });
  handle('integrations:connect-app', (appId) => {
    const s = server();
    if (!s) throw new Error('the notes kernel (notes/cli.py) was not found: set it in Settings → Archive digger');
    const app = appConfigs()[appId];
    if (!app) throw new Error('not an app');
    const r = addServer(app.file, 'secondbrain', s);
    return { ...view(), wrote: r };
  });
}

module.exports = { PROVIDERS, listModels, chat, capture, kernelServer, appConfigs, addServer, hasServer, claudeCodeCommand, register, mask };
