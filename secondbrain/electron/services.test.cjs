const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { registry, ollamaServer, stewardEntry, runsOllama, OLLAMA_EXTERNAL, OLLAMA_APP } = require('./services.cjs');
const { DEFAULTS, Settings } = require('./settings.cjs');

const tick = () => new Promise((r) => setTimeout(r, 20));

/** A steward.cjs service() stand-in that records what it was asked. */
function fakeSvc(port, calls) {
  let held = false;
  return {
    port: () => port,
    held: () => held,
    start: async () => {
      calls.push(`start ${port}`);
      held = false;
    },
    stop: async () => {
      calls.push(`stop ${port}`);
      held = true;
    },
    restart: async () => calls.push(`restart ${port}`),
  };
}

/** Ollama with every outside act recorded instead of done. */
function fakeOllama({ enabled = false, answering = false, env = {}, getConfig = null } = {}) {
  const seen = { starts: [], killed: [], children: [], up: answering, clock: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'services-'));
  const server = ollamaServer({
    getConfig: getConfig || (() => ({ ...DEFAULTS.services.ollama, enabled })),
    logDir: dir,
    probe: async () => seen.up,
    wait: async (port, ms, probe, gone) => (gone ? !seen.up : seen.up),
    find: () => 'C:\\fake\\ollama.exe',
    start: (exe, args, cwd, env, logs) => {
      seen.starts.push({ exe, args, cwd, env, logs });
      seen.up = true;
      const child = Object.assign(new EventEmitter(), { pid: 77, exitCode: null });
      seen.children.push(child);
      return child;
    },
    killTree: (pid) => {
      seen.killed.push(pid);
      seen.up = false;
    },
    delay: 0,
    now: () => seen.clock,
    base: { PATH: 'C:\\Windows', OLLAMA_MODELS: 'D:\\models', HSA_OVERRIDE_GFX_VERSION: '10.3.0', OLLAMA_KV_CACHE_TYPE: 'f16', ...env },
  });
  /** the newest `ollama serve` dies, `after` ms after it started */
  seen.die = (after = 1000) => {
    const child = seen.children[seen.children.length - 1];
    seen.clock += after;
    seen.up = false;
    child.exitCode = 1;
    child.emit('exit', 1);
  };
  return { server, seen, dir };
}

test('the list has every entry, each with the status its probe gives', async () => {
  const calls = [];
  const up = new Set([43120, 43111]);
  const reg = registry(
    [
      stewardEntry({ id: 'steward', label: "Steward's service", svc: fakeSvc(43120, calls), logPath: () => 'C:\\s\\steward.log' }),
      stewardEntry({ id: 'steward-mcp', label: "Steward's MCP", svc: fakeSvc(43121, calls), logPath: () => null }),
      { id: 'door', label: 'The door', port: 43111, kind: 'owned' },
      { id: 'glass', label: 'The Atlas glass', port: 8091, kind: () => 'external' },
      { id: 'notes-kernel', label: 'The notes kernel', port: null, up: async () => true },
      fakeOllama().server,
    ],
    { probe: async (port) => up.has(port) },
  );
  const list = await reg.list();
  assert.deepEqual(list.map((s) => [s.id, s.port, s.kind, s.status, s.canControl]), [
    ['steward', 43120, 'owned', 'up', true],
    ['steward-mcp', 43121, 'owned', 'down', true],
    ['door', 43111, 'owned', 'up', false],
    ['glass', 8091, 'external', 'down', false],
    ['notes-kernel', null, 'owned', 'up', false],
    ['ollama', 11434, 'external', 'down', true],
  ]);
  assert.equal(list[0].logPath, 'C:\\s\\steward.log');
  assert.equal(list[5].why, OLLAMA_EXTERNAL, 'the refusal to come is said in the list too');
  assert.equal(list[5].settings.env.OLLAMA_KV_CACHE_TYPE, 'q8_0');
  // a stopped Steward service is held, not merely down
  await reg.control('steward-mcp', 'stop');
  assert.equal((await reg.list())[1].status, 'held');
});

test('control goes to the entry named, and refuses what it cannot do', async () => {
  const calls = [];
  const reg = registry([
    stewardEntry({ id: 'steward', label: "Steward's service", svc: fakeSvc(43120, calls) }),
    stewardEntry({ id: 'steward-mcp', label: "Steward's MCP", svc: fakeSvc(43121, calls) }),
    { id: 'door', label: 'The door', port: 43111 },
  ], { probe: async () => false });
  assert.deepEqual(await reg.control('steward-mcp', 'restart'), { ok: true });
  assert.deepEqual(await reg.control('steward', 'stop'), { ok: true });
  assert.deepEqual(calls, ['restart 43121', 'stop 43120']);
  assert.equal((await reg.control('door', 'stop')).ok, false, 'the door is SecondBrain itself');
  assert.match((await reg.control('nope', 'start')).error, /Unknown server/);
  assert.match((await reg.control('steward', 'explode')).error, /Unknown action/);
  assert.equal(calls.length, 2);
});

