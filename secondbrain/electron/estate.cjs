/**
 * The Estate for Steward: what SecondBrain runs, as MCP tools on its own /mcp (atlas.cjs handleMcp), so Steward can
 * see and work the Estate himself. Nothing here starts, stops or reads anything new: each tool is the path the window
 * already takes (the Servers shelf's registry, the updater, the Approvals history), and Ollama's own API.
 *
 *   estate_status       read   every server (name, port, up, pid, started), SecondBrain's build, Ollama, the sitting,
 *                              and each Estate repository's version (versionsApi: local refs only, cached 60 s)
 *   estate_logs         read   the tail of one server's log, as the Servers shelf shows it (at most 400 lines)
 *   service_control     write  start | stop | restart one server, as the shelf's services:control does
 *   ollama_unload       write  one model out of memory (keep_alive 0)
 *   app_update          check is a read; apply is a write (it quits SecondBrain into the new build)
 *   approvals_history   read   the answered cards, newest first (at most 200)
 *   eval_start          bounded  Steward's eval sets, by run-bar.ps1 in its own minimized window (served with the reads)
 *   eval_status         read   one eval_start run's progress file
 *
 * A write is served only while the operator allows writes (Settings → Share), as WRITE_TOOLS are, and each says so
 * in its MCP annotations (readOnlyHint false), so Steward's side puts it on the operator's card.
 *
 * eval_start is the one bounded action (the operator, 2026-11-05: "Steward can automate on his own"): it starts only
 * run-bar.ps1, only for set names that are set files in Steward's harness/steward/evals/, only while no eval is
 * running, and an eval set writes only Steward's eval history and throwaway working copies. So it is served with the
 * reads, never on a card, and a scheduled automation can start the overnight evals.
 *
 * Never: SecondBrain itself (it is the one serving this), the door while a Manjuel sitting is open (RULE 9), or a
 * log whose name starts with .env (RULE 7).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const OLLAMA = { host: '127.0.0.1', port: 11434 };
const MAX_LOG_LINES = 400;
const MAX_HISTORY = 200;
const SELF = ['secondbrain', 'jesster'];
const ACTIONS = ['start', 'stop', 'restart'];

const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
// eval_start: it starts a process, so not a read; bounded (eval sets only), so served with the reads
const bounded = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// Steward's eval sets, in his folder (steward.cjs findSteward): the set files, the runner, and each run's folder
const EVALS_DIR = ['harness', 'steward', 'evals'];
const RUN_BAR = [...EVALS_DIR, 'run-bar.ps1'];
const RUNS_DIR = ['storage', 'evals', 'runs'];
const TAG = /^[\w.-]+$/;
const MAX_RUNS = 3;
// run-bar.ps1 -Transport: in-process (the tool's default), or the running Responses or AG-UI host
const TRANSPORTS = ['in-process', 'responses', 'ag-ui'];
const MAX_STATUS_LINES = 200;

const ESTATE_TOOLS = [
  {
    name: 'estate_status',
    description:
      "The Estate as SecondBrain runs it: each server (name, port, up, pid, started), SecondBrain's build, Ollama's version and loaded models, whether a Manjuel sitting is open, and each repository's version (repos: branch, head, origin_main, behind and ahead of origin/main, clean; from the local refs, up to a minute old).",
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Estate status', ...read },
  },
  {
    name: 'estate_logs',
    description: "The last lines of one server's log, as SecondBrain's Servers shelf shows it. service is a name from estate_status.",
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string' }, lines: { type: 'integer', minimum: 1, maximum: MAX_LOG_LINES, description: `at most ${MAX_LOG_LINES}; 100 when left out` } },
      required: ['service'],
    },
    annotations: { title: 'Estate logs', ...read },
  },
  {
    name: 'service_control',
    description:
      "Start, stop or restart one server SecondBrain runs (a name from estate_status), as the Servers shelf's buttons do. A write: it waits on the operator's card. Never SecondBrain itself, and never the door while a Manjuel sitting is open.",
    inputSchema: { type: 'object', properties: { service: { type: 'string' }, action: { type: 'string', enum: ACTIONS } }, required: ['service', 'action'] },
    annotations: { title: 'Control a server', ...write },
  },
  {
    name: 'ollama_unload',
    description: "Unload one model from Ollama's memory now (keep_alive 0). A write: it waits on the operator's card.",
    inputSchema: { type: 'object', properties: { model: { type: 'string', description: 'a name from estate_status ollama.models' } }, required: ['model'] },
    annotations: { title: 'Unload an Ollama model', ...write, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'app_update',
    description:
      "SecondBrain's own update. check: this build and the newest on GitHub (a read). apply: download it and restart SecondBrain into it (a write: it waits on the operator's card, and ends this connection).",
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['check', 'apply'] } }, required: ['action'] },
    annotations: { title: "SecondBrain's update", ...write, openWorldHint: true },
  },
  {
    name: 'approvals_history',
    description: 'The cards the operator has answered (Allow, Deny, Always, a timeout), newest first: id, tool, summary, answer, where (window, telegram, whatsapp or discord), time.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_HISTORY, description: `at most ${MAX_HISTORY}; 50 when left out` } } },
    annotations: { title: 'Approvals history', ...read },
  },
  {
    name: 'eval_start',
    description:
      "Start Steward's eval sets: run-bar.ps1 in its own minimized window, each set run `runs` times, one after another. sets: set names from harness/steward/evals/ (e.g. small, steps, heldout, aider-py, bfcl); runs: 1 to 3 (1 when left out); tag: letters, digits, '.', '-' or '_', not used before (<sets>-<date> when left out). Refused while an eval is already running. A bounded Estate action, served with the reads and never on a card: it only runs eval sets, which write only Steward's eval history and throwaway working copies. Returns the tag and its progress file; read it with eval_status.",
    inputSchema: {
      type: 'object',
      properties: {
        sets: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'set names, e.g. ["aider-py"]' },
        runs: { type: 'integer', minimum: 1, maximum: MAX_RUNS, description: 'runs of each set; 1 when left out' },
        tag: { type: 'string', description: "the run's name; <sets>-<date> when left out" },
        transport: { type: 'string', enum: TRANSPORTS, description: 'in-process when left out; ag-ui or responses send each case to that running host' },
      },
      required: ['sets'],
    },
    annotations: { title: 'Start eval sets', ...bounded },
  },
  {
    name: 'eval_status',
    description:
      `One eval_start run's progress file (storage/evals/runs/<tag>/progress.txt in Steward's folder): its last lines (at most ${MAX_STATUS_LINES}), one as each run starts and ends with its counts, then each set's bar, and done once it says "BAR DONE". tag: the run's tag; the newest run when left out.`,
    inputSchema: { type: 'object', properties: { tag: { type: 'string' } } },
    annotations: { title: 'Eval progress', ...read },
  },
];

const NAMES = ESTATE_TOOLS.map((t) => t.name);

/** Is this call a write (refused while the operator allows reads only)? */
function isWrite(name, args = {}) {
  if (name === 'app_update') return args.action === 'apply';
  return name === 'service_control' || name === 'ollama_unload';
}

