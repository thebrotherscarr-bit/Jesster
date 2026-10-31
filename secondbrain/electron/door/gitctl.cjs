/**
 * The door's git verbs that CHANGE a repository, ported from atlas/line's gitctl.go
 * (git_commit, git_push, git_pull, git_tag, git_branch) and gitpr.go (git_pr): the
 * engine of SecondBrain's GitHub shelf (the note plan-github-shelf, G1; Kyle's word,
 * 2026-10-23: "github flows goes into a shelf in secondbrain, where i can handle all
 * the repos").
 *
 * The same refusals, word for word, as the Go door: a save needs a message; sending
 * and fetching are walled by the estate's dial (MANJUEL_GIT_REMOTE); a main GitHub has
 * takes a change only through a pull request; a fetch is fast-forward only and never
 * over unsaved work; a version mark equals the version the ground declares, stands on
 * the main line, is never moved and leaves only after its history; a line holding work
 * found nowhere else is not closed; a pull request merges on GitHub only when every
 * check has passed, as a merge commit, at exactly the head that was read. Never
 * `--all`, `--mirror` or `--tags`.
 *
 * Every verb here writes, so SecondBrain's gate (registry.cjs) parks a client's call
 * for the operator's Approve before anything runs. git_pr was his hand alone; since
 * 2026-10-31 (his word, for Steward: "Yes, give it to him") a client's open or merge
 * parks the same way, and its list reads.
 */
const path = require('path');
const { struct, marshal, spawn, dial, str } = require('./util.cjs');
const { gitRun, isRepo, mainLine, mainByPullRequest, NOT_A_REPO } = require('./git.cjs');
const TABLE = require('./tools.json');

// ---- shared -----------------------------------------------------------------------

function firstLine(s) {
  s = String(s || '').trim();
  if (!s) return 'git said nothing';
  const i = s.search(/[\r\n]/);
  return i >= 0 ? s.slice(0, i) : s;
}

const plural = (n) => (n === 1 ? '' : 's');
const q = (s) => JSON.stringify(String(s));

function walled(what) {
  return (
    'Refused: ' + what + ' is OFF. The estate\'s wall (MANJUEL_GIT_REMOTE) ' +
    'is shut, so nothing here reaches the remote. That dial is the ' +
    "operator's alone -- this door reads it and never opens it."
  );
}

const actionOf = (args) => String(typeof args.action === 'string' ? args.action : '').trim().toLowerCase();

async function currentBranch(t) {
  const r = await gitRun(t, 10000, 'rev-parse', '--abbrev-ref', 'HEAD');
  return r.err ? '' : r.out.trim();
}

async function dirty(t) {
  const r = await gitRun(t, 15000, 'status', '--porcelain');
  return !r.err && r.out.trim() !== '';
}

/** Whether ref's history holds commit; any doubt is "no". */
async function carries(t, ref, commit) {
  return !(await gitRun(t, 15000, 'merge-base', '--is-ancestor', commit, ref)).err;
}

/** Resolve first, refuse what escapes, never judge the stated form; '' when lawful. */
function jailed(t, rel) {
  if (rel.startsWith('/') || rel.startsWith('\\') || rel.includes(':')) return 'Refused: an absolute path is outside this world (' + rel + ').';
  const home = path.resolve(t.home);
  const full = path.resolve(home, rel);
  if (full !== home && !full.startsWith(home + path.sep)) return 'Refused: that path resolves outside this world (' + rel + ').';
  return '';
}

const BAD_REF = [' ', '..', '~', '^', ':', '?', '*', '[', '\\', '@{'];

function badBranchName(b) {
  if (!b) return 'Refused: name the branch.';
  if (b.startsWith('-')) return "Refused: a branch name may not begin with '-' -- git would read it as a flag.";
  for (const bad of BAD_REF) if (b.includes(bad)) return `Refused: ${q(b)} is not a lawful branch name (${q(bad)} is not allowed).`;
  if (b.endsWith('/') || b.endsWith('.lock')) return `Refused: ${q(b)} is not a lawful branch name.`;
  return '';
}

// ---- saving -----------------------------------------------------------------------

