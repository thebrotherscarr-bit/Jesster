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

// Steward under his MCP host (Manjuel's maf face, Aurora's ask_steward) asks his cards here: approval_ask
function cardService() {
  const { AgentService } = require('./agent/service.cjs');
  const { vault } = setup();
  const shown = [];
  const kept = [];
  const service = new AgentService({ getVault: () => vault, getModel: () => ({}), emit: (channel, e) => channel === 'agent:approval' && shown.push(e), history: { append: (e) => kept.push(e) } });
  return { service, shown, kept };
}
const askCard = (ctx, id, extra = {}) =>
  atlas.handleMcp(
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'approval_ask', arguments: { tool: 'write_file', arguments: { path: 'a.txt' }, session_id: 'manjuel-1', ...extra } } },
    { registry: setup().registry, ctx },
  );
const settled = async (shown, n = 1) => {
  while (shown.length < n) await new Promise((r) => setImmediate(r));
};

test('approval_ask raises one card in SecondBrain, tagged Manjuel / MCP, and Allow comes back approved', async () => {
  const { service, shown, kept } = cardService();
  const phone = [];
  const ctx = { ...setup().ctx, agent: service, phoneCard: (card) => phone.push(card) };
  const off = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { registry: setup().registry, ctx });
  assert.ok(off.result.tools.some((t) => t.name === 'approval_ask'), 'served while writes are off: it only asks');
  const call = askCard(ctx, 2);
  await settled(shown);
  assert.equal(shown.length, 1, 'one card');
  assert.equal(shown[0].source, 'Manjuel / MCP');
  assert.match(shown[0].summary, /^\[Manjuel \/ MCP\]\nwrite_file /);
  assert.deepEqual(service.cards().map((c) => [c.name, c.sessionId, c.source]), [['write_file', 'manjuel-1', 'Manjuel / MCP']], 'on the Approvals shelf');
  assert.deepEqual(phone.map((c) => c.id), [shown[0].id], 'and on the phone');
  assert.equal(service.answerApproval(shown[0].id, true, false), true);
  const r = await call;
  assert.equal(r.result.isError, false);
  assert.deepEqual(JSON.parse(r.result.content[0].text), { id: shown[0].id, approved: true, answer: 'allow' });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, 'Manjuel / MCP', 'kept in the approvals history with its source');
  assert.equal(kept[0].answer, 'allow');
});

test('approval_ask: Deny comes back not approved', async () => {
  const { service, shown, kept } = cardService();
  const call = askCard({ ...setup().ctx, agent: service }, 3);
  await settled(shown);
  service.answerApproval(shown[0].id, false, false);
  const r = await call;
  assert.deepEqual(JSON.parse(r.result.content[0].text), { id: shown[0].id, approved: false, answer: 'deny' });
  assert.equal(kept[0].answer, 'deny');
  assert.equal(service.cards().length, 0);
});

test('approval_ask: no answer in 10 minutes is No', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { service, shown, kept } = cardService();
  const call = askCard({ ...setup().ctx, agent: service }, 4);
  await settled(shown);
  t.mock.timers.tick(600000 - 1);
  assert.equal(service.cards().length, 1, 'still waiting just before 10 minutes');
  t.mock.timers.tick(1);
  const r = await call;
  assert.deepEqual(JSON.parse(r.result.content[0].text), { id: shown[0].id, approved: false, answer: 'timeout' });
  assert.equal(kept[0].answer, 'timeout');
  assert.equal(service.cards().length, 0);
});

test('approval_ask is refused with no Agent, and needs the tool', async () => {
  const none = await askCard(setup().ctx, 5);
  assert.equal(none.result.isError, true);
  const { service } = cardService();
  const bare = await atlas.handleMcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'approval_ask', arguments: {} } }, { registry: setup().registry, ctx: { agent: service } });
  assert.equal(bare.result.isError, true);
  assert.equal(service.cards().length, 0);
});

// ---- MCP 2026-07-28 beside 2025-06-18 (mcpversion.cjs) -----------------------------------------

const mcpv = require('./mcpversion.cjs');
const META = (version = '2026-07-28') => mcpv.requestMeta({ name: 'test-client', version: '0' }, {}, version);

