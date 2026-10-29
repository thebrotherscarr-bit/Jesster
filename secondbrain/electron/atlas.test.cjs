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

test('the bearer key is checked in constant time and never optional', () => {
  assert.equal(atlas.keyOk('Bearer abc123', 'abc123'), true);
  assert.equal(atlas.keyOk('Bearer abc124', 'abc123'), false);
  assert.equal(atlas.keyOk('', 'abc123'), false);
  assert.equal(atlas.keyOk('Bearer ', ''), false);
});
