const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('./vaultfs.cjs');
const ig = require('./integrations.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-integrations-'));

/** A fetch that records requests and answers with server-sent events. */
function fakeFetch(events, { status = 200, json } = {}) {
  const seen = [];
  const fn = async (url, init = {}) => {
    const req = url instanceof Request ? url : new Request(url, init);
    const body = req.method === 'POST' ? await req.text() : '';
    seen.push({ url: req.url, headers: Object.fromEntries(req.headers), body: body ? JSON.parse(body) : null });
    if (json) return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    const text = events.map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${JSON.stringify(e.data)}\n\n`).join('');
    return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fn, seen };
}

test('Claude answers through the SDK, streamed, with the server-side fallback on', async () => {
  const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } };
  const { fn, seen } = fakeFetch([
    { event: 'message_start', data: { type: 'message_start', message: msg } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'From your ' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'notes.' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  const pieces = [];
  const text = await ig.chat({ provider: 'anthropic', key: 'sk-ant-test', model: 'claude-opus-5-5', system: 'brief', messages: [{ role: 'user', content: 'hi' }], onText: (t) => pieces.push(t), fetchFn: fn });
  assert.equal(text, 'From your notes.');
  assert.deepEqual(pieces, ['From your ', 'notes.']);
  const req = seen[0];
  assert.match(req.url, /api\.anthropic\.com\/v1\/messages/);
  assert.match(req.headers.authorization || req.headers['x-api-key'], /sk-ant-test/);
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(req.body.system, 'brief');
  assert.equal(req.body.stream, true);
});

test('ChatGPT and Gemini answer streamed, each in its own shape', async () => {
  const o = fakeFetch([{ data: { choices: [{ delta: { content: 'Hel' } }] } }, { data: { choices: [{ delta: { content: 'lo' } }] } }]);
  assert.equal(await ig.chat({ provider: 'openai', key: 'k', model: 'gpt-x', system: 'brief', messages: [{ role: 'user', content: 'hi' }], fetchFn: o.fn }), 'Hello');
  assert.deepEqual(o.seen[0].body.messages[0], { role: 'system', content: 'brief' });
  assert.equal(o.seen[0].headers.authorization, 'Bearer k');

  const g = fakeFetch([{ data: { candidates: [{ content: { parts: [{ text: 'Gem' }] } }] } }, { data: { candidates: [{ content: { parts: [{ text: 'ini' }] } }] } }]);
  const out = await ig.chat({ provider: 'google', key: 'gk', model: 'gemini-x', system: 'brief', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], fetchFn: g.fn });
  assert.equal(out, 'Gemini');
  assert.match(g.seen[0].url, /models\/gemini-x:streamGenerateContent\?alt=sse/);
  assert.equal(g.seen[0].headers['x-goog-api-key'], 'gk');
  assert.deepEqual(g.seen[0].body.contents.map((c) => c.role), ['user', 'model']);
  assert.equal(g.seen[0].body.systemInstruction.parts[0].text, 'brief');
});

test('no key or no model is said plainly, and an API error carries its message', async () => {
  await assert.rejects(ig.chat({ provider: 'openai', key: '', model: 'x', messages: [] }), /add a ChatGPT API key/);
  await assert.rejects(ig.chat({ provider: 'google', key: 'k', model: '', messages: [] }), /choose a Gemini model/);
  const bad = fakeFetch([], { status: 401, json: { error: { message: 'bad key' } } });
  await assert.rejects(ig.chat({ provider: 'openai', key: 'k', model: 'x', messages: [], fetchFn: bad.fn }), /OpenAI said 401: bad key/);
  const list = fakeFetch([], { json: { data: [{ id: 'gpt-a' }, { id: 'whisper-1' }, { id: 'o3' }] } });
  assert.deepEqual(await ig.listModels('openai', 'k', { fetchFn: list.fn }), ['o3', 'gpt-a']);
});

test('exchanges are kept in one capture note per model per day', () => {
  const v = new Vault(tmp());
  const now = new Date(2026, 9, 22, 14, 5);
  const id = ig.capture(v, { source: 'Claude', model: 'claude-opus-5-5', user: 'what next?', assistant: 'the dig', now });
  ig.capture(v, { source: 'Claude', model: 'claude-opus-5-5', user: 'and then?', assistant: 'distill', now });
  assert.equal(id, 'capture-2026-10-22-claude');
  const [n] = v.load();
  assert.equal(n.title, 'Claude — 2026-10-22');
  assert.deepEqual(n.tags, ['capture', 'claude']);
  assert.equal((n.content.match(/\*\*You:\*\*/g) || []).length, 2);
});

// ADR-0010 (Steward docs/decisions, 2026-11-05): notes are central in Jesster. The archive digger (archive.cjs,
// Settings → Archive digger, the Servers shelf's notes-kernel row) and Integrations' "their apps" writer of the whole
// notes kernel are retired; this goes red if either is wired back.
test('the archive digger and the whole-kernel app writer stay retired (ADR-0010)', () => {
  const handlers = [];
  ig.register({ ipcMain: { handle: (ch) => handlers.push(ch) }, guard: () => {}, getSettings: () => ({}), getVault: () => null, send: () => {} });
  assert.ok(handlers.includes('integrations:get'), 'integrations still registers its own calls');
  assert.ok(!handlers.includes('integrations:connect-app'), 'no connect-app');
  for (const gone of ['kernelServer', 'appConfigs', 'addServer', 'claudeCodeCommand']) assert.equal(ig[gone], undefined, `${gone} is retired`);
  assert.ok(!fs.existsSync(path.join(__dirname, 'archive.cjs')), 'archive.cjs is gone');
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  assert.ok(!/require\('\.\/archive\.cjs'\)/.test(main), 'main.cjs requires no archive digger');
  assert.ok(!/['"]archive:/.test(main + preload), 'no archive:* IPC in main or preload');
  assert.ok(!/id:\s*'notes-kernel'/.test(main), 'the Servers list has no notes-kernel row');
  assert.ok(!/connect-app/.test(preload), 'preload exposes no connect-app');
});

test('keys are masked for the page', () => {
  assert.equal(ig.mask('sk-ant-1234567890'), '••••7890');
  assert.equal(ig.mask(''), '');
});
