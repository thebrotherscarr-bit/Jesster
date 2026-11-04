/**
 * The Agent tab's console: what Steward's operator watches him by, read from Steward's own folder (steward.cjs
 * findSteward). Everything here only reads, and only inside that folder: a path that resolves outside it is refused,
 * and so is any file or folder whose name starts with ".env" (his keys are never read, shown or copied).
 *
 *   evals    storage/evals/history.jsonl (newest first) and harness/steward/step04_production_ready/eval_baselines.json
 *   runs     the tail of halo_traces/traces.jsonl (the file grows past 100 MB: only its last TAIL_BYTES are read)
 *   skills   harness/steward/skills/<name>/SKILL.md, name and description from the frontmatter
 *   memory   his memory stores (MEMORY_DIRS): the file list, and one file's text on request
 *
 * His tool policy is read by approvals.cjs (approvals:policy) and is not read again here.
 */
const fs = require('fs');
const path = require('path');

const EVALS_FILE = ['storage', 'evals', 'history.jsonl'];
const BASELINE_FILE = ['harness', 'steward', 'step04_production_ready', 'eval_baselines.json'];
const TRACES_FILE = ['halo_traces', 'traces.jsonl'];
const SKILLS_DIR = ['harness', 'steward', 'skills'];
const MEMORY_DIRS = ['agent-file-memory', 'agent-memory'];
const TAIL_BYTES = 2 * 1024 * 1024;
const MEMORY_MAX_BYTES = 256 * 1024;
const MEMORY_MAX_FILES = 200;
const ARGS_MAX = 160;

const isEnvName = (name) => /^\.env/i.test(String(name));

/**
 * The absolute path of `rel` inside `root`, or an Error thrown: no root, a path that leaves the root (by "..", an
 * absolute path, or a link that points out), or any part of it named ".env*".
 */
function inside(root, rel) {
  if (!root) throw new Error("Steward's folder was not found.");
  const parts = Array.isArray(rel) ? rel : String(rel || '').split(/[\\/]+/);
  if (parts.some(isEnvName)) throw new Error('refused: .env files are never read');
  if ((!Array.isArray(rel) && path.isAbsolute(String(rel || ''))) || parts.some((p) => path.isAbsolute(p) || p.includes(':'))) {
    throw new Error(`refused: ${parts.join('/')} is outside Steward's folder`);
  }
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  const within = (b, t) => {
    const r = path.relative(b, t);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  if (!within(base, target)) throw new Error(`refused: ${parts.join('/')} is outside Steward's folder`);
  if (fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    if (!within(fs.realpathSync(base), real)) throw new Error(`refused: ${parts.join('/')} leads outside Steward's folder`);
    if (isEnvName(path.basename(real))) throw new Error('refused: .env files are never read');
  }
  return target;
}

/** The last `maxBytes` of a file, cut at the first whole line; the rest of the file is never read. */
function tailRead(file, maxBytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (!n) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    return { text, size, start, bytes: read };
  } finally {
    fs.closeSync(fd);
  }
}

const jsonLines = (text) => {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a half-written line is skipped */
    }
  }
  return out;
};

/** The eval history, one row per run, newest first. */
function parseEvals(text) {
  return jsonLines(text)
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      ts: String(r.ts || ''),
      set: String(r.set || ''),
      passed: Number(r.passed) || 0,
      total: Number(r.total) || 0,
      checksPassed: Number(r.checks_passed) || 0,
      checksTotal: Number(r.checks_total) || 0,
      model: r.model ? String(r.model) : '',
      gitHead: r.git_head ? String(r.git_head) : '',
      exitCode: r.exit_code == null ? null : Number(r.exit_code),
      cases: (Array.isArray(r.cases) ? r.cases : []).map((c) => ({
        input: String((c && c.input) || ''),
        passed: Boolean(c && c.passed),
        failed: (Array.isArray(c && c.failed_checks) ? c.failed_checks : []).map((f) => ({ name: String((f && f.name) || ''), reason: String((f && f.reason) || '') })),
      })),
    }))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

const cut = (s, n = ARGS_MAX) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * The runs in a tail of traces.jsonl, by trace id, newest first: when it started, its root span, the tools it
 * called (name and arguments cut short) and its errors. A trace that only pinged or listed tools is counted, not
 * listed.
 */
