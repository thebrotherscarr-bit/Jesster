const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Vault } = require('../vaultfs.cjs');
const { Registry } = require('./tools.cjs');
const { McpClient } = require('./mcp.cjs');

const fixture = path.join(__dirname, 'fixtures', 'mcp-echo.cjs');

function client(servers) {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-')));
  const c = new McpClient(() => vault);
  c.writeConfig(JSON.stringify({ mcpServers: servers }));
  return { c, vault };
}

test('servers connect; their tools become agent tools; calls need approval unless trusted', async () => {
  const { c, vault } = client({
    echo: { command: process.execPath, args: [fixture] },
    trusted: { command: process.execPath, args: [fixture], trusted: true },
    off: { command: process.execPath, args: [fixture], enabled: false },
    broken: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
  });
  const tools = await c.connect();
  try {
    assert.deepEqual(tools.map((t) => t.name).sort(), ['mcp__echo__echo', 'mcp__echo__fail', 'mcp__trusted__echo', 'mcp__trusted__fail']);
    const st = Object.fromEntries(c.status().map((s) => [s.name, s]));
    assert.equal(st.echo.status, 'connected');
    assert.equal(st.broken.status, 'error');
    assert.match(st.broken.error, /exited \(3\)/);
    assert.equal(st.off, undefined);

    const reg = new Registry().add(tools);
    const asked = [];
    const ctx = { vault, approve: async (name) => { asked.push(name); return true; } };
    assert.equal(await reg.run('mcp__echo__echo', { text: 'hi' }, ctx), 'echo: hi');
    assert.equal(await reg.run('mcp__trusted__echo', { text: 'yo' }, ctx), 'echo: yo');
    assert.deepEqual(asked, ['mcp__echo__echo'], 'only the untrusted server asked');
    assert.deepEqual(await reg.run('mcp__trusted__fail', {}, ctx), { error: 'it broke' });
    const declined = await reg.run('mcp__echo__echo', { text: 'x' }, { vault, approve: async () => false });
    assert.deepEqual(declined, { error: 'the user declined this action' });
  } finally {
    c.stopAll();
  }
});

test('include limits which tools of a server the agent is offered', async () => {
  const { c } = client({ echo: { command: process.execPath, args: [fixture], include: ['echo'] } });
  const tools = await c.connect();
  try {
    assert.deepEqual(tools.map((t) => t.name), ['mcp__echo__echo']);
    assert.equal(c.status()[0].offered, 1);
    assert.equal(c.status()[0].tools.length, 2);
  } finally {
    c.stopAll();
  }
});

test('bad config is refused before anything is written', () => {
  const { c } = client({});
  assert.throws(() => c.writeConfig('{nope'), SyntaxError);
  assert.throws(() => c.writeConfig('{"other": 1}'), /mcpServers/);
  assert.match(c.rawConfig(), /mcpServers/);
});

let python = null;
for (const p of ['python3', 'python']) {
  try {
    execFileSync(p, ['--version'], { stdio: 'ignore' });
    python = p;
    break;
  } catch {
    /* try the next */
  }
}
const kernel = path.resolve(__dirname, '..', '..', '..', 'notes', 'cli.py');

test('a real MCP server: the Jesster notes kernel', { skip: !python || !fs.existsSync(kernel) }, async () => {
  const notesVault = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-'));
  execFileSync(python, [kernel, '--vault', notesVault, 'init', '--actor', 'test']);
  const { c, vault } = client({ jesster: { command: python, args: [kernel, '--vault', notesVault, 'mcp'], trusted: true } });
  const tools = await c.connect();
  try {
    assert.ok(tools.some((t) => t.name === 'mcp__jesster__notes_create'), tools.map((t) => t.name).join(','));
    const reg = new Registry().add(tools);
    const created = await reg.run('mcp__jesster__notes_create', { title: 'From SecondBrain', body: 'over MCP' }, { vault });
    assert.match(created, /from-secondbrain/);
    const found = await reg.run('mcp__jesster__notes_search', { q: 'over MCP' }, { vault });
    assert.match(found, /From SecondBrain/);
  } finally {
    c.stopAll();
  }
});

// ---- MCP 2026-07-28 beside 2025-06-18 (negotiate) ------------------------------------------------

const { McpServer } = require('./mcp.cjs');
const eras = path.join(__dirname, 'fixtures', 'mcp-eras.cjs');
const eraServer = (mode) => new McpServer(mode, { command: process.execPath, args: [eras], env: { ERA_MODE: mode } });

test('a 2026-07-28 server: discovered, no initialize, every request carries the _meta envelope', async () => {
  const s = eraServer('modern');
  try {
    const tools = await s.start();
    assert.equal(s.era, 'modern');
    assert.equal(s.version, '2026-07-28');
    assert.deepEqual(tools.map((t) => t.name), ['echo']);
    assert.equal(await s.call('echo', { text: 'hi' }), 'modern: hi at 2026-07-28 from secondbrain');
  } finally {
    s.stop();
  }
});

test('a 2025-06-18 server falls back to initialize: one that refuses server/discover, and one silent to it', async () => {
  const { c } = client({ echo: { command: process.execPath, args: [fixture] } });
  await c.connect();
  try {
    const echo = c.servers.get('echo');
    assert.equal(echo.era, 'legacy', '"unknown method" to server/discover is a legacy server');
    assert.equal(echo.version, '2025-06-18');
    assert.equal(await echo.call('echo', { text: 'hi' }), 'echo: hi');
  } finally {
    c.stopAll();
  }
  const s = eraServer('silent');
  s.probeTimeout = 300;
  try {
    await s.start();
    assert.equal(s.era, 'legacy', 'no answer to the probe is a legacy server');
    assert.equal(await s.call('echo', { text: 'x' }), 'legacy: x meta=false', 'no envelope on a legacy request');
  } finally {
    s.stop();
  }
});

test('a server that names only versions SecondBrain does not speak is refused by name', async () => {
  const s = eraServer('future');
  await assert.rejects(s.start(), /speaks MCP 2099-01-01; SecondBrain speaks 2026-07-28/);
  assert.equal(s.status, 'error');
});

test("SecondBrain's own /mcp server and its client agree on 2026-07-28 (handleMcp behind the stdio client)", async () => {
  const atlas = require('../atlas.cjs');
  const { Registry: R, core } = require('./tools.cjs');
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'self-')));
  vault.save({ id: 'p', title: 'Launch plan', content: 'launch on the 14th', tags: [], category: 'projects', isPinned: false, createdAt: 1, updatedAt: 1 });
  const registry = new R().add(core);
  const sent = [];
  const s = new McpServer('self', {});
  // the stdio pipe stood in by handleMcp itself: what the client writes is answered in-process
  s.proc = { stdin: { writable: true } };
  s.send = (msg) => {
    sent.push(msg);
    Promise.resolve(atlas.handleMcp(msg, { registry, ctx: { vault } })).then((r) => {
      const w = r && s.waiting.get(r.id);
      if (!w) return;
      clearTimeout(w.timer);
      s.waiting.delete(r.id);
      if (r.error) w.reject(Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data }));
      else w.resolve(r.result);
    });
  };
  await s.negotiate();
  assert.equal(s.era, 'modern');
  assert.ok(!sent.some((m) => m.method === 'initialize'));
  const listed = await s.request('tools/list');
  assert.equal(listed.resultType, 'complete');
  const found = await s.call('search_notes', { query: 'launch' });
  assert.match(found, /Launch plan/);
  assert.ok(sent.filter((m) => m.method !== 'server/discover').every((m) => m.params._meta['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'));
});
