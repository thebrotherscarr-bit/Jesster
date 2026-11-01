const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const door = require('./index.cjs');
const atlas = require('../atlas.cjs');
const { Registry, core } = require('../agent/tools.cjs');
const { Vault } = require('../vaultfs.cjs');

// The Go door, where this ground keeps it: worlds/jesster/secondbrain -> Research/atlas/line.
const GO_TOOLS = path.join(__dirname, '..', '..', '..', '..', '..', 'atlas', 'line', 'internal', 'tools');

test('ORDER is the Go door\'s whole surface: every tool it registers, and nothing it does not', { skip: !fs.existsSync(GO_TOOLS) && 'the Go door is not beside this app' }, () => {
  const names = new Set();
  for (const f of fs.readdirSync(GO_TOOLS)) {
    if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
    for (const m of fs.readFileSync(path.join(GO_TOOLS, f), 'utf8').matchAll(/\bName:\s*"([a-z_]+)"/g)) names.add(m[1]);
  }
  assert.deepEqual([...door.ORDER].sort(), [...names].sort());
  assert.equal(door.ORDER.length, 97);
});

test('PORTED and REMAINING split the surface, and all 97 are served: the ported here, the rest forwarded', () => {
  assert.equal(door.PORTED.length + door.REMAINING.length, door.ORDER.length);
  const reg = door.build([['w', fs.mkdtempSync(path.join(os.tmpdir(), 'door-idx-'))]]);
  assert.deepEqual(reg.names(), door.ORDER);
  for (const n of door.REMAINING) assert.ok(reg.get(n).forwarded, n + ' is forwarded');
  for (const n of door.PORTED) assert.ok(!reg.get(n).forwarded, n + ' runs here');
  for (const n of ['get_in_line', 'records', 'git', 'hold_list', 'hold_answer', 'remember', 'auth_verify']) assert.ok(door.PORTED.includes(n), n);
});

function ground() {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'door-ground-'));
  fs.writeFileSync(path.join(g, 'manjuel.py'), '');
  fs.writeFileSync(path.join(g, 'AGENTS.md'), 'the line');
  fs.mkdirSync(path.join(g, 'atlas'));
  fs.writeFileSync(path.join(g, 'atlas', 'AGENTS.md'), 'atlas line');
  return g;
}

function notes() {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'door-vault-')));
  return { registry: new Registry().add(core), ctx: { vault } };
}

