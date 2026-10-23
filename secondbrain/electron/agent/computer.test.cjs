const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const computer = require('./computer.cjs');
const { vkCodes, WindowsInput } = require('../computer/input.cjs');

// a fake vision model that plays back a script of actions
function fakeOllama(script) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = JSON.parse(b);
      seen.push(body);
      const next = script[seen.length - 1] || { name: 'done', args: { summary: 'out of script' } };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: next.name, arguments: next.args } }] } }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, host: `http://127.0.0.1:${srv.address().port}` })));
}

const fakeDesk = (answers = []) => {
  const log = { acts: [], asks: [], shots: 0 };
  return {
    log,
    capture: async () => ({ image: `shot${++log.shots}`, width: 1280, height: 720 }),
    status: () => {},
    ask: async (name, a, summary) => (log.asks.push(summary), answers.length ? answers.shift() : true),
    act: async (name, a) => log.acts.push([name, a]),
  };
};
const noSleep = async () => {};

test('looks, acts after the OK, looks again, and reports', async () => {
  const o = await fakeOllama([
    { name: 'click', args: { x: 500, y: 980, why: 'the Start button' } },
    { name: 'type', args: { text: 'notepad' } },
    { name: 'key', args: { keys: 'enter' } },
    { name: 'done', args: { summary: 'Notepad is open.' } },
  ]);
  const desk = fakeDesk();
  const out = await computer.runTask({ task: 'open notepad', host: o.host, model: 'qwen3-vl:8b', desk, sleep: noSleep });
  o.srv.close();
  assert.match(out, /^Notepad is open\./);
  assert.match(out, /1\. Click "the Start button" at \(500, 980\)/);
  assert.deepEqual(desk.log.acts.map((a) => a[0]), ['click', 'type', 'key']);
  assert.equal(o.seen[0].model, 'qwen3-vl:8b');
  assert.deepEqual(o.seen[0].messages[1].images, ['shot1']);
  // only the newest screenshot travels with each request
  const last = o.seen[3].messages;
  assert.equal(last.filter((m) => m.images).length, 1);
  assert.deepEqual(last.at(-1).images, ['shot4']);
  assert.deepEqual(o.seen[0].tools.map((t) => t.function.name), ['click', 'type', 'key', 'scroll', 'wait', 'done']);
});

test('a Deny stops the task there; nothing is done', async () => {
  const o = await fakeOllama([{ name: 'click', args: { x: 10, y: 10, why: 'Delete' } }, { name: 'click', args: { x: 20, y: 20 } }]);
  const desk = fakeDesk([false]);
  const out = await computer.runTask({ task: 't', host: o.host, model: 'm', desk, sleep: noSleep });
  o.srv.close();
  assert.match(out, /The user declined: Click "Delete" at \(10, 10\)\. Stopped there\./);
  assert.equal(desk.log.acts.length, 0);
  assert.equal(o.seen.length, 1);
});

test('Stop ends it between steps', async () => {
  const o = await fakeOllama([{ name: 'wait', args: { seconds: 1 } }, { name: 'wait', args: { seconds: 1 } }]);
  const stop = new AbortController();
  const desk = fakeDesk();
  const out = await computer.runTask({ task: 't', host: o.host, model: 'm', desk, signal: stop.signal, sleep: async () => stop.abort() });
  o.srv.close();
  assert.match(out, /^Stopped by the user\./);
});

test('positions are kept on the screen; risky typing and keys are flagged', () => {
  assert.match(computer.describe('click', { x: 1500, y: -4 }), /\(1000, 0\)/);
  assert.match(computer.describe('type', { text: 'rm -rf /' }), /^⚠ This deletes files recursively/);
  assert.match(computer.describe('key', { keys: 'win+r' }), /^⚠ uses the Windows key/);
  assert.match(computer.describe('key', { keys: 'alt+f4' }), /^⚠ closes a window/);
});

test('tools: off until switched on; starting asks; schedules refused', async () => {
  const runtime = { run: async (task) => `ran ${task}`, look: async () => 'a desktop' };
  const t = computer.tools(() => runtime, () => ({ enabled: false }));
  await assert.rejects(t[0].run({ task: 'x' }, {}), /computer use is off/);
  const on = computer.tools(() => runtime, () => ({ enabled: true }));
  assert.equal(on.find((x) => x.name === 'computer_task').risky, true);
  assert.ok(!on.find((x) => x.name === 'screen_look').risky);
  await assert.rejects(on[0].run({ task: 'x' }, { source: 'schedule' }), /scheduled/);
  assert.equal(await on[0].run({ task: 'x' }, { source: 'app' }), 'ran x');
  assert.match(on[0].describe({ task: 'x' }), /Each action will ask you again[\s\S]*Ctrl\+Alt\+Q/);
});

test('key names become Windows key codes', () => {
  assert.deepEqual(vkCodes('ctrl+shift+t'), [0x11, 0x10, 0x54]);
  assert.deepEqual(vkCodes('Enter'), [0x0d]);
  assert.deepEqual(vkCodes('alt + F4'), [0x12, 0x73]);
  assert.deepEqual(vkCodes('arrowdown'), [0x28]);
  assert.throws(() => vkCodes('ctrl+ü'), /unknown key/);
});

test('the Windows input helper compiles and answers', { skip: process.platform !== 'win32' }, async () => {
  const w = new WindowsInput();
  try {
    await w.start();
    assert.match(await w.pos(), /^-?\d+ -?\d+$/);
    // on a CI runner there may be no desktop to take the click; either way the helper answered
    await w.click(5, 5).catch((e) => assert.match(e.message, /did not accept the input/));
    await w.key('shift').catch((e) => assert.match(e.message, /did not accept the input/));
    await assert.rejects(w.send('nonsense'), /unknown command/);
  } finally {
    w.close();
  }
});