test('a 2026-07-28 client lists and calls tools with no initialize: resultType, serverInfo, cache hints, no ping', async () => {
  const { registry, ctx } = setup();
  const disc = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META() } }, { registry, ctx });
  assert.equal(disc.result.resultType, 'complete');
  assert.deepEqual(disc.result.supportedVersions, mcpv.SUPPORTED);
  assert.ok(disc.result.supportedVersions.includes('2026-07-28') && disc.result.supportedVersions.includes('2025-06-18'));
  assert.deepEqual(disc.result.capabilities, { tools: {}, resources: {} });
  assert.equal(disc.result._meta['io.modelcontextprotocol/serverInfo'].name, 'secondbrain');
  assert.match(disc.result.instructions, /SecondBrain notes vault/);
  assert.equal(disc.result.cacheScope, 'private');
  const list = await atlas.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: META() } }, { registry, ctx });
  assert.equal(list.result.resultType, 'complete');
  assert.equal(list.result.ttlMs, 0);
  assert.equal(list.result.cacheScope, 'private');
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('search_notes') && !names.includes('write_note'));
  const again = await atlas.handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: META() } }, { registry, ctx });
  assert.deepEqual(again.result.tools.map((t) => t.name), names, 'the same order every time (deterministic tools/list)');
  const found = await atlas.handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'launch' }, _meta: META() } }, { registry, ctx });
  assert.equal(found.result.resultType, 'complete');
  assert.match(found.result.content[0].text, /Launch plan/);
  assert.equal(found.result.ttlMs, undefined, 'a call result is not cacheable');
  const ping = await atlas.handleMcp({ jsonrpc: '2.0', id: 5, method: 'ping', params: { _meta: META() } }, { registry, ctx });
  assert.equal(ping.error.code, -32601, 'ping is removed in 2026-07-28');
  const missing = await atlas.handleMcp({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'skill://nope/SKILL.md', _meta: META() } }, { registry, ctx });
  assert.equal(missing.error.code, -32602, '2026-07-28 resource not found is Invalid Params');
});

test('an unknown version is -32022 with the supported list; a missing envelope key is -32602', async () => {
  const { registry, ctx } = setup();
  const bad = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META('1900-01-01') } }, { registry, ctx });
  assert.equal(bad.error.code, -32022);
  assert.deepEqual(bad.error.data, { supported: mcpv.SUPPORTED, requested: '1900-01-01' });
  const noCaps = await atlas.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, { registry, ctx });
  assert.equal(noCaps.error.code, -32602);
});

test('the legacy flow still works: initialize negotiates a 2025 version, ping answers, no resultType', async () => {
  const { registry, ctx } = setup();
  const init = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }, { registry, ctx });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal((await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, { registry, ctx })).result.protocolVersion, '2025-11-25');
  assert.equal((await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, { registry, ctx })).result.protocolVersion, '2025-06-18');
  assert.deepEqual((await atlas.handleMcp({ jsonrpc: '2.0', id: 2, method: 'ping' }, { registry, ctx })).result, {});
  const list = await atlas.handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { registry, ctx });
  assert.equal(list.result.resultType, undefined, 'a legacy answer is as it was');
  assert.ok(list.result.tools.some((t) => t.name === 'search_notes'));
});

test('POST /mcp over HTTP: the header rung, 400 for a version or header refusal, 404 for an unknown method, legacy at 200', async () => {
  const { registry, ctx } = setup();
  const h = (method, version = '2026-07-28', name) => ({ 'mcp-protocol-version': version, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) });
  const listed = await atlas.serveMcpHttp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META() } }, h('tools/list'), { registry, ctx });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.result.resultType, 'complete');
  const called = await atlas.serveMcpHttp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'launch' }, _meta: META() } }, h('tools/call', '2026-07-28', 'search_notes'), { registry, ctx });
  assert.equal(called.status, 200);
  assert.match(called.body.result.content[0].text, /Launch plan/);
  const b64 = await atlas.serveMcpHttp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'launch' }, _meta: META() } }, h('tools/call', '2026-07-28', `=?base64?${Buffer.from('search_notes').toString('base64')}?=`), { registry, ctx });
  assert.equal(b64.status, 200, 'Mcp-Name is decoded before it is compared');
  const wrongName = await atlas.serveMcpHttp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_notes', arguments: {}, _meta: META() } }, h('tools/call', '2026-07-28', 'read_note'), { registry, ctx });
  assert.equal(wrongName.status, 400);
  assert.equal(wrongName.body.error.code, -32020);
  const noHeader = await atlas.serveMcpHttp({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: META() } }, {}, { registry, ctx });
  assert.equal(noHeader.body.error.code, -32020);
  const old = await atlas.serveMcpHttp({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: META('1900-01-01') } }, h('tools/list', '1900-01-01'), { registry, ctx });
  assert.equal(old.status, 400);
  assert.equal(old.body.error.code, -32022);
  const unknown = await atlas.serveMcpHttp({ jsonrpc: '2.0', id: 6, method: 'prompts/list', params: { _meta: META() } }, h('prompts/list'), { registry, ctx });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, -32601);
  const legacy = await atlas.serveMcpHttp({ jsonrpc: '2.0', id: 7, method: 'prompts/list' }, { 'mcp-protocol-version': '2025-06-18' }, { registry, ctx });
  assert.equal(legacy.status, 200, 'a legacy error rides a 200 as before');
  const note = await atlas.serveMcpHttp({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}, { registry, ctx });
  assert.deepEqual(note, { status: 202, body: null });
});

