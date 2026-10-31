const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const door = require('./index.cjs');
const { gitctlTools, gh, prChecks, prWaitOf, badTagName, cargoVersion } = require('./gitctl.cjs');
const { gitTools } = require('./git.cjs');

// Every repository here is a throwaway: its "GitHub" is a bare repository in the same temp folder,
// and gh is a stand-in, so nothing in this file reaches a network.
const ID = ['-c', 'user.name=Tester', '-c', 'user.email=tester@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
const git = (dir, ...a) => execFileSync('git', [...ID, ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function world({ version = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitctl-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', 'main', origin);
  const home = path.join(root, 'w');
  git(root, 'clone', '-q', origin, home);
  for (const [k, v] of [['user.name', 'Tester'], ['user.email', 'tester@localhost'], ['commit.gpgsign', 'false']]) git(home, 'config', k, v);
  fs.appendFileSync(path.join(home, '.git', 'info', 'exclude'), 'state/\n'); // the door's own records, as a world keeps them out
  git(home, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(home, 'a.txt'), 'one\n');
  if (version) fs.writeFileSync(path.join(home, 'VERSION'), version + '\n');
  git(home, 'add', '-A');
  git(home, 'commit', '-q', '-m', 'first');
  git(home, 'push', '-q', '-u', 'origin', 'main');
  return { root, origin, home, t: { name: 'w', home } };
}

const tool = (n) => [...gitctlTools, ...gitTools].find((x) => x.name === n).fn;
const OPEN = () => (process.env.MANJUEL_GIT_REMOTE = '1');
const SHUT = () => delete process.env.MANJUEL_GIT_REMOTE;

test('the six git verbs run here, not in the inner door', () => {
  for (const n of ['git_commit', 'git_push', 'git_pull', 'git_branch', 'git_tag', 'git_pr']) {
    assert.ok(door.PORTED.includes(n) && !door.REMAINING.includes(n), n);
  }
  const reg = door.build(door.worldsFor(fs.mkdtempSync(path.join(os.tmpdir(), 'gitctl-g-'))));
  assert.deepEqual(reg.tenants.names(), ['atlas', 'research', 'secondbrain', 'steward'], 'SecondBrain is the third world, Steward the fourth');
});

test('a save: a message or nothing; everything, or only what is named, never outside the world', async () => {
  const { home, t } = world();
  const commit = tool('git_commit');
  assert.match(await commit(t, { message: '  ' }), /^Refused: a save needs a message/);
  assert.match(await commit(t, { message: 'x', files: '../escape.txt' }), /^Refused: that path resolves outside this world/);
  assert.match(await commit(t, { message: 'x' }), /^Nothing to save/);
  fs.writeFileSync(path.join(home, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(home, 'b.txt'), 'b\n');
  assert.match(await commit(t, { message: 'only a', files: 'a.txt' }), /^Saved 1 file as [0-9a-f]+: "only a"/);
  assert.match(await commit(t, { message: 'the rest' }), /^Saved 1 file as/);
  assert.equal(git(home, 'log', '-1', '--format=%s'), 'the rest');
});

test('sending: walled when the dial is shut; a main GitHub has goes by pull request; a new line is sent and linked once', async () => {
  const { home, t } = world();
  const push = tool('git_push');
  SHUT();
  assert.match(await push(t, {}), /^Refused: Sending is OFF/);
  OPEN();
  try {
    assert.match(await push(t, {}), /^Refused: main is on GitHub, and GitHub takes a change to it only through a pull request/);
    git(home, 'switch', '-q', '-c', 'work');
    fs.writeFileSync(path.join(home, 'c.txt'), 'c\n');
    git(home, 'add', '-A');
    git(home, 'commit', '-q', '-m', 'on a line');
    const sent = await push(t, {});
    assert.match(sent, /^Sent work to origin\./);
    assert.match(sent, /it now follows origin\/work\.$/);
    assert.equal(git(home, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/work');
  } finally {
    SHUT();
  }
});

test('taking from GitHub: fast-forward only, never over unsaved work, a fork refused; `git` with fetch counts what GitHub has', async () => {
  const { root, origin, home, t } = world();
  const other = path.join(root, 'other');
  git(root, 'clone', '-q', origin, other);
  fs.writeFileSync(path.join(other, 'a.txt'), 'theirs\n');
  git(other, 'commit', '-q', '-am', 'from elsewhere');
  git(other, 'push', '-q', 'origin', 'main');
  OPEN();
  try {
    assert.equal(JSON.parse(await tool('git')(t, {})).behind, 0, 'not fetched: GitHub not asked');
    const fetched = JSON.parse(await tool('git')(t, { fetch: 'yes' }));
    assert.equal(fetched.fetched, true);
    assert.equal(fetched.behind, 1, 'fetched: the save GitHub has is counted');
    fs.writeFileSync(path.join(home, 'b.txt'), 'unsaved\n');
    assert.match(await tool('git_pull')(t, {}), /^Refused: there is unsaved work here/);
    fs.rmSync(path.join(home, 'b.txt'));
    assert.match(await tool('git_pull')(t, {}), /^Fetched and caught up\./);
    assert.match(await tool('git_pull')(t, {}), /^Already in step/);
    fs.writeFileSync(path.join(other, 'a.txt'), 'theirs again\n');
    git(other, 'commit', '-q', '-am', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(home, 'a.txt'), 'mine\n');
    git(home, 'commit', '-q', '-am', 'mine');
    assert.match(await tool('git_pull')(t, {}), /^Fetching refused -- [\s\S]*joining them is your call, not the door's/);
  } finally {
    SHUT();
  }
});

test('lines of work: listed, opened, not left over unsaved work, closed only when their work is elsewhere; main lands by pull request', async () => {
  const { home, t } = world();
  const branch = tool('git_branch');
  const listed = JSON.parse(await branch(t, {}));
  assert.equal(listed.on, 'main');
  assert.deepEqual(listed.branches.map((b) => [b.name, b.current, b.main, b.sent]), [['main', true, true, true]]);
  assert.match(listed.why_not_land, /^Refused: main is on GitHub/);
  assert.match(await branch(t, { action: 'new', name: '-x' }), /may not begin with '-'/);
  assert.match(await branch(t, { action: 'new', name: 'a..b' }), /not a lawful branch name/);
  assert.match(await branch(t, { action: 'new', name: 'piece' }), /^Opened "piece" and moved you onto it/);
  fs.writeFileSync(path.join(home, 'n.txt'), 'n\n');
  assert.match(await branch(t, { action: 'switch', name: 'main' }), /^Refused: there is unsaved work here/);
  git(home, 'add', '-A');
  git(home, 'commit', '-q', '-m', 'piece work');
  assert.match(await branch(t, { action: 'switch', name: 'main' }), /^You are now on "main"/);
  assert.match(await branch(t, { action: 'land', name: 'piece' }), /^Refused: main is on GitHub/);
  assert.match(await branch(t, { action: 'close', name: 'piece' }), /holds work that is not on any other line/);
  assert.match(await branch(t, { action: 'close', name: 'main' }), /^Refused: you are standing on that line/);
});

test('version marks: the name equals the declared version, on the main line, never moved; sent only after its history; removed only if never sent', async () => {
  const { home, t } = world({ version: '0.1.0' });
  const tag = tool('git_tag');
  assert.match(badTagName('v0.1.0+f1'), /which is not a number/);
  assert.match(await tag(t, { action: 'cut', name: 'v0.2.0', message: 'm' }), /^Refused: the mark and the ground disagree.*VERSION at that commit says 0\.1\.0/);
  assert.match(await tag(t, { action: 'cut', name: 'v0.1.0' }), /needs a message/);
  assert.match(await tag(t, { action: 'cut', name: 'v0.1.0', message: 'first cut' }), /^Cut v0\.1\.0 at [0-9a-f]+ \("first"\), against VERSION saying 0\.1\.0/);
  assert.match(await tag(t, { action: 'cut', name: 'v0.1.0', message: 'again' }), /already exists here.*never moved/);
  fs.writeFileSync(path.join(home, 'VERSION'), '0.1.1\n');
  git(home, 'commit', '-q', '-am', 'bump');
  assert.match(await tag(t, { action: 'cut', name: 'v0.1.1', message: 'm' }), /^Cut v0\.1\.1/);
  OPEN();
  try {
    assert.match(await tag(t, { action: 'send', name: 'v0.1.1' }), /origin's main line does not carry that commit/);
    const list = JSON.parse(await tag(t, {}));
    assert.equal(list.next, 'v0.1.1');
    assert.equal(list.sent_known, true);
    const v010 = list.tags.find((x) => x.name === 'v0.1.0');
    assert.equal(v010.sendable, true);
    assert.match(await tag(t, { action: 'send', name: 'v0.1.0' }), /^Sent v0\.1\.0 to origin\./);
    assert.match(await tag(t, { action: 'remove', name: 'v0.1.0' }), /^Refused: GitHub has v0\.1\.0/);
    assert.match(await tag(t, { action: 'remove', name: 'v0.1.1' }), /^Removed v0\.1\.1/);
  } finally {
    SHUT();
  }
  assert.match(await tag(t, { action: 'remove', name: 'v0.1.0' }), /cannot tell whether GitHub already has v0\.1\.0/, 'a shut wall fails shut');
  assert.equal(cargoVersion('[package]\nname = "x"\nversion = "1.2.3"\n[dependencies]\nversion = "9"\n'), '1.2.3');
});

test('pull requests: a client\'s open or merge waits for the operator; listed with their checks as one word; merged only when green, at the head that was read, and main comes down', async () => {
  const { root, origin, home, t } = world();
  const reg = door.build([['w', home]], { defaultProject: 'w' });
  const CLIENT = { name: 'client', service: false };
  // since 2026-10-31 git_pr is no longer the glass's alone: a client's writes park like every other
  assert.match(await reg.call('git_pr', { action: 'open' }, CLIENT), /^HELD: "git_pr" writes/);
  assert.match(await reg.call('git_pr', { action: 'merge', number: 7 }, CLIENT), /^HELD: "git_pr" writes/);
  assert.equal(prChecks([]), 'none');
  assert.equal(prChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'passed');
  assert.equal(prChecks([{ status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(prChecks([{ status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failed');
  assert.deepEqual(prWaitOf({ wait: '31' })[0], 0);
  assert.match(prWaitOf({ wait: '31' })[1], /from 0 to 30 whole minutes/);
  // the merge GitHub makes, played by the bare origin: a save on main
  const other = path.join(root, 'other');
  git(root, 'clone', '-q', origin, other);
  fs.writeFileSync(path.join(other, 'a.txt'), 'merged\n');
  git(other, 'commit', '-q', '-am', 'Merge pull request #7');
  const calls = [];
  let checks = [{ status: 'IN_PROGRESS' }];
  const real = gh.run;
  gh.run = async (tt, timeout, ...args) => {
    calls.push(args.join(' '));
    if (args[1] === 'list') return { out: JSON.stringify([{ number: 7, title: 'T', headRefName: 'work', baseRefName: 'main', url: 'u', statusCheckRollup: checks }]), err: null };
    if (args[1] === 'view') return { out: JSON.stringify({ number: 7, title: 'T', state: 'OPEN', baseRefName: 'main', headRefName: 'work', headRefOid: 'abc123', mergeable: 'MERGEABLE', statusCheckRollup: checks }), err: null };
    if (args[1] === 'merge') {
      git(other, 'push', '-q', 'origin', 'main');
      return { out: '', err: null };
    }
    return { out: 'unexpected', err: new Error('exit status 1') };
  };
  OPEN();
  try {
    const OP = { name: '', service: true };
    assert.deepEqual(JSON.parse(await reg.call('git_pr', { action: 'list' }, OP)).pull_requests[0], { number: 7, title: 'T', line: 'work', into: 'main', url: 'u', checks: 'pending' });
    assert.equal(JSON.parse(await reg.call('git_pr', { action: 'list' }, CLIENT)).pull_requests[0].number, 7, "a client's list reads at once");
    assert.ok(!calls.some((c) => c.startsWith('pr create') || c.startsWith('pr merge')), 'nothing a client asked was run before his Approve');
    assert.match(await reg.call('git_pr', { action: 'merge', number: '#7' }, OP), /checks are still running/);
    checks = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
    const merged = await reg.call('git_pr', { action: 'merge', number: 7 }, OP);
    assert.match(merged, /^Merged pull request #7 on GitHub as a merge commit: "T", work into main\.\n\nThe new main is down on this machine: [0-9a-f]+ "Merge pull request #7"/);
    assert.ok(calls.includes('pr merge 7 --merge --match-head-commit abc123'), 'merged at exactly the head that was read');
    assert.equal(git(home, 'log', '-1', '--format=%s'), 'Merge pull request #7');
  } finally {
    gh.run = real;
    SHUT();
  }
});

test('a client\'s git write parks for the operator; nothing is staged', async () => {
  const { home } = world();
  const reg = door.build([['w', home]], { defaultProject: 'w' });
  fs.writeFileSync(path.join(home, 'a.txt'), 'changed\n');
  assert.match(await reg.call('git_commit', { message: 'from a flow' }, { name: 'a flow', service: false }), /^HELD: "git_commit" writes/);
  assert.equal(git(home, 'diff', '--cached', '--name-only'), '');
  assert.match(await reg.call('git_branch', { action: 'list' }, { name: 'a flow', service: false }), /"on": "main"/, 'a reading action runs');
});
