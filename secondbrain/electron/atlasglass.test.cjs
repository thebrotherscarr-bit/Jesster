const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { boot, superviseGlass, openWindow, findGround, serviceWire, openSitting, GLASS_URL } = require('./atlasglass.cjs');

function ground() {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'atlasglass-'));
  fs.writeFileSync(path.join(g, 'manjuel.py'), '');
  fs.mkdirSync(path.join(g, 'atlas', 'webapp'), { recursive: true });
  fs.writeFileSync(path.join(g, 'atlas', 'webapp', 'atlas-webapp.exe'), '');
  fs.mkdirSync(path.join(g, 'worlds', 'notes'), { recursive: true });
  return g;
}

/** boot() with every outside act recorded instead of done. */
function harness(g, { on8090 = null, sittingN = '' } = {}) {
  const seen = { killed: [], listened: [], supervised: [] };
  let held = Boolean(on8090);
  const opts = {
    settingsGround: g,
    vaultDir: '',
    door: { name: 'the door' },
    probe: async (port) => port === 8090 && held,
    owner: () => on8090,
    kill: (pid) => {
      seen.killed.push(pid);
      held = false;
    },
    sitting: () => sittingN,
    listenFn: async (d, o) => seen.listened.push({ door: d.name, wire: o.wire }),
    supervise: (gr, wire) => seen.supervised.push({ ground: gr, wire }),
    wait: async () => true,
  };
  return { seen, opts };
}

test('at start SecondBrain is the door on 8090 and runs the glass, both on the .env wire', async () => {
  const g = ground();
  fs.writeFileSync(path.join(g, '.env'), 'OTHER=x\nATLAS_SERVICE="wire-value"\n');
  const { seen, opts } = harness(g);
  const r = await boot(opts);
  assert.deepStrictEqual(r, { ground: g, wire: 'wire-value' });
  assert.deepStrictEqual(seen.listened, [{ door: 'the door', wire: 'wire-value' }]);
  assert.deepStrictEqual(seen.supervised, [{ ground: g, wire: 'wire-value' }]);
  assert.deepStrictEqual(seen.killed, []);
});

test('with no wire in .env one is made fresh, and the door and the glass share it', async () => {
  const g = ground();
  const { seen, opts } = harness(g);
  const r = await boot(opts);
  assert.match(r.wire, /^[0-9a-f]{48}$/);
  assert.strictEqual(seen.listened[0].wire, r.wire);
  assert.strictEqual(seen.supervised[0].wire, r.wire);
});

test('an old atlas-mcp.exe on 8090 is stopped, by its pid, and SecondBrain takes the port', async () => {
  const g = ground();
  const { seen, opts } = harness(g, { on8090: { pid: 4242, name: 'atlas-mcp.exe' } });
  const r = await boot(opts);
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(seen.killed, [4242]);
  assert.strictEqual(seen.listened.length, 1);
});

test('anything else on 8090 is left alone and said, and nothing is started', async () => {
  const g = ground();
  const { seen, opts } = harness(g, { on8090: { pid: 7, name: 'python.exe' } });
  const r = await boot(opts);
  assert.match(r.error, /Port 8090 is held by python\.exe/);
  assert.deepStrictEqual(seen.killed, []);
  assert.deepStrictEqual(seen.listened, []);
  assert.deepStrictEqual(seen.supervised, []);
});

test('an old door is never stopped while a sitting is open (RULE 9)', async () => {
  const g = ground();
  const { seen, opts } = harness(g, { on8090: { pid: 4242, name: 'atlas-mcp.exe' }, sittingN: '465' });
  const r = await boot(opts);
  assert.match(r.error, /Sitting 465 is open/);
  assert.deepStrictEqual(seen.killed, []);
  assert.deepStrictEqual(seen.listened, []);
});

test('no ground, or a port the door cannot take, is said plainly', async () => {
  const none = harness(null).opts;
  none.settingsGround = '';
  none.vaultDir = os.tmpdir();
  assert.match((await boot(none)).error, /Settings → Atlas & Manjuel/);
  const g = ground();
  const { opts } = harness(g);
  opts.listenFn = async () => {
    throw new Error('port 8090 is taken by another program');
  };
  assert.match((await boot(opts)).error, /port 8090 is taken/);
});