/** The set names in Steward's harness/steward/evals/: each set file's `name:` line, sorted. */
function evalSetNames(dir) {
  const folder = path.join(dir, ...EVALS_DIR);
  let files = [];
  try {
    files = fs.readdirSync(folder).filter((f) => f.endsWith('.yaml'));
  } catch {
    return [];
  }
  const names = [];
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(folder, f), 'utf8');
    } catch {
      continue;
    }
    const m = /^name:[ \t]*["']?([\w.-]+)["']?[ \t]*\r?$/m.exec(text);
    if (m) names.push(m[1]);
  }
  return [...new Set(names)].sort();
}

// an eval running now: an evals.py under Python, or run-bar.ps1 between its runs (not this query's own PowerShell)
const RUNNING_QUERY =
  "@(Get-CimInstance Win32_Process -Filter \"ProcessId <> $PID AND ((Name LIKE 'python%' AND CommandLine LIKE '%evals.py%') OR CommandLine LIKE '%run-bar.ps1%')\").Count";

/**
 * The eval tools' outside acts, as the app runs them (tests give fakes): `dir()` Steward's folder or null; `running()`
 * whether an eval runs now (one Win32_Process query, the script on stdin); `launch({ dir, sets, runs, tag })` starts
 * run-bar.ps1 detached in its own minimized PowerShell window and returns { pid }.
 */