async function toolGitCommit(t, args) {
  if (!(await isRepo(t))) return NOT_A_REPO;
  const msg = str(args, 'message').trim();
  if (!msg) return 'Refused: a save needs a message saying what it is. Nothing was staged.';
  const paths = [];
  const raw = str(args, 'files').trim();
  if (raw) {
    for (let p of raw.split('\n')) {
      p = p.trim();
      if (!p) continue;
      const refusal = jailed(t, p);
      if (refusal) return refusal;
      paths.push(p);
    }
  }
  const add = paths.length ? ['add', '--', ...paths] : ['add', '-A'];
  const added = await gitRun(t, 60000, ...add);
  if (added.err) return 'Refused: nothing was staged -- ' + firstLine(added.out);
  const staged = (await gitRun(t, 30000, 'diff', '--cached', '--name-only')).out.trim();
  if (!staged) return 'Nothing to save: the tree already matches the last save.';
  const n = staged.split('\n').length;
  const done = await gitRun(t, 120000, 'commit', '-m', msg);
  if (done.err) return 'Refused: the save did not land -- ' + firstLine(done.out);
  const head = (await gitRun(t, 10000, 'rev-parse', '--short', 'HEAD')).out;
  return `Saved ${n} file${plural(n)} as ${head}: ${q(msg)}\n\n${done.out}`;
}

// ---- sending ----------------------------------------------------------------------

async function toolGitPush(t) {
  if (!(await isRepo(t))) return NOT_A_REPO;
  if (!dial(t.home, 'GIT_REMOTE')) return walled('Sending');
  const branch = await currentBranch(t);
  if (!branch) return 'Refused: this world has no branch to send (no commits yet).';
  if (branch === (await mainLine(t))) {
    const refusal = await mainByPullRequest(t);
    if (refusal) return refusal;
  }
  const first = Boolean((await gitRun(t, 10000, 'rev-parse', '--abbrev-ref', '@{upstream}')).err);
  const cmd = first ? ['push', '--set-upstream', 'origin', branch] : ['push'];
  const r = await gitRun(t, 300000, ...cmd);
  if (r.err) return 'Sending refused by the remote -- ' + firstLine(r.out) + '\n\n' + r.out;
  const note = first ? `\n\nThis branch had never been sent before; it now follows origin/${branch}.` : '';
  const out = r.out.trim() ? r.out : 'Nothing to send: the remote already has everything here.';
  return `Sent ${branch} to origin.\n\n${out}${note}`;
}

async function toolGitPull(t) {
  if (!(await isRepo(t))) return NOT_A_REPO;
  if (!dial(t.home, 'GIT_REMOTE')) return walled('Fetching');
  if (await dirty(t)) return 'Refused: there is unsaved work here. Save it first -- a fetch over a dirty tree is how work goes missing.';
  const r = await gitRun(t, 300000, 'pull', '--ff-only');
  if (r.err) {
    return (
      'Fetching refused -- ' + firstLine(r.out) +
      "\n\nThis pulls fast-forward only: if this world and the remote have both moved, joining them is your call, not the door's.\n\n" + r.out
    );
  }
  if (r.out.includes('Already up to date')) return 'Already in step: the remote has nothing this world does not.';
  return 'Fetched and caught up.\n\n' + r.out;
}

// ---- version marks ----------------------------------------------------------------

function badTagName(v) {
  if (!v) return 'Refused: name the mark, e.g. v0.1.5.';
  if (!v.startsWith('v')) return `Refused: ${q(v)} does not begin with 'v'. A version mark here is vMAJOR.MINOR.PATCH, e.g. v0.1.5.`;
  const parts = v.slice(1).split('.');
  if (parts.length !== 3 || parts.some((p) => p === '')) return `Refused: ${q(v)} is not vMAJOR.MINOR.PATCH -- three numbers and two dots, e.g. v0.1.5.`;
  for (const p of parts) {
    for (const c of p) {
      if (c < '0' || c > '9') {
        return (
          `Refused: ${q(v)} carries ${q(c)}, which is not a number. A version mark is vMAJOR.MINOR.PATCH and nothing else -- no ` +
          'build moniker, no suffix, no trailing word. A mark that does not equal what the version file says is a lie to whoever fetches it.'
        );
      }
    }
  }
  return '';
}

function badMarkName(v) {
  if (!v) return 'Refused: name the mark.';
  if (v.startsWith('-')) return "Refused: a mark name may not begin with '-' -- git would read it as a flag.";
  for (const bad of BAD_REF) if (v.includes(bad)) return `Refused: ${q(v)} is not a lawful mark name (${q(bad)} is not allowed).`;
  return '';
}