function fakeChild() {
  const c = new EventEmitter();
  c.exitCode = null;
  c.kill = () => {
    c.exitCode = 1;
    c.emit('exit', 1);
  };
  return c;
}

test('the glass is SecondBrain\'s child: the wire in its environment, never its arguments; started again when it stops; stopped for good on stop()', async () => {
  const g = ground();
  const starts = [];
  const sup = superviseGlass(g, 'wire-value', {
    delay: 5,
    probe: async () => false,
    start: (exe, args, cwd, env, logs) => {
      const c = fakeChild();
      starts.push({ exe: path.win32.basename(exe), args, cwd, wire: env.ATLAS_SERVICE, logs, c });
      return c;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(starts.length, 1);
  assert.deepStrictEqual(starts[0].exe, 'atlas-webapp.exe');
  assert.deepStrictEqual(starts[0].args, []);
  assert.strictEqual(starts[0].wire, 'wire-value');
  assert.strictEqual(starts[0].cwd, path.join(g, 'atlas', 'webapp'));
  starts[0].c.exitCode = 0;
  starts[0].c.emit('exit', 0); // Atlas's Update stopped it
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(starts.length, 2, 'started again');
  sup.stop();
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(starts.length, 2, 'and not after stop()');
});

test('a glass already answering is used, not started over; five quick deaths stop the restarts', async () => {
  const g = ground();
  let started = 0;
  const busy = superviseGlass(g, 'w', { delay: 5, probe: async () => true, start: () => (started++, fakeChild()) });
  await new Promise((r) => setTimeout(r, 30));
  busy.stop();
  assert.strictEqual(started, 0);
  const dying = superviseGlass(g, 'w', {
    delay: 1,
    probe: async () => false,
    start: () => {
      started++;
      const c = fakeChild();
      setImmediate(() => c.emit('exit', 1));
      return c;
    },
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(started, 5);
  assert.match(dying.error, /stopped five times in a row/);
  dying.stop();
});

test('an open sitting is read off the ledger: its `ended` is ""', () => {
  const g = ground();
  assert.strictEqual(openSitting(g), '');
  fs.mkdirSync(path.join(g, 'sessions'));
  fs.writeFileSync(path.join(g, 'sessions', 'sessions.jsonl'), '{"n":464,"ended":"2026-10-22T16:44:29"}\r\n{"n":465,"ended":""}\r\n');
  assert.strictEqual(openSitting(g), '465');
  fs.appendFileSync(path.join(g, 'sessions', 'sessions.jsonl'), '{"n":465,"ended":"2026-10-23T09:00:00"}\n');
  assert.strictEqual(openSitting(g), '');
});

test('the web app opens in an app window: Chrome first, then Edge, then the default browser', () => {
  const launched = [];
  const external = [];
  const launch = (exe, args) => launched.push([path.win32.basename(exe), args]);
  const openExternal = (u) => external.push(u);
  const both = (parts) => (parts.includes('chrome.exe') || parts.includes('msedge.exe') ? 'C:\\x\\' + parts[parts.length - 1] : '');
  assert.strictEqual(openWindow(GLASS_URL, { find: both, launch, openExternal }), 'chrome');
  assert.deepStrictEqual(launched[0], ['chrome.exe', [`--app=${GLASS_URL}`, '--window-size=1440,920']]);
  const edgeOnly = (parts) => (parts.includes('msedge.exe') ? 'C:\\x\\msedge.exe' : '');
  assert.strictEqual(openWindow(GLASS_URL, { find: edgeOnly, launch, openExternal }), 'edge');
  assert.strictEqual(launched[1][0], 'msedge.exe');
  assert.strictEqual(openWindow(GLASS_URL, { find: () => '', launch, openExternal }), 'browser');
  assert.deepStrictEqual(external, [GLASS_URL]);
});

test('the ground and the wire', () => {
  const g = ground();
  assert.strictEqual(findGround('', path.join(g, 'worlds', 'notes')), g);
  assert.strictEqual(findGround(g, ''), g);
  assert.strictEqual(findGround('', os.tmpdir()), null);
  assert.strictEqual(serviceWire(g), '');
  fs.writeFileSync(path.join(g, '.env'), "ATLAS_SERVICE='w'\r\n");
  assert.strictEqual(serviceWire(g), 'w');
});
