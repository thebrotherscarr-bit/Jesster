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