test("Ollama while off, or while the Ollama app answers on 11434, refuses Start and Stop with the reason", async () => {
  for (const [opts, error] of [[{ enabled: false }, OLLAMA_EXTERNAL], [{ enabled: true, answering: true }, OLLAMA_APP]]) {
    const { server, seen } = fakeOllama(opts);
    const reg = registry([server], { probe: async () => seen.up });
    for (const action of ['start', 'stop', 'restart']) assert.deepEqual(await reg.control('ollama', action), { ok: false, error });
    assert.equal(seen.starts.length + seen.killed.length, 0, 'nothing started or stopped');
    assert.equal((await reg.list())[0].kind, 'external');
  }
});

test('Ollama on and nothing answering starts `ollama serve` with the pinned environment, and stops what it started', async () => {
  const { server, seen, dir } = fakeOllama({ enabled: true });
  const reg = registry([server], { probe: async () => seen.up });
  assert.equal((await reg.list())[0].kind, 'owned');
  assert.deepEqual(await reg.control('ollama', 'start'), { ok: true });
  const [s] = seen.starts;
  assert.deepEqual([s.exe, s.args, s.cwd, s.logs], ['C:\\fake\\ollama.exe', ['serve'], dir, ['ollama.log', 'ollama.log']]);
  assert.ok(!('HSA_OVERRIDE_GFX_VERSION' in s.env), 'the ROCm override is taken out');
  assert.equal(s.env.OLLAMA_KV_CACHE_TYPE, 'q8_0', 'a pinned value overrides the inherited one');
  assert.equal(s.env.OLLAMA_FLASH_ATTENTION, '1');
  assert.equal(s.env.OLLAMA_CONTEXT_LENGTH, '65536');
  assert.equal(s.env.OLLAMA_HOST, '127.0.0.1');
  assert.equal(s.env.OLLAMA_NO_CLOUD, '1');
  assert.equal(s.env.OLLAMA_MODELS, 'D:\\models', "'' keeps the inherited OLLAMA_MODELS");
  assert.equal(s.env.PATH, 'C:\\Windows', 'the rest of the environment rides along');
  const [row] = await reg.list();
  assert.deepEqual([row.kind, row.status, row.logPath], ['owned', 'up', path.join(dir, 'ollama.log')]);
  assert.deepEqual(await reg.control('ollama', 'stop'), { ok: true });
  assert.deepEqual(seen.killed, [77]);
  assert.equal((await reg.list())[0].status, 'held');
});

test('SECONDBRAIN_RUNS_OLLAMA=1 turns the switch on and =0 forces it off, whatever Settings says', async () => {
  assert.deepEqual([runsOllama({ SECONDBRAIN_RUNS_OLLAMA: '1' }), runsOllama({ SECONDBRAIN_RUNS_OLLAMA: '0' }), runsOllama({}), runsOllama({ SECONDBRAIN_RUNS_OLLAMA: 'yes' })], [true, false, null, null]);
  const on = fakeOllama({ enabled: false, env: { SECONDBRAIN_RUNS_OLLAMA: '1' } });
  const regOn = registry([on.server], { probe: async () => on.seen.up });
  const [rowOn] = await regOn.list();
  assert.deepEqual([rowOn.kind, rowOn.settings.enabled, rowOn.settings.override], ['owned', true, 'on']);
  assert.deepEqual(await regOn.control('ollama', 'start'), { ok: true });
  assert.equal(on.seen.starts.length, 1);
  const off = fakeOllama({ enabled: true, env: { SECONDBRAIN_RUNS_OLLAMA: '0' } });
  const regOff = registry([off.server], { probe: async () => off.seen.up });
  assert.deepEqual(await regOff.control('ollama', 'start'), { ok: false, error: OLLAMA_EXTERNAL });
  const [rowOff] = await regOff.list();
  assert.deepEqual([rowOff.kind, rowOff.settings.enabled, rowOff.settings.override], ['external', false, 'off']);
  assert.equal(off.seen.starts.length, 0);
  // with no override, Settings decides, and the override says null
  assert.equal((await registry([fakeOllama({ enabled: true }).server]).list())[0].settings.override, null);
});

test("the toggle's write, settings.set('services', { ollama: { enabled } }), turns it on and keeps the pinned environment", async () => {
  const s = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'services-settings-')));
  const { server, seen } = fakeOllama({ getConfig: () => s.get('services').ollama });
  const reg = registry([server], { probe: async () => seen.up });
  assert.equal((await reg.list())[0].kind, 'external');
  s.set('services', { ollama: { enabled: true } }); // what the Servers shelf's toggle sends (src/utils/services.ts ollamaSwitch)
  assert.deepEqual(s.get('services').ollama.env, DEFAULTS.services.ollama.env, 'the pinned environment stays');
  const [row] = await reg.list();
  assert.deepEqual([row.kind, row.settings.enabled], ['owned', true]);
  s.set('services', { ollama: { enabled: false } });
  assert.equal((await reg.list())[0].kind, 'external');
});

