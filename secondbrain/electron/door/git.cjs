/**
 * The door's repository readers, ported from atlas/line: gitstate.go (git,
 * git_diff), gitctl.go (git_remote and the helpers the verbs share) and
 * projects.go (the maker's projects, each read off its own history). Nothing
 * here writes, stages or reaches a remote: every git verb is a read.
 */
const fs = require('fs');
const path = require('path');
const { struct, marshal, q, spawn, gitEnv, dial, firstLines, str } = require('./util.cjs');
const { WALL_LAW } = require('./records.cjs');

const NOT_A_REPO = 'Refused: this world is not a repository -- there is nothing to save, and nothing to lose.';

/** gitctl.go gitRun: everything git said, trimmed on the right; rejects nothing. */
async function gitRun(t, timeout, ...args) {
  const res = await spawn('git', args, { dir: t.home, timeout, env: gitEnv() });
  return { out: res.combined.replace(/[\r\n]+$/, ''), err: res.err };
}

async function isRepo(t) {
  return !(await gitRun(t, 5000, 'rev-parse', '--is-inside-work-tree')).err;
}

/** This world's main line, `main` or `master`, or ''. */
async function mainLine(t) {
  for (const b of ['main', 'master']) {
    if (!(await gitRun(t, 10000, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + b)).err) return b;
  }
  return '';
}

/** A main origin already has is changed only through a pull request; the door's own sentence, or ''. */
async function mainByPullRequest(t) {
  const mainName = await mainLine(t);
  if (!mainName) return '';
  if ((await gitRun(t, 10000, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + mainName)).err) return '';
  return (
    `Refused: ${mainName} is on GitHub, and GitHub takes a change to it only through a pull request whose checks have passed. ` +
    'Do the work on a line of work, send that line, and open a pull request from it (Pull requests, on the GitHub tab); ' +
    `once its checks pass, Merge on GitHub merges it there and brings the new ${mainName} down here.`
  );
}

// ---- git ------------------------------------------------------------------------------

async function toolGit(t) {
  const out = { world: t.name };
  const run = async (...args) => {
    const res = await spawn('git', args, { dir: t.home, timeout: 5000, env: gitEnv() });
    return res.err ? [null, false] : [res.stdout.trim(), true];
  };
  if (!(await run('rev-parse', '--is-inside-work-tree'))[1]) {
    out.is_repo = false;
    out.note = 'not a repository -- nothing to commit, and nothing to lose';
    return marshal(out);
  }
  out.is_repo = true;
  let [v, ok] = await run('rev-parse', '--abbrev-ref', 'HEAD');
  if (ok) out.branch = v;
  [v, ok] = await run('rev-parse', '--short', 'HEAD');
  if (ok) out.head = v;
  [v, ok] = await run('log', '-1', '--format=%s');
  if (ok) out.subject = v;
  [v, ok] = await run('log', '-1', '--format=%cr');
  if (ok) out.when = v;
  let changed = 0;
  let untracked = 0;
  const files = [];
  [v, ok] = await run('status', '--porcelain');
  if (ok) {
    for (const line of v.split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('??')) untracked++;
      else changed++;
      if (files.length < 40) files.push(line);
    }
  }
  out.changed = changed;
  out.untracked = untracked;
  out.dirty = changed + untracked > 0;
  out.files = files;
  const [up, upOk] = await run('rev-parse', '--abbrev-ref', '@{upstream}');
  if (upOk && up) {
    out.upstream = up;
    [v, ok] = await run('rev-list', '--left-right', '--count', 'HEAD...' + up);
    if (ok) {
      const parts = v.split(/\s+/).filter(Boolean);
      if (parts.length === 2) {
        out.ahead = parseInt(parts[0], 10) || 0;
        out.behind = parseInt(parts[1], 10) || 0;
      }
    }
  }
  [v, ok] = await run('remote');
  if (ok && v) out.remotes = v.split(/\s+/).filter(Boolean);
  if (typeof out.branch === 'string' && out.branch === (await mainLine(t))) {
    const why = await mainByPullRequest(t);
    if (why) out.why_not_send = why;
  }
  const on = dial(t.home, 'GIT_REMOTE');
  out.remote_allowed = on;
  if (!on) out.remote_note = 'remote git operations are OFF (MANJUEL_GIT_REMOTE unset). push and pull refuse by name until the operator opens that wall.';
  return marshal(out);
}

// ---- git_diff -------------------------------------------------------------------------

const DIFF_CAP = 60000;

function clip(s, what) {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= DIFF_CAP) return s;
  return b.subarray(0, DIFF_CAP).toString('utf8') + `\n\n... (${what} is ${b.length} bytes; this is the first ${DIFF_CAP})`;
}

