const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('./vaultfs.cjs');
const { Registry, core } = require('./agent/tools.cjs');
const memory = require('./agent/memory.cjs');
const atlas = require('./atlas.cjs');

test('the atlas-mcp entry carries the ground, the engine and a tool list', () => {
  const e = atlas.atlasServer({ exe: 'C:\\atlas\\atlas-mcp.exe', ground: '/g', python: 'py' });
  assert.equal(e.command, 'C:\\atlas\\atlas-mcp.exe');
  assert.deepEqual(e.args, ['--tenant', 'research=/g', '--tenant', `atlas=${path.join('/g', 'atlas')}`, '--default-project', 'research', '--manjuel', `py ${path.join('/g', 'manjuel.py')}`]);
  assert.equal(e.trusted, false);
  assert.ok(e.include.includes('ask_steward') && e.include.includes('remember'));
  assert.equal(atlas.atlasServer({ exe: 'x', ground: '/g', engine: false, all: true }).include, undefined);
  assert.ok(!atlas.atlasServer({ exe: 'x', ground: '/g', engine: false }).args.includes('--manjuel'));
  assert.throws(() => atlas.atlasServer({ ground: '/g' }), /atlas-mcp/);
  const merged = JSON.parse(atlas.withAtlas(JSON.stringify({ mcpServers: { other: { command: 'o' } } }), e));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['atlas', 'other']);
});

function setup() {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'share-')));
  vault.save({ id: 'plan', title: 'Launch plan', content: 'launch on the 14th', tags: [], category: 'projects', isPinned: false, createdAt: 1, updatedAt: 1 });
  const registry = new Registry().add(core).add(memory.tools);
  return { vault, registry, ctx: { vault } };
}

test('the notes are served over MCP: read-only unless writes are allowed', async () => {
  const { vault, registry, ctx } = setup();
  const init = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { registry, ctx });
  assert.equal(init.result.serverInfo.name, 'secondbrain');
  assert.equal(await atlas.handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, { registry, ctx }), null);
  const list = await atlas.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { registry, ctx });
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('search_notes') && names.includes('read_note'));
  assert.ok(!names.includes('write_note') && !names.includes('memory'), 'no writes while writes are off');
  assert.ok(names.includes('web_search') && names.includes('web_fetch'), "Steward reads the web through SecondBrain's tools");
  const found = await atlas.handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'launch' } } }, { registry, ctx });
  assert.match(found.result.content[0].text, /Launch plan/);
  const refused = await atlas.handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_note', arguments: { title: 'x', content: 'y' } } }, { registry, ctx });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /reads only/);
  const wrote = await atlas.handleMcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'write_note', arguments: { title: 'From Manjuel', content: 'hi' } } }, { registry, ctx, writes: true });
  assert.equal(wrote.result.isError, false);
  assert.ok(vault.load().some((n) => n.title === 'From Manjuel'));
  const nope = await atlas.handleMcp({ jsonrpc: '2.0', id: 6, method: 'prompts/list' }, { registry, ctx });
  assert.equal(nope.error.code, -32601);
});

test("Steward gets the long-term memory and the vault's skills (SEP-2640 resources)", async () => {
  const { vault, registry, ctx } = setup();
  vault.save(memory.skillNote('Release Check', 'Use before tagging a release.', '1. Run the suites.\n2. Read the changelog.'));
  const init = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { registry, ctx });
  assert.deepEqual(init.result.capabilities.resources, {});
  const writes = await atlas.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { registry, ctx, writes: true });
  const names = writes.result.tools.map((t) => t.name);
  assert.ok(names.includes('memory') && names.includes('skill_save'), 'memory and skill_save are writes');
  const kept = await atlas.handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory', arguments: { target: 'user', action: 'add', text: 'Kyle keeps commits small.' } } }, { registry, ctx, writes: true });
  assert.equal(kept.result.isError, false);
  assert.match(vault.load().find((n) => n.id === memory.IDS.user).content, /commits small/);
  const index = await atlas.handleMcp({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'skill://index.json' } }, { registry, ctx });
  const entry = JSON.parse(index.result.contents[0].text).skills[0];
  assert.deepEqual(entry, { name: 'release-check', type: 'skill-md', description: 'Use before tagging a release.', url: 'skill://release-check/SKILL.md' });
  const md = await atlas.handleMcp({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: entry.url } }, { registry, ctx });
  assert.match(md.result.contents[0].text, /^---\nname: release-check\ndescription: "Use before tagging a release."\n---\n\n1\. Run the suites\./);
  const missing = await atlas.handleMcp({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'skill://nope/SKILL.md' } }, { registry, ctx });
  assert.equal(missing.error.code, -32002);
});

