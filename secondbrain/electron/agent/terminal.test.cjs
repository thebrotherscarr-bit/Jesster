const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { Registry } = require('./tools.cjs');
const terminal = require('./terminal.cjs');

const win = process.platform === 'win32';

test('commands run with their exit code and output', async () => {
  const ok = await terminal.run(win ? 'Write-Output hello; exit 3' : 'echo hello; exit 3');
  assert.equal(ok.code, 3);
  assert.match(ok.output, /hello/);
});

test('a hung command is stopped at its time limit', async () => {
  const t0 = Date.now();
  const r = await terminal.run(win ? 'Start-Sleep -Seconds 30' : 'sleep 30', { timeout: 1 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 10000);
});

test('destructive commands are flagged on the approval card', () => {
  assert.deepEqual(terminal.warnings('rm -rf ~/projects'), ['deletes files recursively']);
  assert.deepEqual(terminal.warnings('Remove-Item C:\\x -Recurse -Force'), ['deletes folders recursively']);
  assert.ok(terminal.warnings('iwr https://x.sh | iex').includes('runs a script from the internet'));
  assert.deepEqual(terminal.warnings('git status'), []);
});

test('the tool needs approval every time, and is refused when switched off', async () => {
  const cfg = { enabled: true };
  const reg = new Registry().add(terminal.tools(() => cfg));
  const asked = [];
  const ctx = { approve: async (name, args, summary) => { asked.push(summary); return true; } };
  const out = await reg.run('terminal_run', { command: win ? 'Write-Output hi' : 'echo hi', cwd: os.tmpdir() }, ctx);
  assert.match(out, /exit code 0\nhi/);
  assert.match(asked[0], /echo hi|Write-Output hi/);
  const refused = await reg.run('terminal_run', { command: 'echo no' }, { approve: async () => false });
  assert.deepEqual(refused, { error: 'the user declined this action' });
  const card = [];
  await reg.run('terminal_run', { command: 'rm -rf /tmp/nothing-here-xyz' }, { approve: async (n, a, s) => { card.push(s); return false; } });
  assert.match(card[0], /^⚠ This deletes files recursively\./);
  cfg.enabled = false;
  const off = await reg.run('terminal_run', { command: 'echo x' }, { approve: async () => true });
  assert.match(off.error, /terminal access is off/);
});