async function toolGitDiff(t, args) {
  const rel = str(args, 'file').trim();
  const run = async (...a) => {
    const res = await spawn('git', a, { dir: t.home, timeout: 10000, env: gitEnv() });
    return res.err ? ['', false] : [res.stdout, true];
  };
  if (!(await run('rev-parse', '--is-inside-work-tree'))[1]) return 'not a repository -- nothing to review';
  if (!rel) {
    const [v] = await run('diff');
    const [staged] = await run('diff', '--cached');
    if (!(v + staged).trim()) return 'Nothing has changed since the last save.';
    return clip(staged + v, 'the whole diff');
  }
  if (rel.startsWith('/') || rel.startsWith('\\') || rel.includes(':')) return 'Refused: an absolute path is outside this world.';
  const home = path.resolve(t.home);
  const full = path.resolve(home, rel);
  if (full !== home && !full.startsWith(home + path.sep)) return 'Refused: that path resolves outside this world.';
  let [v, ok] = await run('diff', '--', rel);
  if (ok && v.trim()) return clip(v, 'the change');
  [v, ok] = await run('diff', '--cached', '--', rel);
  if (ok && v.trim()) return clip(v, 'the staged change');
  const b = path.basename(rel).toLowerCase();
  if (b === '.env' || b.startsWith('.env.')) return 'Refused: that file holds this estate\'s keys, and they are never printed (RULE 7). Nothing was read.';
  if ((await run('check-ignore', '-q', '--', rel))[1]) {
    return (
      `Refused: this world's git ignores ${rel}, so it is not part of what changed -- and what a world keeps out of its history ` +
      '(keys, other worlds, data, logs) is not served here. Nothing was read.'
    );
  }
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (e) {
    return 'That file has no recorded change, and could not be read: ' + e.message;
  }
  return 'This file is new -- git has never seen it, so there is nothing to compare it against. Its contents:\n\n' + clip(text, 'the file');
}

// ---- git_remote ------------------------------------------------------------------------

/** Only the host is ever lifted out of a URL: a URL can carry a token in its userinfo. */
function hostOf(url) {
  let u = url;
  const i = u.indexOf('://');
  if (i >= 0) u = u.slice(i + 3);
  const at = u.lastIndexOf('@');
  if (at >= 0) u = u.slice(at + 1);
  for (const cut of ['/', ':']) {
    const j = u.indexOf(cut);
    if (j >= 0) u = u.slice(0, j);
  }
  return u;
}

async function toolGitRemote(t) {
  if (!(await isRepo(t))) return NOT_A_REPO;
  const { out: raw } = await gitRun(t, 15000, 'remote', '-v');
  const seen = new Map();
  for (const ln of raw.split('\n')) {
    const f = ln.split(/\s+/).filter(Boolean);
    if (f.length < 2) continue;
    seen.set(f[0], f[1]);
  }
  const remotes = seen.size ? [...seen].map(([name, url]) => struct({ name, url, host: hostOf(url) })) : null;
  return marshal({ world: t.name, remotes, remote_allowed: dial(t.home, 'GIT_REMOTE') });
}

// ---- projects.go ----------------------------------------------------------------------

const PROJECTS_DIR = 'projects';
const PROJECT_PAGE = 'index.html';
const PROJECT_PAGE_CAP = 1 << 20;
const PROJECT_GIT_WAIT = 10000;
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROJECT_VERSION_RE = /^Version \d+: /;

