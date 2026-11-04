const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registry, ollamaServer, stewardEntry, OLLAMA_EXTERNAL } = require('./services.cjs');
const { DEFAULTS } = require('./settings.cjs');

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
function fakeOllama({ enabled = false, answering = false } = {}) {
  const seen = { starts: [], killed: [], up: answering };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'services-'));
  const server = ollamaServer({
    getConfig: () => ({ ...DEFAULTS.services.ollama, enabled }),
    logDir: dir,
    probe: async () => seen.up,
    wait: async (port, ms, probe, gone) => (gone ? !seen.up : seen.up),
    find: () => 'C:\\fake\\ollama.exe',
    start: (exe, args, cwd, env, logs) => {
      seen.starts.push({ exe, args, cwd, env, logs });
      seen.up = true;
      return { pid: 77, exitCode: null };
    },
    killTree: (pid) => {
      seen.killed.push(pid);
      seen.up = false;
    },
    base: { PATH: 'C:\\Windows', OLLAMA_MODELS: 'D:\\models', HSA_OVERRIDE_GFX_VERSION: '10.3.0', OLLAMA_KV_CACHE_TYPE: 'f16' },
  });
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
  for (const opts of [{ enabled: false }, { enabled: true, answering: true }]) {
    const { server, seen } = fakeOllama(opts);
    const reg = registry([server], { probe: async () => seen.up });
    for (const action of ['start', 'stop', 'restart']) assert.deepEqual(await reg.control('ollama', action), { ok: false, error: OLLAMA_EXTERNAL });
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
