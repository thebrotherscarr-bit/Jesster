const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('./console.cjs');

/** A Steward folder in a temp dir, with the files the console reads. */
function stewardDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-'));
  const put = (rel, text) => {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  return { dir, put };
}

test('a path outside his folder is refused', () => {
  const { dir } = stewardDir();
  assert.throws(() => c.inside(dir, '../outside.txt'), /outside Steward's folder/);
  assert.throws(() => c.inside(dir, ['..', '..', 'x']), /outside Steward's folder/);
  assert.throws(() => c.inside(dir, path.resolve(dir, '..', 'elsewhere')), /outside|refused/);
  assert.throws(() => c.inside(null, 'storage'), /not found/);
  assert.equal(c.inside(dir, 'storage/evals/history.jsonl'), path.join(dir, 'storage', 'evals', 'history.jsonl'));
});

test('any name starting with .env is refused, as a file, a folder or a memory read', () => {
  const { dir, put } = stewardDir();
  put('.env', 'KEY=secret');
  put('agent-file-memory/steward/.env.local', 'KEY=secret');
  put('agent-file-memory/steward/memories.md', '# his memory');
  assert.throws(() => c.inside(dir, '.env'), /\.env/);
  assert.throws(() => c.inside(dir, '.env.local'), /\.env/);
  assert.throws(() => c.inside(dir, '.ENV'), /\.env/);
  assert.throws(() => c.inside(dir, '.env/x'), /\.env/);
  assert.throws(() => c.readMemory(dir, 'agent-file-memory/steward/.env.local'), /refused/);
  assert.throws(() => c.readMemory(dir, '.env'), /refused/);
  assert.throws(() => c.readMemory(dir, 'storage/tool-policy.json'), /not one of his memory stores/);
  const files = c.listMemory(dir).map((f) => f.path);
  assert.deepEqual(files, ['agent-file-memory/steward/memories.md']);
  assert.equal(c.readMemory(dir, files[0]).text, '# his memory');
});

test('the tail read of a big file reads only its end, from a whole line', () => {
  const { dir, put } = stewardDir();
  const line = (i) => JSON.stringify({ i, pad: 'x'.repeat(90) });
  const lines = Array.from({ length: 50000 }, (_, i) => line(i));
  put('big.jsonl', lines.join('\n') + '\n');
  const file = path.join(dir, 'big.jsonl');
  const size = fs.statSync(file).size;
  assert.ok(size > 4 * 1024 * 1024);
  const realRead = fs.readSync;
  let asked = 0;
  fs.readSync = (fd, buf, off, len, pos) => {
    asked += len;
    assert.ok(pos >= size - 64 * 1024, `read at ${pos}, before the tail`);
    return realRead(fd, buf, off, len, pos);
  };
  try {
    const t = c.tailRead(file, 64 * 1024);
    assert.ok(asked <= 64 * 1024, `asked for ${asked} bytes`);
    assert.equal(t.size, size);
    const got = t.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(got[got.length - 1].i, 49999);
    assert.ok(got[0].i > 49000, 'only the end of the file');
  } finally {
    fs.readSync = realRead;
  }
});

test('the eval history parses newest first, with failed checks per case; the baseline is read', () => {
  const { dir, put } = stewardDir();
  const run = (ts, passed) => ({ ts, set: 'small', passed, total: 3, checks_passed: 8, checks_total: 14, exit_code: 1, model: 'steward:1', git_head: 'abc', cases: [{ input: 'Add a function', passed: false, failed_checks: [{ name: 'edit_keeps_file_whole', reason: 'no .py write' }] }] });
  put('storage/evals/history.jsonl', [run('2026-11-01T00:00:00Z', 1), '{half', run('2026-11-04T00:00:00Z', 2)].map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  put('harness/steward/step04_production_ready/eval_baselines.json', JSON.stringify({ small: { checks: 10, of: 14 } }));
  const e = c.readEvals(dir);
  assert.deepEqual(e.history.map((r) => r.passed), [2, 1]);
  assert.equal(e.history[0].checksPassed, 8);
  assert.deepEqual(e.history[0].cases[0].failed, [{ name: 'edit_keeps_file_whole', reason: 'no .py write' }]);
  assert.deepEqual(e.baseline, { small: { checks: 10, of: 14 } });
});

test('the traces tail is summarised by run: tools with arguments cut short, errors, pings only counted', () => {
  const span = (trace, name, extra = {}) => JSON.stringify({ trace_id: trace, span_id: name, parent_span_id: extra.parent ?? 'p', name, start_time: extra.at || '2026-11-04T10:00:00Z', end_time: extra.at || '2026-11-04T10:00:01Z', status: { code: extra.error ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK', message: extra.error || '' }, attributes: extra.attributes || {} });
  const text = [
    span('t1', 'workflow.run', { parent: '', at: '2026-11-04T10:00:00Z' }),
    span('t1', 'execute_tool.execute_tool run_shell', { at: '2026-11-04T10:00:02Z', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'run_shell', 'gen_ai.tool.call.arguments': JSON.stringify({ command: 'y'.repeat(500) }) } }),
    span('t2', 'invoke_agent.invoke_agent Steward', { parent: '', at: '2026-11-04T11:00:00Z', error: 'boom' }),
    span('t3', 'MCP send ping', { parent: '', error: 'method not found: server/discover' }),
  ].join('\n');
  const s = c.summarizeTraces(text);
  assert.deepEqual(s.runs.map((r) => r.traceId), ['t2', 't1']);
  assert.equal(s.runs[1].tools[0].name, 'run_shell');
  assert.ok(s.runs[1].tools[0].args.length <= 161);
  assert.deepEqual(s.runs[0].errors, [{ name: 'invoke_agent.invoke_agent Steward', message: 'boom' }]);
  assert.equal(s.background, 1);
  assert.equal(s.backgroundErrors, 1);
});

test('skills come from SKILL.md frontmatter', () => {
  const { dir, put } = stewardDir();
  put('harness/steward/skills/estate/SKILL.md', '---\r\nname: estate\r\ndescription: The map of the estate.\r\n---\r\n\r\n## Usage\r\n');
  put('harness/steward/skills/bare/SKILL.md', 'no frontmatter');
  put('harness/steward/skills/empty/README.md', 'not a skill');
  assert.deepEqual(c.readSkills(dir), [
    { folder: 'bare', name: 'bare', description: '' },
    { folder: 'estate', name: 'estate', description: 'The map of the estate.' },
  ]);
});

test('main registers the console and preload exposes each of its channels', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  assert.match(main, /require\('\.\/console\.cjs'\)\.register\(\{ ipcMain, guard, stewardDir: /);
  const handlers = {};
  c.register({ ipcMain: { handle: (ch) => (handlers[ch] = 1) }, guard: () => {}, stewardDir: () => null });
  for (const ch of Object.keys(handlers)) assert.ok(preload.includes(`ipcRenderer.invoke('${ch}'`), `preload exposes ${ch}`);
});

test('register guards every channel and reads from the folder it is given', async () => {
  const { dir, put } = stewardDir();
  put('agent-file-memory/steward/memories.md', 'm');
  const handlers = {};
  let guarded = 0;
  c.register({ ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) }, guard: () => guarded++, stewardDir: () => dir });
  assert.deepEqual(Object.keys(handlers).sort(), ['console:evals', 'console:memory', 'console:memory-read', 'console:runs', 'console:skills']);
  assert.equal((await handlers['console:memory-read']({}, 'agent-file-memory/steward/memories.md')).text, 'm');
  assert.throws(() => handlers['console:memory-read']({}, '../x'), /refused/);
  assert.equal(guarded, 2);
});