test('agent_send types into the Agent tab and agent_read reads it back, only while writes are allowed', async () => {
  const { registry, ctx } = setup();
  const asked = [];
  const shown = [];
  const agent = {
    sessions: new Map(),
    ask: (o) => (asked.push(o), Promise.resolve({ sessionId: o.sessionId, answer: 'ok' })),
    open: (id) => ({ sessionId: id, busy: false, messages: [{ role: 'user', content: 'hello' }] }),
  };
  const withAgent = { ...ctx, agent, showAgent: (id) => shown.push(id) };
  const off = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { registry, ctx: withAgent });
  assert.ok(!off.result.tools.some((t) => t.name === 'agent_send'), 'not served while writes are off');
  const refused = await atlas.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_send', arguments: { text: 'hello' } } }, { registry, ctx: withAgent });
  assert.equal(refused.result.isError, true);
  assert.equal(asked.length, 0);
  const on = await atlas.handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { registry, ctx: withAgent, writes: true });
  assert.ok(on.result.tools.some((t) => t.name === 'agent_send') && on.result.tools.some((t) => t.name === 'agent_read'));
  const sent = await atlas.handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_send', arguments: { text: 'hello' } } }, { registry, ctx: withAgent, writes: true });
  assert.equal(sent.result.isError, false);
  const { session_id } = JSON.parse(sent.result.content[0].text);
  assert.deepEqual(asked, [{ text: 'hello', sessionId: session_id, source: 'app' }], 'sent as if typed in the tab');
  assert.deepEqual(shown, [session_id], 'the window opens the conversation');
  const read = await atlas.handleMcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_read', arguments: { session_id } } }, { registry, ctx: withAgent, writes: true });
  assert.equal(JSON.parse(read.result.content[0].text).messages[0].content, 'hello');
  agent.sessions.set(session_id, { busy: true });
  const busy = await atlas.handleMcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'agent_send', arguments: { text: 'again', session_id } } }, { registry, ctx: withAgent, writes: true });
  assert.equal(busy.result.isError, true);
  assert.equal(asked.length, 1);
});

test('the browser and computer use are served to Steward while they are switched on', async () => {
  const { registry, ctx } = setup();
  const off = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { registry, ctx });
  assert.ok(!off.result.tools.some((t) => t.name === 'browser_open'), 'switched off: not in the registry, not served');
  const clicked = [];
  registry.add([
    { name: 'browser_open', description: 'open', parameters: { type: 'object', properties: {} }, run: async () => 'Page: Google' },
    { name: 'browser_click', description: 'click', parameters: { type: 'object', properties: {} }, run: async (a) => (clicked.push(a.ref), 'Clicked') },
    { name: 'computer_task', description: 'desktop', parameters: { type: 'object', properties: {} }, run: async () => 'Did it' },
  ]);
  const on = await atlas.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { registry, ctx });
  const names = on.result.tools.map((t) => t.name);
  assert.ok(['browser_open', 'browser_click', 'computer_task'].every((n) => names.includes(n)));
  const out = await atlas.handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_click', arguments: { ref: '4' } } }, { registry, ctx });
  assert.equal(out.result.isError, false);
  assert.deepEqual(clicked, ['4']);
  const desk = await atlas.handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'computer_task', arguments: { task: 'x' } } }, { registry, ctx });
  assert.equal(desk.result.content[0].text, 'Did it');
});

