const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findCli, ArchiveRunner } = require('./archive.cjs');

const CLI = path.resolve(__dirname, '..', '..', 'notes', 'cli.py');
const PYTHON = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const skip = !PYTHON || !fs.existsSync(CLI) ? 'needs Python and the notes kernel' : false;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-archive-'));

/** Ollama for the distiller: every chunk is about "SecondBrain", slowly if asked. */
function fakeOllama({ delay = 0 } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const msg = JSON.parse(body);
      seen.push(msg);
      const src = /### \[([a-z0-9-]+)\]/.exec(msg.messages.at(-1).content)[1];
      const out = {
        topics: [{ name: 'SecondBrain', summary: `from ${src}`, source: src }],
        decisions: [], ideas: [], threads: [],
        events: [{ date: '2026-10-01', text: `read ${src}`, source: src }],
      };
      setTimeout(() => res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(out) } })), delay);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

/** A vault the kernel can write to, pointed at the fake Ollama, small chunks. */
function vault(url) {
  const dir = path.join(tmp(), 'notes');
  fs.mkdirSync(path.join(dir, '.jesster'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.jesster', 'config.json'), JSON.stringify({ actor: 'test', ollama_url: url, archive_chunk: 150 }));
  return dir;
}

function source() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\n\nBuild the archive digger first.\n');
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `tool${i}.py`), `def tool_${i}():\n    return ${i}\n`);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'junk');
  return dir;
}

test('the kernel is found in the setting, else beside the vault as a Manjuel ground lays it out', () => {
  const ground = tmp();
  const vaultDir = path.join(ground, 'worlds', 'notes');
  const cli = path.join(ground, 'worlds', 'jesster', 'notes', 'cli.py');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.mkdirSync(vaultDir, { recursive: true });
  assert.equal(findCli('', vaultDir), null);
  fs.writeFileSync(cli, '');
  assert.equal(findCli('', vaultDir), cli);
  assert.equal(findCli(cli, '/elsewhere'), cli);
  assert.equal(findCli(path.join(ground, 'missing.py'), vaultDir), null);
});

test('no kernel found is said plainly', async () => {
  const r = new ArchiveRunner({ config: () => ({ vaultDir: tmp() }) });
  await assert.rejects(r.status(), /not found beside this vault/);
  assert.match(r.state.error, /Settings → Archive/);
});

test('a kernel that will not start is an error, not a hang', { skip }, async () => {
  const r = new ArchiveRunner({ config: () => ({ python: PYTHON, cli: __filename, vaultDir: tmp() }) });
  await assert.rejects(r.status(), /stopped/);
});

test('sources, dig, distill and write, through the real kernel', { skip }, async () => {
  const { srv, seen, url } = await fakeOllama();
  const states = [];
  let changed = 0;
  const vaultDir = vault(url);
  const src = source();
  const r = new ArchiveRunner({
    config: () => ({ python: PYTHON, cli: CLI, vaultDir }),
    onState: (s) => states.push(s),
    onNotes: () => changed++,
  });
  try {
    assert.deepEqual(await r.sources({ add: src }), [src]);
    await r.dig();
    assert.ok(r.state.status.raw_notes >= 5, `raw notes: ${r.state.status.raw_notes}`);
    assert.ok(!fs.readdirSync(vaultDir).some((f) => f.includes('junk')));
    assert.equal(changed, 1, 'the app is told the vault changed');

    const p = await r.distill();
    assert.equal(p.finished, true);
    assert.equal(p.topics, 1);
    assert.ok(seen.length > 1, 'more than one step');
    assert.ok(seen.every((m) => m.format && m.stream === false));
    assert.ok(states.some((s) => s.job === 'distilling' && s.status && s.status.distill.notes_done < s.status.distill.notes_total), 'progress shown while it runs');

    await r.write();
    const topic = fs.readFileSync(path.join(vaultDir, 'archive-topic-secondbrain.md'), 'utf8');
    assert.match(topic, /\[\[archive-file-/);
    assert.ok(fs.existsSync(path.join(vaultDir, 'archive-timeline.md')));
    assert.equal(changed, 2);
    assert.equal(r.state.job, null);
  } finally {
    r.stop();
    srv.close();
  }
});

test('pause finishes the step in hand; stop ends it; distill resumes either way', { skip }, async () => {
  const { srv, url } = await fakeOllama({ delay: 150 });
  const vaultDir = vault(url);
  let onStep = () => {};
  const r = new ArchiveRunner({
    config: () => ({ python: PYTHON, cli: CLI, vaultDir }),
    onState: (s) => s.job === 'distilling' && s.status && s.status.distill && s.status.distill.chunks > 0 && onStep(),
  });
  try {
    await r.sources({ add: source() });
    await r.dig();

    const stepped = new Promise((ok) => (onStep = ok));
    const run = r.distill();
    await stepped;
    onStep = () => {};
    assert.equal(r.state.job, 'distilling');
    await assert.rejects(r.dig(), /already distilling/);
    r.pause();
    const paused = await run;
    assert.equal(paused.finished, false);
    assert.ok(paused.notes_done > 0);

    const run2 = r.distill();
    await new Promise((ok) => setTimeout(ok, 200));
    r.stop();
    await assert.rejects(run2, /stopped/);
    assert.equal(r.state.error, null, 'a stop is not an error');

    const done = await r.distill();
    assert.equal(done.finished, true);
    assert.ok(done.notes_done >= paused.notes_done);
  } finally {
    r.stop();
    srv.close();
  }
});