test('an `ollama serve` SecondBrain started is started again when it dies; Stop is not undone; five quick deaths stop it', async () => {
  const { server, seen } = fakeOllama({ enabled: true });
  const reg = registry([server], { probe: async () => seen.up });
  assert.deepEqual(await reg.control('ollama', 'start'), { ok: true });
  seen.die(60000); // a long run, then a death: started again
  await tick();
  assert.equal(seen.starts.length, 2);
  for (let i = 0; i < 4; i++) {
    seen.die(1000);
    await tick();
  }
  assert.equal(seen.starts.length, 6, 'four quick deaths are started again');
  seen.die(1000); // the fifth in a row
  await tick();
  assert.equal(seen.starts.length, 6, 'the fifth quick death is not');
  const [row] = await reg.list();
  assert.match(row.error, /stopped 5 times in a row/);
  assert.equal(row.status, 'down');
  // Start tries again, and clears the count
  assert.deepEqual(await reg.control('ollama', 'start'), { ok: true });
  assert.equal(seen.starts.length, 7);
  assert.equal((await reg.list())[0].error, undefined);
  // a Stop is the user's: its exit is not undone
  assert.deepEqual(await reg.control('ollama', 'stop'), { ok: true });
  seen.die(1000);
  await tick();
  assert.equal(seen.starts.length, 7);
});

test('a dead `ollama serve` is not started again once the switch is off, once the Ollama app has the port, or once SecondBrain quits', async () => {
  let enabled = true;
  const off = fakeOllama({ getConfig: () => ({ ...DEFAULTS.services.ollama, enabled }) });
  await off.server.start();
  enabled = false;
  off.seen.die(60000);
  await tick();
  assert.equal(off.seen.starts.length, 1, 'switched off');

  const app = fakeOllama({ enabled: true });
  await app.server.start();
  app.seen.die(60000);
  app.seen.up = true; // the Ollama app came back on 11434
  await tick();
  assert.equal(app.seen.starts.length, 1, 'never over the Ollama app');

  const quit = fakeOllama({ enabled: true });
  await quit.server.start();
  quit.server.dispose();
  quit.seen.die(60000);
  await tick();
  assert.equal(quit.seen.starts.length, 1, 'SecondBrain is quitting');
});

test('a running `ollama serve` SecondBrain started can still be stopped after the switch is turned off', async () => {
  let enabled = true;
  const { server, seen } = fakeOllama({ getConfig: () => ({ ...DEFAULTS.services.ollama, enabled }) });
  const reg = registry([server], { probe: async () => seen.up });
  assert.deepEqual(await reg.control('ollama', 'start'), { ok: true });
  enabled = false;
  assert.deepEqual(await reg.control('ollama', 'stop'), { ok: true });
  assert.deepEqual(seen.killed, [77]);
  assert.deepEqual(await reg.control('ollama', 'start'), { ok: false, error: OLLAMA_EXTERNAL });
});

test("log gives the last N lines of an entry's own log (at most 500), and refuses an unknown id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'services-'));
  const file = path.join(dir, 'steward.log');
  fs.writeFileSync(file, Array.from({ length: 800 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n');
  const reg = registry([
    { id: 'steward', label: "Steward's service", port: 43120, logPath: () => file },
    { id: 'door', label: 'The door', port: 43111 },
  ]);
  assert.deepEqual(reg.log('steward', 3), { ok: true, file, text: 'line 798\nline 799\nline 800' });
  assert.equal(reg.log('steward', 100000).text.split('\n').length, 500);
  assert.deepEqual(reg.log('door', 10), { ok: true, file: null, text: '' });
  assert.deepEqual(reg.log('..\\..\\settings', 10), { ok: false, error: 'Unknown server: ..\\..\\settings' });
});

test('each entry says the pid SecondBrain runs it as and since when; a log named .env* is never read', async () => {
  const { server, seen } = fakeOllama({ enabled: true });
  const reg = registry([server, { id: 'door', label: 'The door', port: 43111, pid: () => 5, started: () => '2026-11-04T00:00:00.000Z' }], { probe: async () => seen.up });
  assert.deepEqual((await reg.list()).map((s) => [s.id, s.pid, s.started]), [['ollama', null, null], ['door', 5, '2026-11-04T00:00:00.000Z']]);
  await reg.control('ollama', 'start');
  const [row] = await reg.list();
  assert.equal(row.pid, 77);
  assert.equal(row.started, new Date(0).toISOString());
  await reg.control('ollama', 'stop');
  assert.equal((await reg.list())[0].pid, null, 'stopped: none');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'services-'));
  const keys = path.join(dir, '.env.local');
  fs.writeFileSync(keys, 'SECRET=1\n');
  const bad = registry([{ id: 'odd', label: 'Odd', port: 1, logPath: () => keys }]);
  const r = bad.log('odd', 10);
  assert.equal(r.ok, false);
  assert.match(r.error, /keys file/);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});