/** The Estate as the app hands it in (main.cjs estateDeps), every outside act recorded instead of done. */
function fakeEstate({ sitting = '' } = {}) {
  const services = require('./services.cjs');
  const seen = { controls: [], unloads: [], applied: 0, logLines: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estate-'));
  const log = path.join(dir, 'steward.log');
  fs.writeFileSync(log, Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const svc = (id, port, pid) => ({
    id,
    label: id,
    port,
    pid: () => pid,
    started: () => (pid ? '2026-11-04T09:00:00.000Z' : null),
    logPath: () => log,
    start: async () => seen.controls.push(`${id} start`),
    stop: async () => seen.controls.push(`${id} stop`),
    restart: async () => seen.controls.push(`${id} restart`),
  });
  const servers = services.registry([svc('steward', 43120, 4120), { ...svc('door', 43111, process.pid) }, svc('ollama', 11434, null)], { probe: async (p) => p !== 11434 });
  const realLog = servers.log;
  servers.log = (id, lines) => (seen.logLines.push(lines), realLog(id, lines));
  return {
    seen,
    estate: {
      servers,
      buildInfo: () => ({ build: 51, commit: 'abc', branch: 'main' }),
      check: async () => ({ current: { build: 51 }, latest: { build: 52 }, available: true, canApply: true }),
      apply: async () => (seen.applied++, { updated: true, to: 52 }),
      sitting: () => sitting,
      history: { read: (n) => Array.from({ length: Math.min(n, 300) }, (_, i) => ({ id: `c${i}` })) },
      ollama: {
        version: async () => ({ version: '0.12.9' }),
        ps: async () => ({ models: [{ name: 'steward:4', size_vram: 9, expires_at: 'later' }] }),
        unload: async (model) => (seen.unloads.push(model), { done_reason: 'unload' }),
      },
    },
  };
}

test("Steward sees the Estate: estate_status, estate_logs, approvals_history and app_update's check as reads; service_control, ollama_unload and app_update's apply only while writes are allowed", async () => {
  const { registry, ctx } = setup();
  const { estate, seen } = fakeEstate();
  const withEstate = { ...ctx, estate };
  const call = (name, args, writes = false) => atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { registry, ctx: withEstate, writes });
  const text = (r) => r.result.content[0].text;

  const ro = (await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { registry, ctx: withEstate })).result.tools;
  const roNames = ro.map((t) => t.name);
  assert.ok(['estate_status', 'estate_logs', 'approvals_history', 'app_update'].every((n) => roNames.includes(n)));
  assert.ok(!roNames.includes('service_control') && !roNames.includes('ollama_unload'), 'no writes while writes are off');
  const rw = (await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { registry, ctx: withEstate, writes: true })).result.tools;
  const byName = Object.fromEntries(rw.map((t) => [t.name, t]));
  for (const n of ['service_control', 'ollama_unload', 'app_update']) assert.equal(byName[n].annotations.readOnlyHint, false, `${n} is marked a write`);
  for (const n of ['estate_status', 'estate_logs', 'approvals_history']) assert.equal(byName[n].annotations.readOnlyHint, true, `${n} is marked a read`);
  assert.ok(atlas.WRITE_TOOLS.includes('service_control') && atlas.WRITE_TOOLS.includes('ollama_unload'));
  const without = (await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { registry, ctx })).result.tools.map((t) => t.name);
  assert.ok(!without.includes('estate_status'), 'not listed where the app hands no Estate in');

  const st = JSON.parse(text(await call('estate_status', {})));
  assert.deepEqual(st.services.map((s) => [s.name, s.port, s.up, s.pid, s.started]), [
    ['steward', 43120, true, 4120, '2026-11-04T09:00:00.000Z'],
    ['door', 43111, true, process.pid, '2026-11-04T09:00:00.000Z'],
    ['ollama', 11434, false, null, null],
  ]);
  assert.deepEqual(st.secondbrain.build, { build: 51, commit: 'abc', branch: 'main' });
  assert.deepEqual(st.ollama, { up: true, version: '0.12.9', models: [{ name: 'steward:4', size_vram: 9, expires_at: 'later' }] });
  assert.deepEqual(st.sitting, { open: false });

  const logs = JSON.parse(text(await call('estate_logs', { service: 'steward', lines: 5000 })));
  assert.equal(logs.text.split('\n').length, 400, 'at most 400 lines');
  assert.equal(logs.text.split('\n').at(-1), 'line 600');
  assert.deepEqual(seen.logLines, [400]);
  assert.equal((await call('estate_logs', { service: 'nope' })).result.isError, true);

  assert.equal(JSON.parse(text(await call('approvals_history', { limit: 9999 }))).length, 200, 'at most 200');
  assert.equal(JSON.parse(text(await call('app_update', { action: 'check' }))).available, true, 'check is a read');

  for (const [name, args] of [['service_control', { service: 'steward', action: 'restart' }], ['ollama_unload', { model: 'steward:4' }], ['app_update', { action: 'apply' }]]) {
    const r = await call(name, args);
    assert.equal(r.result.isError, true, `${name} refused while reads only`);
    assert.match(text(r), /reads only/);
  }
  assert.deepEqual([seen.controls, seen.unloads, seen.applied], [[], [], 0], 'nothing ran');

  assert.equal((await call('service_control', { service: 'steward', action: 'restart' }, true)).result.isError, false);
  assert.deepEqual(seen.controls, ['steward restart'], "the shelf's own control path");
  assert.match(text(await call('service_control', { service: 'SecondBrain', action: 'restart' }, true)), /not started or stopped by its own tools/);
  assert.deepEqual(JSON.parse(text(await call('ollama_unload', { model: 'steward:4' }, true))), { model: 'steward:4', unloaded: true, done_reason: 'unload' });
  assert.deepEqual(seen.unloads, ['steward:4']);
  assert.deepEqual(JSON.parse(text(await call('app_update', { action: 'apply' }, true))), { updated: true, to: 52 });

  const none = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estate_status', arguments: {} } }, { registry, ctx });
  assert.match(none.result.content[0].text, /not served here/);
});