function evalsApi({ stewardDir }) {
  return {
    dir: () => stewardDir(),
    running: () =>
      new Promise((resolve, reject) => {
        const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
          if (err) return reject(new Error(`could not tell whether an eval is running: ${err.message}`));
          resolve((parseInt(String(stdout).trim(), 10) || 0) > 0);
        });
        child.stdin.end(`${RUNNING_QUERY}\r\n`);
      }),
    launch: ({ dir, sets, runs, tag, transport = 'in-process' }) => {
      const args = ['-NoProfile', '-WindowStyle', 'Minimized', '-File', path.join(dir, ...RUN_BAR), '-Sets', sets.join(','), '-Runs', String(runs), '-Tag', tag, '-Transport', transport];
      const child = spawn('powershell.exe', args, { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { pid: child.pid ?? null };
    },
  };
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** eval_start: the sets checked against the set files, nothing while an eval runs, then run-bar.ps1. */
async function evalStart(args, evals) {
  const dir = evals.dir();
  if (!dir) return { error: "Steward's folder was not found (Settings → Agent → Steward), so no eval can start." };
  if (!fs.existsSync(path.join(dir, ...RUN_BAR))) return { error: `run-bar.ps1 was not found at ${path.join(dir, ...RUN_BAR)}.` };
  const sets = Array.isArray(args.sets) ? [...new Set(args.sets.map((x) => String(x).trim()).filter(Boolean))] : [];
  if (!sets.length) return { error: 'eval_start needs sets: one or more set names from harness/steward/evals/' };
  const known = evalSetNames(dir);
  const unknown = sets.filter((x) => !known.includes(x));
  if (unknown.length) return { error: `No such eval set: ${unknown.join(', ')}. The sets are: ${known.join(', ')}.` };
  const runs = args.runs === undefined || args.runs === null ? 1 : Number(args.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) return { error: `runs is 1 to ${MAX_RUNS}` };
  const tag = args.tag === undefined || args.tag === null || args.tag === '' ? `${sets.join('_')}-${today()}` : String(args.tag);
  if (!TAG.test(tag)) return { error: `tag "${tag}" must be letters, digits, '.', '-' or '_'` };
  const folder = path.join(dir, ...RUNS_DIR, tag);
  if (fs.existsSync(path.join(folder, 'progress.txt'))) return { error: `tag "${tag}" has a run already (${path.join(folder, 'progress.txt')}); give a new tag.` };
  if (await evals.running()) return { error: 'An eval is running now; nothing was started. Read its progress with eval_status.' };
  const transport = args.transport === undefined || args.transport === null || args.transport === '' ? 'in-process' : String(args.transport);
  if (!TRANSPORTS.includes(transport)) return { error: `transport is one of ${TRANSPORTS.join(', ')}` };
  const { pid } = await evals.launch({ dir, sets, runs, tag, transport });
  return JSON.stringify({ started: true, tag, sets, runs, transport, pid, progress: path.join(folder, 'progress.txt') });
}

/** eval_status: one run's progress file, the newest run's when no tag is given. */
function evalStatus(args, evals) {
  const dir = evals.dir();
  if (!dir) return { error: "Steward's folder was not found (Settings → Agent → Steward)." };
  const runsDir = path.join(dir, ...RUNS_DIR);
  let tag = args.tag ? String(args.tag) : '';
  if (tag && !TAG.test(tag)) return { error: `tag "${tag}" must be letters, digits, '.', '-' or '_'` };
  if (!tag) {
    let newest = null;
    try {
      for (const d of fs.readdirSync(runsDir)) {
        const f = path.join(runsDir, d, 'progress.txt');
        if (!fs.existsSync(f)) continue;
        const t = fs.statSync(f).mtimeMs;
        if (!newest || t > newest.t) newest = { d, t };
      }
    } catch {
      /* no runs yet: said below */
    }
    if (!newest) return { error: 'No eval run has a progress file yet.' };
    tag = newest.d;
  }
  const file = path.join(runsDir, tag, 'progress.txt');
  if (!fs.existsSync(file)) return { error: `No progress file for tag "${tag}" (${file}): it has not started, or the tag is wrong.` };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  return JSON.stringify({ tag, file, done: lines.some((l) => /\bBAR DONE\s*$/.test(l)), lines: lines.slice(-MAX_STATUS_LINES) });
}

/** One JSON request to Ollama on loopback: the parsed answer, or an Error. */
function ollamaJson(port, method, path, body, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { host: OLLAMA.host, port, method, path, timeout, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* said below */
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && json) resolve(json);
          else reject(new Error(`Ollama answered ${res.statusCode}: ${(json && json.error) || text.slice(0, 200)}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Ollama did not answer in time')));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

/** Ollama's API as estate_status and ollama_unload use it, on 127.0.0.1:`port` (11434; tests give their own). */
function ollamaApi(port = OLLAMA.port) {
  return {
    version: () => ollamaJson(port, 'GET', '/api/version'),
    ps: () => ollamaJson(port, 'GET', '/api/ps'),
    unload: (model) => ollamaJson(port, 'POST', '/api/generate', { model, keep_alive: 0 }),
  };
}
const ollama = ollamaApi();

// The Estate's versions (the operator, 2026-11-05: Neiro is no longer the version gate; the versions are read here):
// each repository's branch, HEAD, origin/main and how far apart they are, from the local refs alone (no fetch, never
// git status or git diff), cached VERSIONS_TTL_MS so estate_status stays fast.
const VERSIONS_TTL_MS = 60000;
const VERSION_REPOS = ['research', 'steward', 'jesster', 'atlas'];

/** One repository's version from its local refs: { name, branch, head, origin_main, behind, ahead, clean } or { name, error }. */
async function repoVersion(repo, run) {
  const git = (...args) => run('git', args, repo.dir);
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch.code !== 0) return { name: repo.name, dir: repo.dir, error: String(branch.err || 'not a git repository').split('\n')[0] };
  const head = await git('rev-parse', '--short', 'HEAD');
  const main = await git('rev-parse', '--short', 'origin/main');
  const v = { name: repo.name, dir: repo.dir, branch: branch.out, head: head.out || null, origin_main: main.code === 0 ? main.out : null };
  if (main.code === 0) {
    // "<behind> <ahead>": commits on origin/main not in HEAD, and in HEAD not on origin/main
    const count = await git('rev-list', '--left-right', '--count', 'origin/main...HEAD');
    const m = /^(\d+)\s+(\d+)$/.exec(String(count.out).trim());
    if (count.code === 0 && m) Object.assign(v, { behind: Number(m[1]), ahead: Number(m[2]) });
  }
  // tracked changes against HEAD, read without git status (the index is not written); left out if it cannot be read
  const dirty = await git('diff-index', '--quiet', 'HEAD', '--');
  if (dirty.code === 0 || dirty.code === 1) v.clean = dirty.code === 0;
  return v;
}

/**
 * The Estate's versions, cached: `repos()` the repositories ({ name, dir }; workflows.cjs estateRepos, Neiro left
 * out), `run(cmd, args, cwd)` → { code, out, err } (workflows.cjs run; tests give a fake), `clock()` for the cache.
 * Returns an async function: the list, read again only once it is VERSIONS_TTL_MS old.
 */
function versionsApi({ repos, run, ttlMs = VERSIONS_TTL_MS, clock = Date.now }) {
  let cache = null;
  return async () => {
    const now = clock();
    if (cache && now - cache.at < ttlMs) return cache.list;
    const list = await Promise.all(repos().filter((r) => VERSION_REPOS.includes(r.name)).map((r) => repoVersion(r, run)));
    cache = { at: now, list };
    return list;
  };
}

async function status({ servers, buildInfo, sitting, ollama: api = ollama, versions }) {
  const list = await servers.list();
  const services = list.map((s) => ({ name: s.id, label: s.label, port: s.port, up: s.status === 'up', status: s.status, pid: s.pid ?? null, started: s.started ?? null }));
  let o = { up: false, version: null, models: [] };
  try {
    const v = await api.version();
    const ps = await api.ps();
    o = {
      up: true,
      version: v.version || null,
      models: (ps.models || []).map((m) => ({ name: m.name || m.model, size_vram: m.size_vram ?? null, expires_at: m.expires_at ?? null })),
    };
  } catch (e) {
    o.error = e.message;
  }
  const n = sitting();
  let repos;
  if (versions) {
    try {
      repos = await versions();
    } catch (e) {
      repos = { error: e.message };
    }
  }
  return { services, secondbrain: { build: buildInfo(), pid: process.pid }, ollama: o, sitting: n ? { open: true, n } : { open: false }, ...(versions ? { repos } : {}) };
}

/**
 * One estate tool's call → the text of its result, or { error }. `deps`: { servers (services.cjs registry), buildInfo,
 * check, apply (updater.cjs), sitting() (the open sitting's number on the ground, or ''), history ({ read }), ollama }.
 */
async function estateCall(name, args, deps, { writes = false } = {}) {
  args = args || {};
  if (!NAMES.includes(name)) return { error: `no tool ${name}` };
  if (isWrite(name, args) && !writes) return { error: `${name}${name === 'app_update' ? ' apply' : ''} is a write; the user allows reads only (SecondBrain → Settings → Share)` };
  try {
    if (name === 'estate_status') return JSON.stringify(await status(deps));
    if (name === 'estate_logs') {
      const lines = Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(Number(args.lines) || 100)));
      const r = deps.servers.log(String(args.service || ''), lines);
      return r.ok ? JSON.stringify({ service: String(args.service), file: r.file, text: r.text }) : { error: r.error };
    }
    if (name === 'service_control') {
      const id = String(args.service || '').trim();
      const action = String(args.action || '');
      if (SELF.includes(id.toLowerCase())) return { error: 'SecondBrain is not started or stopped by its own tools: it is the one serving them.' };
      if (!ACTIONS.includes(action)) return { error: `Unknown action: ${action} (start, stop or restart)` };
      if (id === 'door' && action !== 'start') {
        const n = deps.sitting();
        if (n) return { error: `Sitting ${n} is open in Manjuel: the door is not stopped under it (RULE 9). Ask the operator to close it first.` };
      }
      const r = await deps.servers.control(id, action);
      return r.ok ? JSON.stringify({ service: id, action, ok: true }) : { error: r.error };
    }
    if (name === 'ollama_unload') {
      const model = String(args.model || '').trim();
      if (!model) return { error: 'ollama_unload needs the model' };
      const r = await (deps.ollama || ollama).unload(model);
      return JSON.stringify({ model, unloaded: true, done_reason: r.done_reason || null });
    }
    if (name === 'app_update') {
      if (args.action === 'check') return JSON.stringify(await deps.check());
      if (args.action === 'apply') return JSON.stringify(await deps.apply());
      return { error: 'app_update action is check or apply' };
    }
    if (name === 'approvals_history') return JSON.stringify(deps.history.read(Math.min(MAX_HISTORY, Number(args.limit) || 50)));
    if (name === 'eval_start' || name === 'eval_status') {
      if (!deps.evals) return { error: "Steward's evals are not served here" };
      return name === 'eval_start' ? await evalStart(args, deps.evals) : evalStatus(args, deps.evals);
    }
  } catch (e) {
    return { error: e.message };
  }
  return { error: `no tool ${name}` };
}

module.exports = { ESTATE_TOOLS, NAMES, estateCall, isWrite, ollama, ollamaApi, status, versionsApi, repoVersion, VERSIONS_TTL_MS, evalsApi, evalSetNames, TRANSPORTS, evalStart, evalStatus, RUNNING_QUERY, MAX_LOG_LINES, MAX_HISTORY, MAX_RUNS };