test('SecondBrain\'s /mcp serves the door beside the notes; a client\'s write is held until the app approves it', async () => {
  const g = ground();
  const d = door.serve(() => g);
  const { registry, ctx } = notes();
  const rpc = (id, method, params) => atlas.handleMcp({ jsonrpc: '2.0', id, method, params }, { registry, ctx, door: d });
  const init = await rpc(1, 'initialize', {});
  assert.match(init.result.instructions, /The Atlas door is served here too\.\nYou are a seat at the atlas household/);
  const names = (await rpc(2, 'tools/list')).result.tools.map((t) => t.name);
  assert.ok(names.includes('search_notes') && names.includes('get_in_line') && names.includes('hold_list'));
  assert.ok(names.includes('git_commit') && names.includes('flow_run'), 'a forwarded tool is listed too');
  const line = await rpc(3, 'tools/call', { name: 'get_in_line', arguments: { project: 'atlas' } });
  assert.equal(line.result.isError, false);
  assert.match(line.result.content[0].text, /-- LINE \(atlas\) --\natlas line/);
  const stranger = await rpc(4, 'tools/call', { name: 'muster', arguments: { project: 'mars' } });
  assert.equal(stranger.result.isError, true);
  assert.match(stranger.result.content[0].text, /unknown project "mars"/);
  const held = await rpc(5, 'tools/call', { name: 'remember', arguments: { text: 'from a seat' } });
  assert.equal(held.result.isError, false);
  assert.match(held.result.content[0].text, /^HELD: "remember" writes, and this call did not come from the operator's own glass \(secondbrain share key\)/);
  const answer = await rpc(6, 'tools/call', { name: 'hold_answer', arguments: { id: 'x', decision: 'approve' } });
  assert.match(answer.result.content[0].text, /operator's act alone/, 'a client cannot answer its own hold');
  assert.ok(!fs.existsSync(path.join(g, 'state', 'remembered.jsonl')));
  // The app's own window is the operator's hand.
  const handlers = {};
  const fakeIpc = { handle: (ch, fn) => (handlers[ch] = fn) };
  let guarded = 0;
  const installed = door.register({
    atlas: { useDoor: () => {} },
    ipcMain: fakeIpc,
    guard: () => guarded++,
    getSettings: () => ({ get: () => ({ ground: g }) }),
    vaultDir: () => '',
  });
  assert.ok(installed.has('hold_list'));
  const parked = (await installed.call('remember', { text: 'kept' })).text;
  const id = parked.match(/parked as (hold_\S+)/)[1];
  const list = JSON.parse((await handlers['door:holds']({})).text);
  assert.deepEqual(list.held.map((h) => h.id), [id]);
  const ran = await handlers['door:answer']({}, id, 'approve');
  assert.equal(ran.isError, false);
  assert.match(ran.text, /REMEMBERED \(testimony/);
  assert.equal(guarded, 2, 'every IPC call is guarded');
  assert.match(fs.readFileSync(path.join(g, 'state', 'remembered.jsonl'), 'utf8'), /"text":"kept"/);
});

test('without a ground there is no door: nothing listed, nothing served', async () => {
  const d = door.serve(() => null);
  assert.deepEqual(d.list(), []);
  assert.equal(d.has('records'), false);
  assert.match((await d.call('records', {})).text, /ground was not found/);
  const { registry, ctx } = notes();
  const out = await atlas.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'records', arguments: {} } }, { registry, ctx, door: d });
  assert.equal(out.result.isError, true);
  assert.equal(out.result.content[0].text, 'no tool records');
});

test('the GitHub shelf presses the door\'s git and hold tools over IPC as the operator, and nothing else', async () => {
  const g = ground();
  const handlers = {};
  const reg = door.register({
    atlas: { useDoor: () => {} },
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) },
    guard: () => {},
    getSettings: () => ({ get: () => ({ ground: g }) }),
    vaultDir: () => '',
  });
  try {
    const out = await handlers['door:call']({}, 'git', { project: 'atlas' });
    assert.equal(out.isError, false);
    assert.match(out.text, /"world": "atlas"/);
    await assert.rejects(() => handlers['door:call']({}, 'shell_run', { shell: 'bash', command: 'ls' }), /not a GitHub shelf tool: shell_run/);
    await assert.rejects(() => handlers['door:call']({}, 'file_edit', {}), /not a GitHub shelf tool/);
    for (const n of ['git', 'git_commit', 'git_push', 'git_pull', 'git_branch', 'git_tag', 'git_pr', 'hold_list', 'hold_answer']) assert.ok(door.SHELF_TOOLS.has(n), n);
  } finally {
    reg.stop();
  }
});

test('the Agent tab at the door: a client\'s agent_send waits for his Approve, then reaches the Agent; agent_read reads at once', async () => {
  const g = ground();
  const asked = [];
  const shown = [];
  const agent = {
    sessions: new Map(),
    ask: async (m) => asked.push(m),
    open: (id) => ({ sessionId: id, busy: false, messages: [{ role: 'user', content: 'hi' }] }),
  };
  const handlers = {};
  const d = door.register({
    atlas: { useDoor: () => {} },
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) },
    guard: () => {},
    getSettings: () => ({ get: () => ({ ground: g }) }),
    vaultDir: () => '',
    getAgent: () => agent,
    showAgent: (id) => shown.push(id),
  });
  try {
    const names = d.list().map((t) => t.name);
    assert.deepEqual(names.slice(0, door.ORDER.length), door.ORDER, 'the Go door\'s 97 first, as they were');
    assert.deepEqual(names.slice(door.ORDER.length), ['agent_send', 'agent_read']);
    const held = (await d.call('agent_send', { text: 'hi', session_id: 'session-20261031-2100-ab12' })).text;
    assert.match(held, /^HELD: "agent_send" writes/);
    assert.equal(asked.length, 0, 'nothing reaches the Agent before his Approve');
    const id = held.match(/parked as (hold_\S+)/)[1];
    const ran = await handlers['door:answer']({}, id, 'approve');
    assert.equal(ran.isError, false);
    assert.match(ran.text, /"session_id":"session-20261031-2100-ab12"/);
    assert.deepEqual(asked.map((m) => [m.text, m.sessionId, m.source]), [['hi', 'session-20261031-2100-ab12', 'app']]);
    assert.deepEqual(shown, ['session-20261031-2100-ab12'], 'the window opens the conversation');
    const read = await d.call('agent_read', { session_id: 'session-20261031-2100-ab12' });
    assert.equal(read.isError, false);
    assert.equal(JSON.parse(read.text).messages[0].content, 'hi');
    const empty = await d.call('agent_read', {});
    assert.equal(empty.isError, true);
  } finally {
    d.stop();
  }
});