/** Steward's folder with the eval set files and run-bar.ps1, and the eval tools' outside acts recorded instead of done. */
function fakeEvals({ running = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-evals-'));
  const evalsDir = path.join(dir, 'harness', 'steward', 'evals');
  fs.mkdirSync(evalsDir, { recursive: true });
  fs.writeFileSync(path.join(evalsDir, 'run-bar.ps1'), 'param()\r\n');
  fs.writeFileSync(path.join(evalsDir, 't0-small.yaml'), '# T0\r\nname: small\r\ntier: T0\r\n');
  fs.writeFileSync(path.join(evalsDir, 'ext-aider-py.yaml'), '# EXT\r\nname: aider-py\r\ntier: ext\r\n');
  fs.writeFileSync(path.join(evalsDir, 'README.md'), 'name: notaset\n');
  const seen = { launched: [], asked: 0 };
  return {
    dir,
    seen,
    evals: {
      dir: () => dir,
      running: async () => (seen.asked++, running),
      launch: async (spec) => (seen.launched.push(spec), { pid: 4242 }),
    },
  };
}

test('eval_start starts run-bar.ps1 for known sets only, never while an eval runs, and never on a card; eval_status reads its progress', async () => {
  const { registry, ctx } = setup();
  const { estate } = fakeEstate();
  const { dir, seen, evals } = fakeEvals();
  const withEvals = { ...ctx, estate: { ...estate, evals } };
  const call = (name, args) => atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { registry, ctx: withEvals });
  const text = (r) => r.result.content[0].text;

  // served while writes are off, as the Estate's reads are: an automation's turn never needs a card for it
  const tools = (await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { registry, ctx: withEvals })).result.tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.ok(byName.eval_start && byName.eval_status, 'listed with the reads');
  assert.ok(atlas.ESTATE_READ_TOOLS.includes('eval_start') && !atlas.WRITE_TOOLS.includes('eval_start'));
  assert.match(byName.eval_start.description, /bounded Estate action/);
  assert.equal(byName.eval_status.annotations.readOnlyHint, true);

  for (const [args, why] of [
    [{ sets: ['nope'] }, /No such eval set: nope\. The sets are: aider-py, small\./],
    [{ sets: ['notaset'] }, /No such eval set/],
    [{ sets: [] }, /needs sets/],
    [{ sets: ['small'], runs: 4 }, /runs is 1 to 3/],
    [{ sets: ['small'], tag: '../x' }, /must be letters/],
  ]) {
    const r = await call('eval_start', args);
    assert.equal(r.result.isError, true, JSON.stringify(args));
    assert.match(text(r), why);
  }
  assert.deepEqual(seen.launched, [], 'nothing started');

  const ok = JSON.parse(text(await call('eval_start', { sets: ['aider-py'], tag: 'ext-aider-2026-11-05' })));
  assert.deepEqual(seen.launched, [{ dir, sets: ['aider-py'], runs: 1, tag: 'ext-aider-2026-11-05' }]);
  assert.equal(ok.tag, 'ext-aider-2026-11-05');
  assert.equal(ok.progress, path.join(dir, 'storage', 'evals', 'runs', 'ext-aider-2026-11-05', 'progress.txt'));
  const dated = JSON.parse(text(await call('eval_start', { sets: ['small', 'aider-py'], runs: 2 })));
  assert.match(dated.tag, /^small_aider-py-\d{4}-\d\d-\d\d$/, 'a tag of the sets and the date when left out');

  // eval_status: the run's progress file, and whether it ended
  const folder = path.join(dir, 'storage', 'evals', 'runs', 'ext-aider-2026-11-05');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'progress.txt'), '2026-11-05T23:00:01 bar ext-aider-2026-11-05 : sets aider-py\r\n2026-11-05T23:00:02 start aider-py run 1\r\n');
  let st = JSON.parse(text(await call('eval_status', { tag: 'ext-aider-2026-11-05' })));
  assert.deepEqual([st.done, st.lines.length], [false, 2]);
  fs.appendFileSync(path.join(folder, 'progress.txt'), '2026-11-06T03:10:00 done  aider-py v1 (ext) run 1: 20/34 cases\r\n2026-11-06T03:10:05 BAR DONE\r\n');
  st = JSON.parse(text(await call('eval_status', {})));
  assert.deepEqual([st.tag, st.done], ['ext-aider-2026-11-05', true], 'the newest run when no tag is given');
  assert.match(text(await call('eval_status', { tag: 'never-ran' })), /No progress file/);

  // a used tag is refused, and so is any start while an eval runs
  assert.match(text(await call('eval_start', { sets: ['aider-py'], tag: 'ext-aider-2026-11-05' })), /has a run already/);
  const busy = fakeEvals({ running: true });
  const r = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eval_start', arguments: { sets: ['small'] } } }, { registry, ctx: { ...ctx, estate: { ...estate, evals: busy.evals } } });
  assert.match(r.result.content[0].text, /An eval is running now; nothing was started/);
  assert.deepEqual(busy.seen.launched, []);
  // where the app hands no evals in, it says so
  assert.match(text(await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'eval_status', arguments: {} } }, { registry, ctx: { ...ctx, estate } })), /not served here/);
});

