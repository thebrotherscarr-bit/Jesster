const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Vault } = require('./vaultfs.cjs');
const { connect, sync } = require('./inbox.cjs');
const { Settings } = require('./settings.cjs');

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();
const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
Object.assign(process.env, env);

test('inbox notes land in the vault once, and again when they change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
  const bare = path.join(root, 'bridge.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const writer = path.join(root, 'writer');
  g(root, 'clone', '-q', bare, writer);
  g(writer, 'checkout', '-q', '-b', 'main');
  fs.mkdirSync(path.join(writer, 'inbox'));
  const note = (body) => `---\nid: x\ntitle: "Hermes diff"\ncategory: resources\npinned: true\ntags: [hermes]\n` +
    `created: 2026-10-21T23:00:00+0000\nupdated: 2026-10-21T23:00:00+0000\n---\n\n${body}`;
  fs.writeFileSync(path.join(writer, 'inbox', 'claude-hermes-diff.md'), note('first'));
  g(writer, 'add', '-A');
  g(writer, 'commit', '-q', '-m', 'note');
  g(writer, 'push', '-q', 'origin', 'main');

  const parent = path.join(root, 'Documents');
  fs.mkdirSync(parent);
  const { dir, cloned } = await connect(parent, bare);
  assert.equal(cloned, true);
  assert.equal((await connect(parent, bare)).cloned, false, 'second connect reuses the clone');

  const vault = new Vault(path.join(root, 'vault'));
  let r = await sync(dir, vault);
  assert.equal(r.pulled, 'ok');
  assert.deepEqual(r.filed.map((f) => f.title), ['Hermes diff']);
  const n = vault.load()[0];
  assert.equal(n.id, 'claude-hermes-diff');
  assert.ok(n.isPinned && n.tags.includes('inbox') && n.tags.includes('hermes'));

  assert.equal((await sync(dir, vault)).filed.length, 0, 'unchanged notes are not filed twice');

  fs.writeFileSync(path.join(writer, 'inbox', 'claude-hermes-diff.md'), note('second'));
  g(writer, 'commit', '-qam', 'edit');
  g(writer, 'push', '-q', 'origin', 'main');
  r = await sync(dir, vault);
  assert.equal(r.filed.length, 1);
  assert.equal(vault.load()[0].content, 'second');
});

test('settings keep defaults, merge sections, and never show the bot token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({ dir: 'D:\\Notes' }));
  const s = new Settings(dir);
  assert.equal(s.get('vaultDir'), 'D:\\Notes', 'the old vault.json is honoured');
  assert.equal(s.get('agent').model, 'gpt-oss:20b');
  s.set('telegram', { token: '123456:SECRET-abcd', enabled: true });
  const again = new Settings(dir);
  assert.equal(again.get('telegram').enabled, true);
  assert.deepEqual(again.get('telegram').allowedChats, []);
  assert.equal(again.public().telegram.token, '••••••abcd');
});