test('service_control never stops the door while a Manjuel sitting is open (RULE 9)', async () => {
  const { registry, ctx } = setup();
  const { estate, seen } = fakeEstate({ sitting: '112' });
  const call = (args) => atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'service_control', arguments: args } }, { registry, ctx: { ...ctx, estate }, writes: true });
  for (const action of ['stop', 'restart']) {
    const r = await call({ service: 'door', action });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /Sitting 112 is open.*RULE 9/);
  }
  assert.deepEqual(seen.controls, []);
  const st = JSON.parse((await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estate_status', arguments: {} } }, { registry, ctx: { ...ctx, estate } })).result.content[0].text);
  assert.deepEqual(st.sitting, { open: true, n: '112' });
});

test("ollama_unload asks Ollama's own API: POST /api/generate with keep_alive 0", async () => {
  const http = require('http');
  const estate = require('./estate.cjs');
  const got = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, body: b ? JSON.parse(b) : null });
      res.end(JSON.stringify(req.url === '/api/version' ? { version: '0.12.9' } : { done: true, done_reason: 'unload' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = estate.ollamaApi(server.address().port);
  assert.deepEqual(await api.unload('steward:4'), { done: true, done_reason: 'unload' });
  assert.deepEqual(await api.version(), { version: '0.12.9' });
  server.close();
  assert.deepEqual(got[0], { method: 'POST', url: '/api/generate', body: { model: 'steward:4', keep_alive: 0 } });
  assert.deepEqual([got[1].method, got[1].url], ['GET', '/api/version']);
  assert.equal(estate.ollama.unload.length, 1);
});

test('the bearer key is checked in constant time and never optional', () => {
  assert.equal(atlas.keyOk('Bearer abc123', 'abc123'), true);
  assert.equal(atlas.keyOk('Bearer abc124', 'abc123'), false);
  assert.equal(atlas.keyOk('', 'abc123'), false);
  assert.equal(atlas.keyOk('Bearer ', ''), false);
});