test('a flow\'s git block: reads and bringing level run, other writes wait for him, pull requests too, and nothing moves the ground under a sitting', async () => {
  const g = ground();
  const d = door.serve(() => g);
  try {
    assert.match((await door.flowCall(d, 'git', { project: 'atlas' })).text, /"world": "atlas"/);
    assert.match((await door.flowCall(d, 'git_commit', { project: 'atlas', message: 'm' })).text, /^HELD: "git_commit" writes/);
    assert.match((await door.flowCall(d, 'git_pr', { project: 'atlas', action: 'open' })).text, /^HELD: "git_pr" writes, and this call did not come from the operator's own glass \(a flow\)/);
    assert.match((await door.flowCall(d, 'hold_answer', { id: 'x', decision: 'approve' })).text, /cannot call hold_answer/);
    assert.match((await door.flowCall(d, 'git_pull', { project: 'atlas' })).text, /not a repository/, 'bringing level runs, as the operator');
    fs.mkdirSync(path.join(g, 'sessions'));
    fs.writeFileSync(path.join(g, 'sessions', 'sessions.jsonl'), '{"n": 9, "ended": ""}\n');
    assert.match((await door.flowCall(d, 'git_pull', { project: 'research' })).text, /^Refused: sitting 9 is open/);
    const held = JSON.parse((await d.call('hold_list', {}, door.OPERATOR)).text).held.map((h) => h.tool);
    assert.deepEqual(held.sort(), ['git_commit', 'git_pr'], 'both wait in Waiting on you');
  } finally {
    d.stop();
  }
});

test("each window gets its own cards: SecondBrain's share key and flows in SecondBrain, the Atlas door's keys in Atlas", async () => {
  const g = ground();
  const d = door.serve(() => g);
  const glass = { name: '', service: true };
  try {
    const sb = (await d.call('remember', { text: 'through SecondBrain' })).text;
    assert.match(sb, /^HELD: "remember".*on the card in SecondBrain/s);
    const at = (await d.call('remember', { text: 'through Atlas' }, { name: 'k-test', service: false })).text;
    assert.match(at, /on the card in Atlas/);
    const sbId = sb.match(/parked as (hold_\S+)/)[1];
    const atId = at.match(/parked as (hold_\S+)/)[1];
    const ids = async (caller) => JSON.parse((await d.call('hold_list', {}, caller)).text).held.map((h) => h.id);
    assert.deepEqual(await ids(door.OPERATOR), [sbId], "SecondBrain's window lists its own card only");
    assert.deepEqual(await ids(glass), [atId], "the Atlas glass lists its own card only");
    assert.match((await d.call('hold_answer', { id: sbId, decision: 'approve' }, glass)).text, /is SecondBrain's card; answer it in SecondBrain/);
    assert.match((await d.call('hold_answer', { id: atId, decision: 'deny' }, door.OPERATOR)).text, /is Atlas's card; answer it in Atlas/);
    assert.match((await d.call('hold_answer', { id: sbId, decision: 'deny' }, door.OPERATOR)).text, /^Denied/);
    assert.match((await d.call('hold_answer', { id: atId, decision: 'deny' }, glass)).text, /^Denied/);
  } finally {
    d.stop();
  }
});
