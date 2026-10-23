const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { build } = require('./index.cjs');
const { hostOf } = require('./git.cjs');

const CLIENT = { name: 'seat', service: false };
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A world that is its own repository, on main, with one save and the work in progress the tests read. */
function repo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'door-git-'));
  git(home, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(home, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(home, '.gitignore'), 'data/\n');
  git(home, 'add', '-A');
  git(home, 'commit', '-q', '-m', 'first save');
  fs.writeFileSync(path.join(home, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(home, 'new.txt'), 'brand new');
  fs.mkdirSync(path.join(home, 'data'));
  fs.writeFileSync(path.join(home, 'data', 'x.txt'), 'kept out');
  fs.writeFileSync(path.join(home, '.env'), 'NEVER=served');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'door-nogit-'));
  return { home, plain, reg: build([['w', home], ['plain', plain]], { defaultProject: 'w' }) };
}

test('git reads the repository as it stands, and says the wall is shut', { skip: !hasGit && 'git is not installed' }, async () => {
  const { reg } = repo();
  const g = JSON.parse(await reg.call('git', {}, CLIENT));
  assert.equal(g.is_repo, true);
  assert.equal(g.branch, 'main');
  assert.equal(g.subject, 'first save');
  assert.equal(g.changed, 1);
  assert.equal(g.untracked, 2, 'new.txt and .env; data/ is ignored');
  assert.equal(g.dirty, true);
  assert.equal(typeof g.remote_allowed, 'boolean');
  assert.equal(g.why_not_send, undefined, 'origin has no main, so nothing is said');
  const plainOut = JSON.parse(await reg.call('git', { project: 'plain' }, CLIENT));
  assert.deepEqual(plainOut, { is_repo: false, note: 'not a repository -- nothing to commit, and nothing to lose', world: 'plain' });
});

test('git_diff serves a change, a new file plainly, and refuses keys, ignored files and the outside', { skip: !hasGit && 'git is not installed' }, async () => {
  const { reg } = repo();
  assert.match(await reg.call('git_diff', { file: 'a.txt' }, CLIENT), /\+two/);
  assert.match(await reg.call('git_diff', {}, CLIENT), /^diff --git a\/a.txt b\/a.txt/);
  assert.equal(await reg.call('git_diff', { file: 'new.txt' }, CLIENT), 'This file is new -- git has never seen it, so there is nothing to compare it against. Its contents:\n\nbrand new');
  assert.match(await reg.call('git_diff', { file: '.env' }, CLIENT), /holds this estate's keys/);
  assert.match(await reg.call('git_diff', { file: 'data/x.txt' }, CLIENT), /this world's git ignores data\/x.txt/);
  assert.equal(await reg.call('git_diff', { file: '../x' }, CLIENT), 'Refused: that path resolves outside this world.');
  assert.equal(await reg.call('git_diff', { file: 'C:\\x' }, CLIENT), 'Refused: an absolute path is outside this world.');
  assert.equal(await reg.call('git_diff', { project: 'plain' }, CLIENT), 'not a repository -- nothing to review');
});

test('git_remote names each remote by its host only', { skip: !hasGit && 'git is not installed' }, async () => {
  const { reg, home } = repo();
  assert.deepEqual(JSON.parse(await reg.call('git_remote', {}, CLIENT)).remotes, null);
  git(home, 'remote', 'add', 'origin', 'https://user:tok@github.com/me/repo.git');
  const r = JSON.parse(await reg.call('git_remote', {}, CLIENT));
  assert.deepEqual(r.remotes, [{ name: 'origin', url: 'https://user:tok@github.com/me/repo.git', host: 'github.com' }]);
  assert.match(await reg.call('git_remote', { project: 'plain' }, CLIENT), /^Refused: this world is not a repository/);
  assert.equal(hostOf('git@github.com:me/repo.git'), 'github.com');
});

test('projects lists what the maker made off each project\'s own history, and serves a page at a version', { skip: !hasGit && 'git is not installed' }, async () => {
  const { reg, home } = repo();
  assert.deepEqual(JSON.parse(await reg.call('projects', {}, CLIENT)), { count: 0, projects: [], world: 'w' });
  const dir = path.join(home, 'projects', 'my-page');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>one</p>\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Version 1: the first page');
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>two</p>\n<p>more</p>\n');
  git(dir, 'commit', '-q', '-am', 'Version 2: more');
  fs.mkdirSync(path.join(home, 'projects', 'no-history'));
  const list = JSON.parse(await reg.call('projects', {}, CLIENT));
  assert.equal(list.count, 1);
  const [p] = list.projects;
  assert.deepEqual(Object.keys(p), ['name', 'versions', 'bytes', 'lines', 'updated']);
  assert.deepEqual(p.versions.map((v) => v.note), ['the first page', 'more']);
  assert.equal(p.lines, 2);
  const now = JSON.parse(await reg.call('projects', { action: 'page', name: 'my-page' }, CLIENT));
  assert.equal(now.version, 2);
  assert.equal(now.text, '<p>two</p>\n<p>more</p>\n');
  const raw = await reg.call('projects', { action: 'page', name: 'my-page', version: '1' }, CLIENT);
  assert.ok(raw.includes('"text": "<p>one</p>\\n"'), 'a page is not HTML-escaped');
  await assert.rejects(reg.call('projects', { action: 'page', name: 'my-page', version: '9' }, CLIENT), /there is no version 9 -- my-page has versions 1 to 2/);
  await assert.rejects(reg.call('projects', { action: 'page', name: '../x' }, CLIENT), /a project's name is lowercase letters/);
  await assert.rejects(reg.call('projects', { action: 'page', name: 'no-history' }, CLIENT), /no history of its own/);
  await assert.rejects(reg.call('projects', { action: 'burn' }, CLIENT), /projects takes action list or page, not "burn"/);
});