test("the app's evals: run-bar.ps1 detached in its own minimized PowerShell window; the running check skips its own query", () => {
  const estateMod = require('./estate.cjs');
  const src = fs.readFileSync(path.join(__dirname, 'estate.cjs'), 'utf8');
  assert.match(src, /spawn\('powershell\.exe', args, \{ cwd: dir, detached: true, stdio: 'ignore', windowsHide: false \}\)/);
  assert.match(src, /'-WindowStyle', 'Minimized', '-File', path\.join\(dir, \.\.\.RUN_BAR\)/);
  assert.match(estateMod.RUNNING_QUERY, /ProcessId <> \$PID/);
  assert.match(estateMod.RUNNING_QUERY, /evals\.py/);
  assert.match(estateMod.RUNNING_QUERY, /run-bar\.ps1/);
  assert.equal(typeof estateMod.evalsApi({ stewardDir: () => null }).launch, 'function');
});

test("estate_status carries each repository's version from its local refs, cached for a minute; never git status or git diff", async () => {
  const estateMod = require('./estate.cjs');
  const calls = [];
  const run = async (cmd, args, cwd) => {
    calls.push([cmd, ...args, cwd]);
    const repo = cwd;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return repo === '/none' ? { code: 128, out: '', err: 'fatal: not a git repository' } : { code: 0, out: repo === '/s' ? 'fix-x' : 'main', err: '' };
    if (args[0] === 'rev-parse' && args[2] === 'HEAD') return { code: 0, out: repo === '/s' ? 'bbb2222' : 'aaa1111', err: '' };
    if (args[0] === 'rev-parse' && args[2] === 'origin/main') return { code: 0, out: repo === '/s' ? 'ccc3333' : 'aaa1111', err: '' };
    if (args[0] === 'rev-list') return { code: 0, out: repo === '/s' ? '3\t1' : '0\t0', err: '' };
    if (args[0] === 'diff-index') return { code: repo === '/s' ? 1 : repo === '/j' ? 128 : 0, out: '', err: '' };
    return { code: 1, out: '', err: 'unexpected' };
  };
  let t = 1000;
  const repos = () => [
    { name: 'research', dir: '/g' },
    { name: 'steward', dir: '/s' },
    { name: 'jesster', dir: '/j' },
    { name: 'atlas', dir: '/none' },
    { name: 'neiro', dir: '/n' },
  ];
  const versions = estateMod.versionsApi({ repos, run, clock: () => t });
  const { registry, ctx } = setup();
  const { estate } = fakeEstate();
  const st = JSON.parse((await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estate_status', arguments: {} } }, { registry, ctx: { ...ctx, estate: { ...estate, versions } } })).result.content[0].text);
  assert.deepEqual(st.repos.map(({ dir, ...v }) => v), [
    { name: 'research', branch: 'main', head: 'aaa1111', origin_main: 'aaa1111', behind: 0, ahead: 0, clean: true },
    { name: 'steward', branch: 'fix-x', head: 'bbb2222', origin_main: 'ccc3333', behind: 3, ahead: 1, clean: false },
    { name: 'jesster', branch: 'main', head: 'aaa1111', origin_main: 'aaa1111', behind: 0, ahead: 0 },
    { name: 'atlas', error: 'fatal: not a git repository' },
  ], 'Neiro is not a version gate any more; clean is left out where it cannot be read');
  assert.ok(st.secondbrain.build && st.ollama.version, 'what it had stays');
  assert.ok(calls.every((c) => c[0] === 'git' && !['status', 'diff', 'fetch', 'pull'].includes(c[1])), 'local refs only');
  assert.ok(calls.some((c) => c.join(' ').includes('rev-list --left-right --count origin/main...HEAD')));
  const n = calls.length;
  t += estateMod.VERSIONS_TTL_MS - 1;
  await versions();
  assert.equal(calls.length, n, 'cached under a minute');
  t += 2;
  await versions();
  assert.ok(calls.length > n, 'read again after a minute');
  const plain = JSON.parse((await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estate_status', arguments: {} } }, { registry, ctx: { ...ctx, estate } })).result.content[0].text);
  assert.equal(plain.repos, undefined);
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.equal((main.match(/versions: estateVersions,/g) || []).length, 2, 'estate_status and the workflows read the same cache');
});
