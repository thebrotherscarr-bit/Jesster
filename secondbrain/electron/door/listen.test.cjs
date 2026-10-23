const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const door = require('./index.cjs');
const auth = require('./auth.cjs');
const { listen } = require('./listen.cjs');

function ground() {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'door-listen-'));
  fs.writeFileSync(path.join(g, 'manjuel.py'), '');
  fs.writeFileSync(path.join(g, 'AGENTS.md'), 'the line');
  fs.mkdirSync(path.join(g, 'atlas'));
  fs.writeFileSync(path.join(g, 'atlas', 'AGENTS.md'), 'atlas line');
  return g;
}

const WIRE = 'the-glass-wire';

/** A door on a free loopback port; `d` may be wrapped to stand a fake inner door in. */
async function up(d) {
  const server = await listen(d, { wire: WIRE, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (body, key) => {
    const r = await fetch(base + '/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: (Array.isArray(body) ? body : [body]).map((m) => JSON.stringify(m)).join('\n'),
    });
    const text = await r.text();
    return text.trim() ? text.trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const call = async (name, args, key) => (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, key))[0];
  return { server, base, rpc, call };
}

test('8090 answers as the Go door did: tools listed to anyone, a call refused to a stranger (401), auth_verify open', async () => {
  const g = ground();
  const { server, base, rpc, call } = await up(door.serve(() => g));
  try {
    const health = await (await fetch(base + '/health')).json();
    assert.deepEqual(health, { status: 'ok', server: 'secondbrain-door', version: '1', auth: true });
    const listed = (await (await fetch(base + '/tools')).json()).tools.map((t) => t.name);
    assert.deepEqual(listed, door.ORDER, 'all 97, in the Go door\'s order');
    const [init, list] = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    assert.match(init.result.instructions, /You are a seat at the atlas household/);
    assert.equal(list.result.tools.length, door.ORDER.length, 'one answer per request line; the notification gets none');
    const stranger = await call('get_in_line', {});
    assert.equal(stranger.error.code, -32001);
    assert.match(stranger.error.message, /^401: /);
    const wrong = await call('get_in_line', {}, 'not-the-wire');
    assert.equal(wrong.error.code, -32001);
    const open = await call('auth_verify', { key: 'atl_' + '0'.repeat(32) });
    assert.ok(open.result, 'auth_verify needs no key');
  } finally {
    server.close();
  }
});

test('the glass\'s wire is the operator: its write runs at once; a client\'s key is a client: its write parks', async () => {
  const g = ground();
  const d = door.serve(() => g);
  const [key] = auth.create(g, 'the claude bridge', ['atlas'], 'test');
  const { server, call } = await up(d);
  try {
    const mine = await call('remember', { text: 'from the glass' }, WIRE);
    assert.ok(!mine.result.isError, mine.result.content[0].text);
    assert.doesNotMatch(mine.result.content[0].text, /^HELD/);
    assert.match(fs.readFileSync(path.join(g, 'state', 'remembered.jsonl'), 'utf8'), /from the glass/);
    const theirs = await call('remember', { text: 'from a client' }, key);
    assert.match(theirs.result.content[0].text, /^HELD: "remember" writes, and this call did not come from the operator's own glass \(k-[0-9a-f]{8}\)/);
    assert.doesNotMatch(fs.readFileSync(path.join(g, 'state', 'remembered.jsonl'), 'utf8'), /from a client/);
    const holds = await d.call('hold_list', {}, door.OPERATOR);
    assert.match(holds.text, /remember/, 'the parked call waits on the operator');
    const read = await call('get_in_line', { project: 'atlas' }, key);
    assert.match(read.result.content[0].text, /atlas line/, 'a read runs for the client');
  } finally {
    server.close();
  }
});

test('a key is held to the worlds it carries (403); a tool the door does not carry is refused by name', async () => {
  const g = ground();
  const [key] = auth.create(path.join(g, 'atlas'), 'atlas only', [], 'test');
  const { server, call } = await up(door.serve(() => g));
  try {
    const out = await call('get_in_line', { project: 'research' }, key);
    assert.equal(out.error.code, -32003);
    assert.match(out.error.message, /^403: key k-[0-9a-f]{8} does not carry project "research"/);
    const mars = await call('get_in_line', { project: 'mars' }, key);
    assert.equal(mars.error.code, -32003);
    const none = await call('no_such_tool', {}, WIRE);
    assert.equal(none.error.code, -32602);
  } finally {
    server.close();
  }
});

test('the engine\'s streams are the glass\'s alone, handed to the inner door with its own wire, query and body as they are', async () => {
  const g = ground();
  const seen = [];
  const fake = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"turn":"done"}\n\n');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const inner = { port: fake.address().port, secret: 'inner-secret', start: async () => {} };
  const d = { ...door.serve(() => g), inner: () => inner };
  const [key] = auth.create(g, 'a client', [], 'test');
  const { server, base } = await up(d);
  try {
    const refused = await fetch(base + '/run/stream?project=research&objective=x', { headers: { Authorization: 'Bearer ' + key } });
    assert.equal(refused.status, 401);
    assert.equal((await fetch(base + '/chat/stream?q=hi')).status, 401);
    assert.equal(seen.length, 0, 'nothing reached the engine');
    const r = await fetch(base + '/run/stream?project=research&objective=x%20y', { headers: { Authorization: 'Bearer ' + WIRE } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    assert.equal(await r.text(), 'data: {"turn":"done"}\n\n');
    assert.deepEqual(seen, [{ url: '/run/stream?project=research&objective=x%20y', auth: 'Bearer inner-secret' }]);
  } finally {
    server.close();
    fake.close();
  }
});

test('a taken port is said plainly', async () => {
  const g = ground();
  const first = await listen(door.serve(() => g), { wire: WIRE, port: 0 });
  try {
    await assert.rejects(listen(door.serve(() => g), { wire: WIRE, port: first.address().port }), /is taken by another program, so SecondBrain cannot be the door there/);
  } finally {
    first.close();
  }
});
