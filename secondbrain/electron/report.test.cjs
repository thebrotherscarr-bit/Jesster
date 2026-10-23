const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const report = require('./report.cjs');
const { DEFAULTS, merge } = require('./settings.cjs');

const tg = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQx';
const settings = merge(DEFAULTS, {
  telegram: { token: tg, enabled: true, allowedChats: [42] },
  share: { enabled: true, writes: false, key: 'f'.repeat(48) },
  computer: { enabled: true },
});

test('the note says what is on and connected, and nothing secret', () => {
  const text = report.scrub(
    report.build({
      build: { build: 23, commit: 'abc1234' },
      settings,
      inbox: { clone: path.join(os.homedir(), 'Documents', 'secondbrain-bridge'), every: 5, error: null, last: { at: 'now', filed: [1, 2] } },
      mcp: [
        { name: 'atlas', status: 'connected', tools: new Array(96).fill('t'), offered: 27, trusted: false, error: null },
        { name: 'other', status: 'error', tools: [], error: `exited (1). token=${tg} Authorization: Bearer abcdef123456` },
      ],
      ollama: { ok: true, models: [{ name: 'gpt-oss:20b' }, { name: 'qwen3-vl:8b', capabilities: ['vision'] }] },
      notes: 312,
      note: 'Atlas looks good',
    }),
    [settings.telegram.token, settings.share.key]
  );
  assert.match(text, /build 23/);
  assert.match(text, /atlas: connected · 27 of 96 tools offered/);
  assert.match(text, /Computer use on \(ask each: on\)/);
  assert.match(text, /Share with Atlas & Manjuel on \(writes off\)/);
  assert.match(text, /qwen3-vl:8b \(sees\)/);
  assert.match(text, /Notes in the vault: 312/);
  assert.match(text, /## Note from the user\n\nAtlas looks good/);
  assert.match(text, /paired chats: 1/);
  assert.ok(!text.includes(tg) && !text.includes('f'.repeat(48)) && !text.includes('abcdef123456'));
  assert.ok(!text.includes(os.homedir()));
});

test('pushes outbox/status.md to the bridge with git', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-report-'));
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  g(tmp, 'init', '--bare', '-q', 'remote.git');
  g(tmp, 'clone', '-q', path.join(tmp, 'remote.git'), 'seed');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(path.join(seed, 'inbox'));
  fs.writeFileSync(path.join(seed, 'inbox', 'a.md'), 'hi');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed');
  g(seed, 'push', '-q', 'origin', 'HEAD');
  g(tmp, 'clone', '-q', path.join(tmp, 'remote.git'), 'app');
  const r = await report.push(path.join(tmp, 'app'), '# status one\n', { buildNo: 23 });
  assert.equal(r.file, 'outbox/status.md');
  // meanwhile someone else pushes to the bridge; the next report still lands
  g(seed, 'pull', '-q', '--ff-only');
  fs.writeFileSync(path.join(seed, 'inbox', 'b.md'), 'more');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'more');
  g(seed, 'push', '-q', 'origin', 'HEAD');
  await report.push(path.join(tmp, 'app'), '# status two\n', { buildNo: 24 });
  g(tmp, 'clone', '-q', path.join(tmp, 'remote.git'), 'check');
  // Windows git may check it out with CRLF line endings
  assert.equal(fs.readFileSync(path.join(tmp, 'check', 'outbox', 'status.md'), 'utf8').replace(/\r\n/g, '\n'), '# status two\n');
  assert.ok(fs.existsSync(path.join(tmp, 'check', 'inbox', 'b.md')));
  assert.match(g(path.join(tmp, 'check'), 'log', '--format=%s', '-3'), /report: build 24\nmore\nreport: build 23/);
  await assert.rejects(report.push(path.join(tmp, 'nope'), 'x', { buildNo: 1 }), /connect the inbox first/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