/** A real folder, not a link or a junction to somewhere else. */
function plainDir(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function plainFile(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function projectDir(t, name) {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Error(`no project named ${q(name)} -- a project's name is lowercase letters, digits and hyphens, as the list shows it`);
  }
  const root = path.join(t.home, PROJECTS_DIR);
  if (!plainDir(root)) throw new Error(`no project named ${q(name)} -- ${t.name} has no projects/ folder of its own`);
  const dir = path.join(root, name);
  try {
    fs.lstatSync(dir);
  } catch {
    throw new Error(`no project named ${q(name)} in ${t.name}`);
  }
  if (!plainDir(dir)) throw new Error(`REFUSED -- ${q(name)} is a link, not a folder inside projects/. ${WALL_LAW}`);
  if (!plainDir(path.join(dir, '.git'))) throw new Error(`${q(name)} is a folder with no history of its own, so it is not a project`);
  return dir;
}

function projectGit(dir, ...args) {
  return spawn('git', ['--git-dir', path.join(dir, '.git'), '--work-tree', dir, ...args], { dir, timeout: PROJECT_GIT_WAIT, env: gitEnv() });
}

async function projectVersions(dir) {
  const res = await projectGit(dir, 'log', '--reverse', '--format=%h%x09%ct%x09%s');
  if (res.err) {
    if (res.stderr.includes('does not have any commits')) return [];
    throw new Error(`its history could not be read: ${firstLines(res.combined, 2).trim()}`);
  }
  const out = [];
  for (const line of res.stdout.trim().split('\n')) {
    const l = line.replace(/\r+$/, '');
    const i = l.indexOf('\t');
    const j = i >= 0 ? l.indexOf('\t', i + 1) : -1;
    if (i < 0 || j < 0) continue;
    const secs = Number(l.slice(i + 1, j));
    const when = /^\d+$/.test(l.slice(i + 1, j)) ? new Date(secs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
    out.push(struct({ n: out.length + 1, sha: l.slice(0, i), note: l.slice(j + 1).replace(PROJECT_VERSION_RE, ''), when }));
  }
  return out;
}

/** The answer WITHOUT escaping <, > and &: a page is mostly those. */
function projectsJSON(v) {
  return marshal(v, ' ', false);
}

async function projectsList(t) {
  const rows = [];
  let ents = [];
  try {
    ents = fs.readdirSync(path.join(t.home, PROJECTS_DIR), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const e of ents) {
    if (!e.isDirectory() || !PROJECT_NAME_RE.test(e.name)) continue;
    let dir;
    try {
      dir = projectDir(t, e.name);
    } catch {
      continue;
    }
    const row = { name: e.name, versions: [], bytes: 0, lines: 0, updated: '', error: '' };
    try {
      row.versions = await projectVersions(dir);
    } catch (err) {
      row.error = err.message;
    }
    const st = plainFile(path.join(dir, PROJECT_PAGE));
    if (st) {
      row.bytes = st.size;
      row.updated = st.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
      if (st.size <= PROJECT_PAGE_CAP) {
        try {
          const b = fs.readFileSync(path.join(dir, PROJECT_PAGE));
          row.lines = b.reduce((n, c) => n + (c === 10 ? 1 : 0), 0);
        } catch {
          /* unread */
        }
      }
    }
    const n = row.versions.length;
    if (n && row.versions[n - 1].when) row.updated = row.versions[n - 1].when;
    rows.push(row);
  }
  rows.sort((a, b) => (a.updated > b.updated ? -1 : a.updated < b.updated ? 1 : 0));
  const shaped = rows.map((r) => struct({ name: r.name, versions: r.versions, bytes: r.bytes, lines: r.lines, updated: r.updated, error: r.error || undefined }));
  return projectsJSON({ world: t.name, count: shaped.length, projects: shaped });
}

async function projectsPage(t, name, version) {
  const dir = projectDir(t, name);
  let want = 0;
  if (version === undefined || version === null) {
    want = 0;
  } else if (typeof version === 'number') {
    want = Math.trunc(version);
    if (want !== version) throw new Error(`a version is a whole number, not ${version}`);
  } else if (typeof version === 'string') {
    const s = version.trim();
    if (s) {
      if (!/^[+-]?\d+$/.test(s)) throw new Error(`a version is a number, not ${q(s)}`);
      want = parseInt(s, 10);
    }
  } else {
    throw new Error(`a version is a number, not ${Array.isArray(version) ? '[]interface {}' : typeof version === 'boolean' ? 'bool' : 'map[string]interface {}'}`);
  }
  let vs;
  try {
    vs = await projectVersions(dir);
  } catch (e) {
    throw new Error(`${name}: ${e.message}`);
  }
  let text;
  let sha = '';
  if (want === 0) {
    const p = path.join(dir, PROJECT_PAGE);
    const st = plainFile(p);
    if (!st) throw new Error(`${name} has no ${PROJECT_PAGE} of its own yet`);
    if (st.size > PROJECT_PAGE_CAP) throw new Error(`${name}'s page is ${st.size} bytes, past the ${PROJECT_PAGE_CAP} this serves`);
    text = fs.readFileSync(p, 'utf8');
    want = vs.length;
    if (want > 0) sha = vs[want - 1].sha;
  } else {
    if (want < 1 || want > vs.length) throw new Error(`there is no version ${want} -- ${name} has versions 1 to ${vs.length}`);
    sha = vs[want - 1].sha;
    const res = await projectGit(dir, 'show', sha + ':' + PROJECT_PAGE);
    if (res.err) throw new Error(`version ${want} of ${name} could not be read: ${firstLines(res.combined, 2).trim()}`);
    if (Buffer.byteLength(res.stdout) > PROJECT_PAGE_CAP) throw new Error(`version ${want} of ${name} is past the ${PROJECT_PAGE_CAP} bytes this serves`);
    text = res.stdout;
  }
  return projectsJSON({ world: t.name, name, version: want, sha, bytes: Buffer.byteLength(text), text });
}

async function toolProjects(t, args) {
  const action = str(args, 'action').trim().toLowerCase();
  if (action === '' || action === 'list') return projectsList(t);
  if (action === 'page') return projectsPage(t, str(args, 'name').trim(), args.version);
  throw new Error(`projects takes action list or page, not ${q(action)}`);
}

const gitTools = [
  { name: 'git', writes: false, description: "the world's repository as it stands now: branch, head, dirty counts, upstream, and whether remote operations are walled", args: ['project?'], fn: toolGit },
  {
    name: 'git_diff',
    writes: false,
    description: "what actually changed: one file's change served whole, or the whole tree's; a file git has never seen comes back as its contents, said plainly",
    args: ['file?', 'project?'],
    fn: toolGitDiff,
  },
  { name: 'git_remote', writes: false, description: "where this world sends: each remote by name, its host, and whether the estate's wall is open", args: ['project?'], fn: toolGitRemote },
  {
    name: 'projects',
    writes: false,
    description: "what the maker made: every project under projects/ with its versions read from its own history, or one project's page as it stands (or as a version was)",
    args: ['action?', 'name?', 'version?', 'project?'],
    fn: toolProjects,
  },
];

module.exports = { gitTools, gitRun, isRepo, mainLine, mainByPullRequest, hostOf, NOT_A_REPO };
