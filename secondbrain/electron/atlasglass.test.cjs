const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureGlass, openWindow, findGround, serviceWire, doorArgs, GLASS_URL } = require('./atlasglass.cjs');

function ground() {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'atlasglass-'));
  fs.writeFileSync(path.join(g, 'manjuel.py'), '');
  fs.mkdirSync(path.join(g, 'atlas', 'line'), { recursive: true });
  fs.mkdirSync(path.join(g, 'atlas', 'webapp'), { recursive: true });
  fs.writeFileSync(path.join(g, 'atlas', 'line', 'atlas-mcp.exe'), '');
  fs.writeFileSync(path.join(g, 'atlas', 'webapp', 'atlas-webapp.exe'), '');
  fs.mkdirSync(path.join(g, 'worlds', 'notes'), { recursive: true });
  return g;
}

test('a glass already answering is used as it is, and nothing is started', async () => {
  const started = [];
  const out = await ensureGlass({ settingsGround: '', vaultDir: '', probe: async () => true, start: (...a) => started.push(a) });
  assert.deepStrictEqual(out, { url: GLASS_URL });
  assert.strictEqual(started.length, 0);
});

test('nothing answering: the door then the glass are started, from the ground two up from the notes', async () => {
  const g = ground();
  fs.writeFileSync(path.join(g, '.env'), 'OTHER=x\nATLAS_SERVICE="wire-value"\n');
  const up = new Set();
  const started = [];
  const out = await ensureGlass({
    settingsGround: '',
    vaultDir: path.join(g, 'worlds', 'notes'),
    probe: async (port) => up.has(port),
    start: (exe, args, cwd, env, logs) => {
      started.push({ exe: path.basename(exe), args, cwd, wire: env.ATLAS_SERVICE, logs });
      up.add(exe.endsWith('atlas-mcp.exe') ? 8090 : 8091);
    },
    wait: async (port, ms, probe) => probe(port),
  });
  assert.deepStrictEqual(out, { url: GLASS_URL });
  assert.deepStrictEqual(started.map((s) => s.exe), ['atlas-mcp.exe', 'atlas-webapp.exe']);
  assert.strictEqual(started[0].cwd, path.join(g, 'atlas', 'line'));
  assert.deepStrictEqual(started[0].logs, ['mcp.log', 'mcp.err.log']);
  assert.strictEqual(started[1].cwd, path.join(g, 'atlas', 'webapp'));
  assert.ok(started.every((s) => s.wire === 'wire-value'), 'the service wire rides in the environment');
  assert.ok(!started.some((s) => s.args.join(' ').includes('wire-value')), 'and never on a command line');
});

test('a door already answering is left alone; only the glass starts', async () => {
  const g = ground();
  const up = new Set([8090]);
  const started = [];
  await ensureGlass({
    settingsGround: g, vaultDir: '',
    probe: async (port) => up.has(port),
    start: (exe) => { started.push(path.basename(exe)); up.add(8091); },
    wait: async (port, ms, probe) => probe(port),
  });
  assert.deepStrictEqual(started, ['atlas-webapp.exe']);
});

test('no ground, or a glass that never answers, is said plainly', async () => {
  const none = await ensureGlass({ settingsGround: '', vaultDir: os.tmpdir(), probe: async () => false });
  assert.match(none.error, /Settings → Atlas & Manjuel/);
  const g = ground();
  const dead = await ensureGlass({ settingsGround: g, vaultDir: '', probe: async () => false, start: () => {}, wait: async () => false });
  assert.match(dead.error, /did not answer on port 8091/);
});

test('the web app opens in an app window: Chrome first, then Edge, then the default browser', () => {
  const launched = [];
  const external = [];
  const launch = (exe, args) => launched.push([path.win32.basename(exe), args]); // a Windows path, read as one on any machine
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

test('the ground, the wire and the door line', () => {
  const g = ground();
  assert.strictEqual(findGround('', path.join(g, 'worlds', 'notes')), g);
  assert.strictEqual(findGround(g, ''), g);
  assert.strictEqual(findGround('', os.tmpdir()), null);
  assert.strictEqual(serviceWire(g), '');
  fs.writeFileSync(path.join(g, '.env'), "ATLAS_SERVICE='w'\r\n");
  assert.strictEqual(serviceWire(g), 'w');
  const args = doorArgs('C:\\R');
  assert.deepStrictEqual(args.slice(0, 3), ['--http', '127.0.0.1:8090', '--auth']);
  assert.ok(args.includes('research=C:/R') && args.includes('atlas=C:/R/atlas') && args.includes('python C:/R/manjuel.py'));
});