/** The version the ground declared AT that commit: VERSION, else pyproject.toml; [version, source]. */
async function declaredVersionAt(t, rev) {
  const v = await gitRun(t, 15000, 'show', rev + ':VERSION');
  if (!v.err && v.out.trim()) return [v.out.trim(), 'VERSION'];
  const py = await gitRun(t, 15000, 'show', rev + ':pyproject.toml');
  if (!py.err) {
    for (let ln of py.out.split('\n')) {
      ln = ln.trim();
      if (!ln.startsWith('version')) continue;
      const rest = ln.slice('version'.length).trim();
      if (!rest.startsWith('=')) continue;
      const val = rest.slice(1).trim().replace(/^["']+|["']+$/g, '');
      if (val) return [val, 'pyproject.toml'];
    }
  }
  return ['', ''];
}

function cargoVersion(manifest) {
  let section = '';
  for (let ln of manifest.split('\n')) {
    ln = ln.trim();
    if (ln.startsWith('[')) {
      const i = ln.indexOf(']');
      if (i > 0) section = ln.slice(0, i + 1);
      continue;
    }
    if (section !== '[package]' && section !== '[workspace.package]') continue;
    const rest = ln.startsWith('version') ? ln.slice('version'.length).trim() : null;
    if (rest === null || !rest.startsWith('=')) continue;
    const val = rest.slice(1).trim();
    if (val && (val[0] === '"' || val[0] === "'")) {
      const end = val.slice(1).indexOf(val[0]);
      if (end >= 0) return val.slice(1, end + 1);
    }
    return val.replace(/^["']+|["']+$/g, '');
  }
  return '';
}

/** Every version stamp at rev that does not say want; a guard that cannot check fails shut. */
async function staleStamps(t, rev, want) {
  const listed = await gitRun(t, 15000, 'ls-tree', '-r', '-z', '--name-only', rev);
  if (listed.err) return ['the tree at that commit could not be listed (' + firstLine(listed.out) + ')'];
  const stale = [];
  let cargo = false;
  for (const p of listed.out.split('\0')) {
    if (p === 'Cargo.toml') cargo = true;
    if (p !== 'VERSION' && !p.endsWith('/VERSION')) continue;
    const got = await gitRun(t, 15000, 'show', rev + ':' + p);
    if (got.err) stale.push(p + ' could not be read');
    else if (got.out.trim() !== want) stale.push(`${p} says ${got.out.trim()}`);
  }
  if (cargo) {
    const m = await gitRun(t, 15000, 'show', rev + ':Cargo.toml');
    if (m.err) stale.push('Cargo.toml could not be read');
    else {
      const got = cargoVersion(m.out);
      if (got && got !== want) stale.push('Cargo.toml says ' + got);
    }
  }
  return stale;
}

async function tagCut(t, name, message, at) {
  const bad = badTagName(name);
  if (bad) return bad;
  if (!message) {
    return 'Refused: a mark needs a message saying what this version is. Nothing was cut -- the name carries the number and the message carries what it was for.';
  }
  at = at || 'HEAD';
  const shaR = await gitRun(t, 10000, 'rev-parse', '--verify', at + '^{commit}');
  if (shaR.err) return `Refused: ${q(at)} is not a commit in this world.`;
  const sha = shaR.out.trim();
  if (!(await gitRun(t, 10000, 'rev-parse', '--verify', 'refs/tags/' + name)).err) {
    const short = (await gitRun(t, 10000, 'rev-parse', '--short', 'refs/tags/' + name + '^{commit}')).out.trim();
    return (
      `Refused: ${name} already exists here, on ${short}. A mark is never moved -- anyone who already fetched it would keep the old one ` +
      'and never learn it changed. Cut the next number instead.'
    );
  }
  const mainName = await mainLine(t);
  if (!mainName) return 'Refused: this world has no main line -- no `main` or `master` branch -- so there is nowhere lawful for a mark to stand.';
  if (!(await carries(t, 'refs/heads/' + mainName, sha))) {
    const short = (await gitRun(t, 10000, 'rev-parse', '--short', sha)).out.trim();
    return (
      `Refused: ${short} is not on the main line (${mainName}). A version mark is cut only on a commit ${mainName} carries; a mark anywhere else ` +
      `takes that other history with it when it is sent. Bring the work onto ${mainName} first.`
    );
  }
  const headSha = (await gitRun(t, 10000, 'rev-parse', '--verify', 'HEAD^{commit}')).out.trim();
  if (headSha === sha && (await dirty(t))) {
    return (
      'Refused: there is unsaved work here. Save it first -- a mark cut now would point at a commit that is not what is on your disk, and ' +
      'nothing built from it would be what you tested. If you have just bumped the version file, that bump is part of what needs saving.'
    );
  }
  const [declared, source] = await declaredVersionAt(t, sha);
  if (!declared) {
    return (
      'Refused: this world declares no version at that commit -- no VERSION file, and no version in pyproject.toml. There is nothing ' +
      'for the mark to agree with, so the mark would mean nothing.'
    );
  }
  if ('v' + declared !== name) {
    return (
      `Refused: the mark and the ground disagree. You asked for ${name}; ${source} at that commit says ${declared}, so the mark to cut there is v${declared}. ` +
      `Bump the file or change the name -- but a stranger fetches ${name} and believes it is ${name.slice(1)} because the name says so, and this refusal is ` +
      'what keeps that true.'
    );
  }
  const stale = await staleStamps(t, sha, declared);
  if (stale.length) {
    return (
      `Refused: ${source} says ${declared}, but not every version stamp at that commit agrees -- ${stale.join('; ')}. A mark here would ship files that answer ` +
      `another number, and the release refuses it on arrival. Move every stamp to ${declared} together, save that, and cut again.`
    );
  }
  const cut = await gitRun(t, 30000, 'tag', '-a', name, '-m', message, sha);
  if (cut.err) return 'Refused: the mark did not land -- ' + firstLine(cut.out);
  const short = (await gitRun(t, 10000, 'rev-parse', '--short', sha)).out.trim();
  const subject = (await gitRun(t, 10000, 'log', '-1', '--format=%s', sha)).out.trim();
  return `Cut ${name} at ${short} (${q(subject)}), against ${source} saying ${declared}.\n\nIt is on this machine only -- sending it is a separate button.`;
}

/** WOULD this door send this mark? '' when it would. */
async function sendRefusal(t, name) {
  const bad = badTagName(name);
  if (bad) return bad;
  if ((await gitRun(t, 10000, 'rev-parse', '--verify', 'refs/tags/' + name)).err) return `Refused: there is no mark called ${name} here to send. Cut it first.`;
  const c = await gitRun(t, 10000, 'rev-parse', '--verify', 'refs/tags/' + name + '^{commit}');
  if (c.err) return `Refused: ${name} does not name a commit this door can judge, so it is not sent.`;
  const commit = c.out.trim();
  const mainName = await mainLine(t);
  if (!mainName || !(await carries(t, 'refs/remotes/origin/' + mainName, commit))) {
    const short = (await gitRun(t, 10000, 'rev-parse', '--short', commit)).out.trim();
    return (
      `Refused: ${name} is on ${short}, and origin's main line does not carry that commit -- not as this machine last saw it. Sending the ` +
      "mark would send that history with it. Bring the commit onto origin's main line first (a main origin has takes it only through a pull request), then the mark."
    );
  }
  return '';
}

async function tagSend(t, name) {
  const bad = badTagName(name);
  if (bad) return bad;
  if (!dial(t.home, 'GIT_REMOTE')) return walled('Sending');
  const refusal = await sendRefusal(t, name);
  if (refusal) return refusal;
  const r = await gitRun(t, 300000, 'push', 'origin', 'refs/tags/' + name);
  if (r.err) return `Sending refused by the remote -- ${firstLine(r.out)}\n\n${r.out}`;
  return `Sent ${name} to origin.\n\n${r.out.trim() ? r.out : 'GitHub already had it.'}`;
}

/** Which marks GitHub holds, asked once, and whether the question could be asked at all. */
async function remoteTags(t) {
  const sent = new Set();
  if (!dial(t.home, 'GIT_REMOTE')) return [sent, false];
  const ls = await gitRun(t, 30000, 'ls-remote', '--tags', 'origin');
  if (ls.err) return [sent, false];
  for (const ln of ls.out.split('\n')) {
    const f = ln.trim().split(/\s+/);
    if (f.length < 2) continue;
    sent.add(f[1].replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''));
  }
  return [sent, true];
}

/** WOULD this door take this mark back? '' when it would. */
async function removeRefusal(t, name, known, sent) {
  const bad = badMarkName(name);
  if (bad) return bad;
  if ((await gitRun(t, 10000, 'rev-parse', '--verify', 'refs/tags/' + name)).err) return `Refused: there is no mark called ${name} here to remove.`;
  if (!known) {
    return (
      `Refused: this door cannot tell whether GitHub already has ${name}. The wall (MANJUEL_GIT_REMOTE) is shut or the remote could not ` +
      'be reached, and a mark GitHub holds is never withdrawn -- somebody may already have fetched it. Open the wall and ask again.'
    );
  }
  if (sent) {
    return (
      `Refused: GitHub has ${name}. A mark that has been sent may already have been fetched, and taking the name back leaves whoever has ` +
      'it holding a version this ground no longer knows -- the same harm as moving one. Cut the next number instead.'
    );
  }
  return '';
}

async function tagRemove(t, name) {
  const [sent, known] = await remoteTags(t);
  const refusal = await removeRefusal(t, name, known, sent.has(name));
  if (refusal) return refusal;
  const short = (await gitRun(t, 10000, 'rev-parse', '--short', 'refs/tags/' + name + '^{commit}')).out.trim();
  const subject = (await gitRun(t, 10000, 'log', '-1', '--format=%s', 'refs/tags/' + name + '^{commit}')).out.trim();
  const d = await gitRun(t, 30000, 'tag', '-d', name);
  if (d.err) return 'Refused: the mark was not removed -- ' + firstLine(d.out);
  return (
    `Removed ${name}. It stood on ${short} (${q(subject)}), and that commit is untouched -- only the name is gone. GitHub never had it, so nothing ` +
    `there changed. Cutting ${name} again is a fresh mark, at whatever commit the ground declares it at.`
  );
}

async function tagList(t) {
  const raw = (
    await gitRun(t, 15000, 'for-each-ref', '--sort=-creatordate',
      '--format=%(refname:short)\t%(objectname:short)\t%(*objectname:short)\t%(creatordate:relative)\t%(contents:subject)', 'refs/tags')
  ).out;
  const wall = dial(t.home, 'GIT_REMOTE');
  const [sent, known] = await remoteTags(t);
  const marks = [];
  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    const f = ln.split('\t');
    while (f.length < 5) f.push('');
    const rest = f.slice(4).join('\t');
    marks.push({ name: f[0], at: f[2] || f[1], when: f[3], subject: rest, sent: sent.has(f[0]) });
  }
  const rows = [];
  for (const m of marks) {
    const whyNotRemove = await removeRefusal(t, m.name, known, m.sent);
    let whyNot = '';
    let sendable = false;
    if (!m.sent) {
      if (!wall) whyNot = walled('Sending');
      else {
        whyNot = await sendRefusal(t, m.name);
        sendable = whyNot === '';
      }
    }
    const row = { name: m.name, at: m.at, when: m.when, subject: m.subject, sent: m.sent, sendable };
    if (whyNot) row.why_not = whyNot;
    row.removable = whyNotRemove === '';
    if (whyNotRemove) row.why_not_remove = whyNotRemove;
    rows.push(struct(row));
  }
  const [declared, source] = await declaredVersionAt(t, 'HEAD');
  return marshal({ world: t.name, tags: rows, declared, declared_by: source, next: declared ? 'v' + declared : '', sent_known: known });
}

async function toolGitTag(t, args) {
  if (!(await isRepo(t))) return NOT_A_REPO;
  const action = actionOf(args) || 'list';
  const name = str(args, 'name').trim();
  switch (action) {
    case 'list':
      return tagList(t);
    case 'cut':
    case 'new':
      return tagCut(t, name, str(args, 'message').trim(), str(args, 'at').trim());
    case 'send':
    case 'push':
      return tagSend(t, name);
    case 'remove':
    case 'delete':
      return tagRemove(t, name);
  }
  return (
    `Refused: ${q(action)} is not something this does. It lists the marks (list), cuts one (cut), sends one to GitHub (send), ` +
    'or removes one that never left this machine (remove).'
  );
}

// ---- lines of work ----------------------------------------------------------------

async function branchList(t) {
  const cur = await currentBranch(t);
  const raw = (
    await gitRun(t, 15000, 'for-each-ref', '--sort=-committerdate',
      '--format=%(refname:short)\t%(upstream:short)\t%(committerdate:relative)\t%(contents:subject)', 'refs/heads')
  ).out;
  let lines = null;
  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    const f = ln.split('\t');
    while (f.length < 4) f.push('');
    (lines ||= []).push(
      struct({ name: f[0], current: f[0] === cur, main: f[0] === 'main' || f[0] === 'master', upstream: f[1], sent: f[1] !== '', when: f[2], subject: f.slice(3).join('\t') }),
    );
  }
  const out = { world: t.name, on: cur, branches: lines };
  const why = await mainByPullRequest(t);
  if (why) out.why_not_land = why;
  return marshal(out);
}

async function toolGitBranch(t, args) {
  if (!(await isRepo(t))) return NOT_A_REPO;
  const action = actionOf(args) || 'list';
  const name = str(args, 'name').trim();
  switch (action) {
    case 'list':
      return branchList(t);
    case 'new':
    case 'open': {
      const bad = badBranchName(name);
      if (bad) return bad;
      const r = await gitRun(t, 30000, 'switch', '-c', name);
      if (r.err) return 'Refused: that line could not be opened -- ' + firstLine(r.out);
      return `Opened ${q(name)} and moved you onto it. It exists only here until you send it.`;
    }
    case 'switch':
    case 'use': {
      const bad = badBranchName(name);
      if (bad) return bad;
      if (await dirty(t)) return 'Refused: there is unsaved work here. Save it first, or it follows you onto the other line and confuses both.';
      const r = await gitRun(t, 30000, 'switch', name);
      if (r.err) return 'Refused: could not move to that line -- ' + firstLine(r.out);
      return `You are now on ${q(name)}.`;
    }
    case 'land': {
      const bad = badBranchName(name);
      if (bad) return bad;
      const mainName = await mainLine(t);
      const cur = await currentBranch(t);
      if (name === mainName) return 'Refused: the main line is not landed onto itself.';
      const byPr = await mainByPullRequest(t);
      if (byPr) return byPr;
      if (cur !== mainName) return `Refused: you are standing on ${q(cur)}. Move to ${q(mainName)} first (switch), then land ${q(name)} onto it.`;
      if (await dirty(t)) return 'Refused: there is unsaved work here. Save it first; a landing over unsaved work confuses both lines.';
      if ((await gitRun(t, 30000, 'rev-parse', '--verify', name)).err) return `Refused: there is no line named ${q(name)} here.`;
      const r = await gitRun(t, 60000, 'merge', '--ff-only', name);
      if (r.err) {
        if (r.out.toLowerCase().includes('not possible to fast-forward')) {
          return (
            `Refused: ${q(name)} cannot land as a fast-forward -- ${q(mainName)} has moved past where that line began. A join with two parents is your ` +
            "terminal's, not this button's."
          );
        }
        return 'Refused: that line could not be landed -- ' + firstLine(r.out);
      }
      return `Landed ${q(name)} onto ${q(mainName)}, fast-forward. The line still exists: close it when you are done with it, and send ${q(mainName)} to publish the landing.`;
    }
    case 'close':
    case 'delete': {
      const bad = badBranchName(name);
      if (bad) return bad;
      if (name === (await currentBranch(t))) return 'Refused: you are standing on that line. Move to another one first.';
      const r = await gitRun(t, 30000, 'branch', '-d', name);
      if (r.err) {
        if (r.out.includes('not fully merged')) {
          return (
            `Refused: ${q(name)} holds work that is not on any other line. Closing it would lose that work. Merge it first, or ` +
            `close it yourself with \`git branch -D ${name}\` if you mean to discard it.`
          );
        }
        return 'Refused: could not close that line -- ' + firstLine(r.out);
      }
      return `Closed ${q(name)}. Its work is already on another line.`;
    }
  }
  return `Refused: ${q(action)} is not something this does. It lists, opens (new), moves to (switch), lands (land), or closes (close) a line of work.`;
}

// ---- pull requests, through gh ------------------------------------------------------

/** gh in a world's ground; replaced in the tests, so no test reaches GitHub. */
const gh = {
  run: async (t, timeout, ...args) => {
    const res = await spawn('gh', args, { dir: t.home, timeout, env: ['GH_PROMPT_DISABLED=1', 'GH_PAGER=cat', 'NO_COLOR=1', 'GH_NO_UPDATE_NOTIFIER=1'] });
    return { out: res.combined.replace(/[\r\n]+$/, ''), err: res.err };
  },
  /** how often a waiting merge asks again, and how it waits */
  poll: 30000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const PR_MAX_WAIT = 30;
const PR_VIEW = 'number,title,state,baseRefName,headRefName,headRefOid,mergeable,url,statusCheckRollup';

/** A pull request's checks as one word: none, pending, failed or passed. */
function prChecks(checks) {
  if (!checks || !checks.length) return 'none';
  let pending = false;
  for (const c of checks) {
    if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(String(c.conclusion || '').toUpperCase())) return 'failed';
    const state = String(c.state || '').toUpperCase();
    if (state === 'FAILURE' || state === 'ERROR') return 'failed';
    if (state === 'PENDING' || state === 'EXPECTED') pending = true;
    if (!c.state && String(c.status || '').toUpperCase() !== 'COMPLETED') pending = true;
  }
  return pending ? 'pending' : 'passed';
}

async function prList(t) {
  const r = await gh.run(t, 30000, 'pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,baseRefName,url,statusCheckRollup');
  if (r.err) return 'Refused: gh could not list the pull requests -- ' + firstLine(r.out);
  let raw;
  try {
    raw = JSON.parse(r.out);
  } catch {
    return 'Refused: gh answered in a shape this cannot read -- ' + firstLine(r.out);
  }
  const rows = (raw || []).map((p) =>
    struct({ number: p.number, title: p.title, line: p.headRefName, into: p.baseRefName, url: p.url, checks: prChecks(p.statusCheckRollup) }),
  );
  return marshal({ pull_requests: rows });
}

async function prOpen(t) {
  const line = await currentBranch(t);
  if (!line) return 'Refused: this world stands on no line of work, so there is nothing to ask to land.';
  const mainName = await mainLine(t);
  if (line === mainName) return `Refused: you are standing on ${q(mainName)}, the main line. A pull request takes a line of work into it: move to one first.`;
  if (await dirty(t)) return 'Refused: there is unsaved work here. Save it first; a pull request carries saves, not a tree.';
  const here = (await gitRun(t, 10000, 'rev-parse', 'HEAD')).out.trim();
  const there = await gitRun(t, 10000, 'rev-parse', '@{upstream}');
  if (there.err || here !== there.out.trim()) return `Refused: GitHub does not have ${q(line)} exactly as it stands here. Send it first, then open the pull request.`;
  const title = (await gitRun(t, 10000, 'log', '-1', '--format=%s')).out.trim();
  const saves = (await gitRun(t, 10000, 'log', '--reverse', '--format=- %s', line, '--not', mainName)).out;
  const r = await gh.run(t, 60000, 'pr', 'create', '--base', mainName, '--head', line, '--title', title, '--body', 'The saves on ' + line + ':\n\n' + saves);
  if (r.err) return 'Refused: gh could not open the pull request -- ' + firstLine(r.out);
  const said = r.out.trim().split('\n');
  const url = said[said.length - 1];
  return (
    `Opened a pull request for ${q(line)} into ${q(mainName)}: ${url}. CI runs on it; when every check on it has passed, Merge on GitHub (the GitHub tab, ` +
    `Pull requests) merges it there and brings ${q(mainName)} down here.`
  );
}

function prNumber(args) {
  const v = args.number;
  if (typeof v === 'number' && v >= 1 && Number.isInteger(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim().replace(/^#/, '');
    if (/^\d+$/.test(s) && Number(s) >= 1) return Number(s);
  }
  return 0;
}

/** [minutes, refusal]: a wait from 0 to PR_MAX_WAIT whole minutes. */
function prWaitOf(args) {
  const v = args.wait;
  let n;
  if (v === undefined || v === null) return [0, ''];
  if (typeof v === 'number') n = Number.isInteger(v) ? v : -1;
  else if (typeof v === 'string') {
    if (!v.trim()) return [0, ''];
    n = /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : -1;
  } else n = -1;
  if (n < 0 || n > PR_MAX_WAIT) return [0, `Refused: a merge waits from 0 to ${PR_MAX_WAIT} whole minutes for its checks, not ${v}.`];
  return [n, ''];
}

/** The main line GitHub now holds, brought down as far as it can go without touching unsaved work or joining anything. */
async function mainDown(t, mainName) {
  const cur = await currentBranch(t);
  if (cur === mainName && (await dirty(t))) {
    const r = await gitRun(t, 120000, 'fetch', 'origin', mainName);
    if (r.err) return `\n\nThe new ${mainName} was not fetched -- ${firstLine(r.out)}`;
    return `\n\nThe new ${mainName} is fetched but not taken: there is unsaved work here. Save it, then Take from GitHub.`;
  }
  const r = cur === mainName ? await gitRun(t, 120000, 'pull', '--ff-only', 'origin', mainName) : await gitRun(t, 120000, 'fetch', 'origin', mainName + ':' + mainName);
  if (r.err) return `\n\n${mainName} here did not move -- ${firstLine(r.out)}. It moves fast-forward only; if both have moved, joining them is your terminal's.`;
  const short = (await gitRun(t, 10000, 'rev-parse', '--short', 'refs/heads/' + mainName)).out.trim();
  const subject = (await gitRun(t, 10000, 'log', '-1', '--format=%s', 'refs/heads/' + mainName)).out.trim();
  return `\n\nThe new ${mainName} is down on this machine: ${short} ${q(subject)}.`;
}

async function prMerge(t, args) {
  let n = prNumber(args);
  const line = n === 0 ? str(args, 'line').trim() : '';
  if (n === 0 && !line) return 'Refused: name the pull request to merge, by its number or by its line.';
  const [wait, badWait] = prWaitOf(args);
  if (badWait) return badWait;
  let sel = String(n);
  let what = `pull request #${n}`;
  if (line) {
    const bad = badBranchName(line);
    if (bad) return bad;
    sel = line;
    what = `a pull request from ${q(line)}`;
  }
  // [pr, what gh said, '' | 'gh' when gh failed | 'shape' when its answer could not be read]
  const read = async (s) => {
    const r = await gh.run(t, 30000, 'pr', 'view', s, '--json', PR_VIEW);
    if (r.err) return [null, r.out, 'gh'];
    try {
      const pr = JSON.parse(r.out);
      return pr && pr.state ? [pr, r.out, ''] : [null, r.out, 'shape'];
    } catch {
      return [null, r.out, 'shape'];
    }
  };
  let [pr, said, why] = await read(sel);
  if (why === 'gh') return `Refused: gh could not read ${what} -- ${firstLine(said)}`;
  if (why) return 'Refused: gh answered in a shape this cannot read -- ' + firstLine(said);
  if (line) {
    if (!(pr.number >= 1) || pr.headRefName !== line) return `Refused: gh answered with pull request #${pr.number || 0} from ${q(pr.headRefName || '')}, not from ${q(line)}, so nothing was merged.`;
    n = pr.number;
  }
  const mainName = await mainLine(t);
  const state = String(pr.state).toLowerCase();
  if (state !== 'open') {
    if (line && state === 'merged' && mainName && pr.baseRefName === mainName) {
      return `Pull request #${n} from ${q(line)} is merged on GitHub already: ${q(pr.title)}, into ${mainName}.${await mainDown(t, mainName)}`;
    }
    return `Refused: pull request #${n} is ${state}, not open: there is nothing to merge.`;
  }
  if (!mainName) return 'Refused: this world has no main line -- no `main` or `master` branch -- so there is nowhere here for the merge to come down to.';
  if (pr.baseRefName !== mainName) {
    return `Refused: pull request #${n} goes into ${q(pr.baseRefName)}, not the main line ${q(mainName)}. Merge on GitHub takes a line of work into the main line and nothing else.`;
  }
  for (let i = 0; i < wait * Math.floor(60000 / gh.poll); i++) {
    const c = prChecks(pr.statusCheckRollup);
    if (c === 'passed' || c === 'failed') break;
    await gh.sleep(gh.poll);
    const [again, againSaid, againWhy] = await read(String(n));
    if (againWhy === 'gh') return `Refused: gh could not read pull request #${n} again while it waited -- ${firstLine(againSaid)}`;
    if (againWhy) return 'Refused: gh answered in a shape this cannot read -- ' + firstLine(againSaid);
    pr = again;
  }
  switch (prChecks(pr.statusCheckRollup)) {
    case 'none':
      return `Refused: no checks have run on pull request #${n}, so nothing has proved it. Merge on GitHub waits until its checks have passed.`;
    case 'pending':
      return `Refused: pull request #${n}'s checks are still running. Merge on GitHub waits until every one has passed.`;
    case 'failed':
      return `Refused: pull request #${n}'s checks FAILED. Mend the line, send it again, and merge when they pass.`;
  }
  if (String(pr.mergeable || '').toUpperCase() === 'CONFLICTING') {
    return `Refused: GitHub says pull request #${n} conflicts with ${q(mainName)}, so it cannot merge as it stands. Joining the two is your terminal's; send the line again and merge when its checks pass.`;
  }
  if (!String(pr.headRefOid || '').trim()) {
    return `Refused: gh did not say which save pull request #${n} stands on, so it is not merged: a merge here is of exactly the save that was proved.`;
  }
  const m = await gh.run(t, 120000, 'pr', 'merge', String(n), '--merge', '--match-head-commit', pr.headRefOid);
  if (m.err) return `Refused: GitHub did not merge pull request #${n} -- ${firstLine(m.out)}`;
  return `Merged pull request #${n} on GitHub as a merge commit: ${q(pr.title)}, ${pr.headRefName} into ${mainName}.${await mainDown(t, mainName)}`;
}

async function toolGitPR(t, args) {
  if (!(await isRepo(t))) return NOT_A_REPO;
  if (!dial(t.home, 'GIT_REMOTE')) return walled('Pull requests');
  const action = actionOf(args);
  if (action === '' || action === 'list') return prList(t);
  if (action === 'open') return prOpen(t);
  if (action === 'merge') return prMerge(t, args);
  return (
    `Refused: ${q(action)} is not something this does. It lists the open pull requests (list), opens one from the line you stand on (open), ` +
    'or merges one on GitHub once every check on it has passed (merge, with its number or its line).'
  );
}

// ---- the declarations: the Go door's own, from tools.json --------------------------

const FNS = { git_commit: toolGitCommit, git_push: toolGitPush, git_pull: toolGitPull, git_branch: toolGitBranch, git_tag: toolGitTag, git_pr: toolGitPR };

// SecondBrain's own rulings over the Go door's table, which tools.json keeps as it is. git_pr (2026-10-31, his word
// for Steward: "Yes, give it to him"): no longer the glass's alone; a client's open or merge is a held write like
// every other, so it runs only on his Approve, and list reads.
const OVERRIDES = {
  git_pr: (d) => ({
    writes: true,
    serviceOnly: false,
    description: d.description.replace(/His glass alone may call it$/, "A client's open or merge waits for the operator's Approve, like every other write; list reads"),
  }),
};

const gitctlTools = Object.entries(FNS).map(([name, fn]) => {
  const d = TABLE.find((x) => x.name === name);
  const own = OVERRIDES[name] ? OVERRIDES[name](d) : {};
  return { name, description: d.description, args: d.args, writes: d.writes, reads: d.reads, serviceOnly: d.serviceOnly, secrets: d.secrets, fn, ...own };
});

module.exports = { gitctlTools, gh, prChecks, prNumber, prWaitOf, badBranchName, badTagName, badMarkName, cargoVersion, jailed, walled };