function summarizeTraces(text, limit = 25) {
  const traces = new Map();
  for (const s of jsonLines(text)) {
    if (!s || !s.trace_id) continue;
    let t = traces.get(s.trace_id);
    if (!t) traces.set(s.trace_id, (t = { traceId: s.trace_id, start: '', end: '', root: '', spans: 0, tools: [], errors: [], work: false }));
    t.spans += 1;
    const a = s.attributes || {};
    const name = String(s.name || '');
    if (s.start_time && (!t.start || s.start_time < t.start)) t.start = s.start_time;
    if (s.end_time && (!t.end || s.end_time > t.end)) t.end = s.end_time;
    if (!s.parent_span_id) t.root = name;
    if (/^(invoke_agent|workflow\.run|chat\.|executor\.)/.test(name)) t.work = true;
    if (a['gen_ai.operation.name'] === 'execute_tool' || a['openinference.span.kind'] === 'TOOL') {
      t.work = true;
      t.tools.push({ at: s.start_time || '', name: String(a['gen_ai.tool.name'] || a['tool.name'] || name), args: cut(a['gen_ai.tool.call.arguments'] || a['input.value'] || ''), ok: !(s.status && s.status.code === 'STATUS_CODE_ERROR') });
    }
    if (s.status && s.status.code === 'STATUS_CODE_ERROR') t.errors.push({ name, message: cut(s.status.message || '', 300) });
  }
  const all = [...traces.values()];
  const runs = all.filter((t) => t.work);
  for (const t of runs) t.tools.sort((x, y) => (x.at < y.at ? -1 : 1));
  runs.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
  return {
    runs: runs.slice(0, limit).map(({ work, ...t }) => t),
    background: all.length - runs.length,
    backgroundErrors: all.filter((t) => !t.work).reduce((n, t) => n + t.errors.length, 0),
  };
}

/** name and description from a SKILL.md's frontmatter (--- ... ---); '' where absent. */
function frontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const out = { name: '', description: '' };
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function readSkills(dir) {
  const root = inside(dir, SKILLS_DIR);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || isEnvName(e.name)) continue;
    const file = path.join(root, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const fm = frontmatter(fs.readFileSync(file, 'utf8'));
    out.push({ folder: e.name, name: fm.name || e.name, description: fm.description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Every file in his memory stores, as paths relative to his folder; no .env*, no dot folders. */
function listMemory(dir) {
  const files = [];
  const walk = (rel, depth) => {
    if (files.length >= MEMORY_MAX_FILES || depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(inside(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    // his live memory before what he set aside: files, then folders, and an attic last
    const rank = (e) => (e.isDirectory() ? (e.name === 'attic' ? 2 : 1) : 0);
    entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (isEnvName(e.name) || e.name.startsWith('.') || e.name === '__pycache__') continue;
      const next = [...rel, e.name];
      if (e.isDirectory()) walk(next, depth + 1);
      else if (e.isFile() && files.length < MEMORY_MAX_FILES) {
        let size = 0;
        try {
          size = fs.statSync(inside(dir, next)).size;
        } catch {
          continue;
        }
        files.push({ path: next.join('/'), size });
      }
    }
  };
  for (const m of MEMORY_DIRS) walk([m], 0);
  return files;
}

/** One memory file's text (its first MEMORY_MAX_BYTES); only inside a memory store. */
function readMemory(dir, rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  if (!MEMORY_DIRS.includes(parts[0])) throw new Error('refused: not one of his memory stores');
  if (parts.some((p) => p.startsWith('.'))) throw new Error('refused: hidden files are not shown');
  const file = inside(dir, parts);
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, MEMORY_MAX_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { path: parts.join('/'), size, text: buf.subarray(0, n).toString('utf8'), cut: size > MEMORY_MAX_BYTES };
  } finally {
    fs.closeSync(fd);
  }
}

function readEvals(dir) {
  const file = inside(dir, EVALS_FILE);
  const history = fs.existsSync(file) ? parseEvals(fs.readFileSync(file, 'utf8')) : [];
  let baseline = null;
  let baselineError = '';
  const bfile = inside(dir, BASELINE_FILE);
  if (fs.existsSync(bfile)) {
    try {
      baseline = JSON.parse(fs.readFileSync(bfile, 'utf8'));
    } catch (e) {
      baselineError = `not JSON: ${e.message}`;
    }
  }
  return { file, history, baseline, ...(baselineError ? { baselineError } : {}) };
}

function readRuns(dir, maxBytes = TAIL_BYTES) {
  const file = inside(dir, TRACES_FILE);
  if (!fs.existsSync(file)) return { file, size: 0, read: 0, runs: [], background: 0, backgroundErrors: 0 };
  const t = tailRead(file, maxBytes);
  return { file, size: t.size, read: t.bytes, ...summarizeTraces(t.text) };
}

/** The IPC handlers: one per shelf, each guarded as the app's others are; `stewardDir()` is findSteward's answer. */
function register({ ipcMain, guard, stewardDir }) {
  const on = (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      guard(event);
      return fn(stewardDir(), ...args);
    });
  on('console:evals', (dir) => readEvals(dir));
  on('console:runs', (dir) => readRuns(dir));
  on('console:skills', (dir) => ({ skills: readSkills(dir) }));
  on('console:memory', (dir) => ({ files: listMemory(dir) }));
  on('console:memory-read', (dir, rel) => readMemory(dir, rel));
}

module.exports = {
  inside,
  tailRead,
  parseEvals,
  summarizeTraces,
  frontmatter,
  readSkills,
  listMemory,
  readMemory,
  readEvals,
  readRuns,
  register,
  EVALS_FILE,
  BASELINE_FILE,
  TRACES_FILE,
  SKILLS_DIR,
  MEMORY_DIRS,
  TAIL_BYTES,
};
