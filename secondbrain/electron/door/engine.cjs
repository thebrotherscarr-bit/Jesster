/**
 * The door's engine tools, ported from atlas/line internal/engine (engine.go)
 * and internal/tools (tools.go): one long-lived Manjuel process per open world,
 * spoken to over its pipes (manjuel/serve.py, PROTOCOL 1: objective, answer,
 * cancel, close in; events out), and the core's own scripts run in the world:
 * the suites, the live standup and the release's steps.
 *
 * The faults the Go door fixed are kept fixed here: an unreadable ledger line
 * refuses (C5); a boot that overruns is CLOSED, never killed, so its sitting is
 * tolled (C1); opens are serialised so two never fork the ledger (C2); a cancel
 * at a question clears it and drains the abandoned ending (C4); a dead engine
 * is never handed back as open (I5).
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn: spawnChild } = require('child_process');
const { spawn, str, q, truncateRunes } = require('./util.cjs');
const { regOf } = require('./registry.cjs');

const OPEN_TIMEOUT = 120000;
const SHUTDOWN_GRACE = 60000;
const KEPT_EVENTS = 400;
const TERMINAL = new Set(['delivery', 'refused', 'aborted', 'cancelled', 'unreachable', 'command']);

/** splitCommand: quotes kept together so a path with spaces survives. */
function splitCommand(s) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const c of String(s || '')) {
    if (quote) {
      if (c === quote) quote = '';
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === ' ' || c === '\t') {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** The ledger's last line: [row, unknown, found]. */
function lastSitting(ground) {
  let text;
  try {
    text = fs.readFileSync(path.join(ground, 'sessions', 'sessions.jsonl'), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [null, '', false];
    return [null, 'unreadable ledger: ' + e.message, true];
  }
  const lines = text.replace(/[\r\n]+$/, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      return [JSON.parse(line), '', true];
    } catch {
      return [null, 'the last ledger line is not readable JSON', true];
    }
  }
  return [null, '', false];
}

/** [n, started, open]; an unknown ledger reads OPEN (C5). */
function sittingOpen(ground) {
  const [row, unknown, found] = lastSitting(ground);
  if (!found) return [0, '', false];
  if (unknown) return [0, unknown, true];
  if (typeof row.ended === 'string' && row.ended.trim()) return [0, '', false];
  return [typeof row.n === 'number' ? row.n : 0, typeof row.started === 'string' ? row.started : '', true];
}

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e && e.code === 'ESRCH';
  }
}

/** [pid, orphaned]: only a provable death counts. */
function sittingOrphaned(ground) {
  const [row, unknown, found] = lastSitting(ground);
  if (!found || unknown) return [0, false];
  if (typeof row.ended === 'string' && row.ended.trim()) return [0, false];
  const pid = Math.trunc(Number(row.pid) || 0);
  if (pid <= 0) return [0, false];
  return [pid, processGone(pid)];
}

const evStr = (ev, k) => (ev == null || ev[k] == null ? '' : typeof ev[k] === 'string' ? ev[k] : String(ev[k]));

class Engine {
  constructor(name, ground, coreCmd, child) {
    this.name = name;
    this.ground = ground;
    this.coreCmd = coreCmd;
    this.started = new Date();
    this.child = child;
    this.opened = null;
    this.pending = null;
    this.closed = false;
    this.reaped = false;
    this.runs = 0;
    this.lastRun = null;
    this.busy = false;
    this.queue = []; // lines read but not yet taken
    this.waiters = [];
    this.errTail = '';
    this.exited = new Promise((r) => child.once('exit', r));
    this.ended = false;
    child.once('exit', () => {
      this.ended = true;
      this.flushWaiters();
    });
    child.stderr.on('data', (b) => {
      this.errTail = (this.errTail + b.toString('utf8')).slice(-8192);
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (!ev || typeof ev !== 'object') return;
      this.queue.push(ev);
      this.flushWaiters();
    });
  }

  flushWaiters() {
    while (this.waiters.length && (this.queue.length || this.ended)) {
      const w = this.waiters.shift();
      w(this.queue.length ? this.queue.shift() : null);
    }
  }

  /** The next event, or null when the process has ended. */
  next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.ended) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }

  stderrTail() {
    const t = this.errTail.trim();
    return t ? '\n-- the engine\'s own stderr --\n' + t : '';
  }

  send(row) {
    if (this.closed) throw new Error('this engine is closed');
    this.child.stdin.write(JSON.stringify(row) + '\n');
  }

  alive() {
    return !this.closed && !this.reaped && !this.ended;
  }

  /** Read the turn: every event kept up to KEPT_EVENTS, tokens counted. */
  async pump() {
    const r = { final: null, events: [], tokens: 0, dropped: 0, waiting: false };
    for (;;) {
      const ev = await this.next();
      if (!ev) {
        this.pending = null;
        throw new Error('the engine stopped speaking without finishing the turn' + this.stderrTail());
      }
      const kind = evStr(ev, 'event');
      if (kind === 'token') {
        r.tokens++;
        continue;
      }
      if (kind === 'text' || kind === 'think') continue;
      if (r.events.length < KEPT_EVENTS) r.events.push(ev);
      else r.dropped++;
      if (kind === 'needs_answer') {
        r.final = ev;
        r.waiting = true;
        this.pending = ev;
        return r;
      }
      if (TERMINAL.has(kind)) {
        r.final = ev;
        this.pending = null;
        return r;
      }
    }
  }

  async run(objective, feed, method, head, unattended = false) {
    if (this.busy) throw new Error('refused: a turn is already running on this world');
    if (this.closed) throw new Error('this engine is closed');
    if (this.pending) {
      throw new Error(
        `refused: the engine is waiting on an answer (${q(evStr(this.pending, 'prompt'))}). Answer it with run_answer before starting another turn -- the gate is yours, not the door's`,
      );
    }
    const row = { cmd: 'objective', text: objective };
    if (feed) row.feed = feed;
    if (method) row.method = method;
    if (head && head.model) row.model = head.model;
    if (head && head.voices && Object.keys(head.voices).length) row.voices = head.voices;
    if (unattended) row.unattended = true;
    this.busy = true;
    try {
      this.send(row);
      const res = await this.pump();
      if (!String(objective).trim().startsWith('/')) this.tick();
      return res;
    } finally {
      this.busy = false;
    }
  }

  async answer(text) {
    if (!this.pending) throw new Error('refused: nothing is being asked, so there is nothing to answer');
    this.busy = true;
    try {
      this.send({ cmd: 'answer', text });
      this.pending = null;
      const res = await this.pump();
      this.tick();
      return res;
    } finally {
      this.busy = false;
    }
  }

  /** Ctrl-C: reaches a turn in flight; at a question, clears it and drains the ending (C4). */
  cancel() {
    if (this.closed) throw new Error('this engine is closed');
    const wasWaiting = Boolean(this.pending);
    this.send({ cmd: 'cancel' });
    if (wasWaiting) {
      this.pending = null;
      this.pump().catch(() => {});
    }
  }

  tick() {
    this.runs++;
    this.lastRun = new Date();
  }

  /** Ask it to close, wait, kill only if it will not go. Resolves tollPaid. */
  async shutdown() {
    if (this.reaped) return false;
    this.reaped = true;
    this.closed = true;
    try {
      this.child.stdin.write(JSON.stringify({ cmd: 'close' }) + '\n');
    } catch {
      /* the pipe is gone */
    }
    let timer;
    const gone = await Promise.race([
      this.exited.then(() => true),
      new Promise((r) => {
        timer = setTimeout(() => r(false), SHUTDOWN_GRACE);
      }),
    ]);
    clearTimeout(timer);
    if (!gone) {
      try {
        this.child.kill();
      } catch {
        /* gone */
      }
      await this.exited;
    }
    try {
      this.child.stdin.end();
    } catch {
      /* gone */
    }
    return gone;
  }

  async close() {
    if (this.reaped) return false;
    if (this.pending || this.busy) {
      try {
        this.send({ cmd: 'cancel' });
      } catch {
        /* closing anyway */
      }
    }
    return this.shutdown();
  }
}

/** Spawn the engine inside the world and wait for `opened`. */
async function openEngine(name, ground, coreCmd, spawnFn = spawnChild) {
  if (!String(coreCmd || '').trim()) {
    throw new Error(
      'no engine wired: the door has no command that runs manjuel.py, so it has no engine to open. The glass can read the record; it cannot run a turn',
    );
  }
  let st;
  try {
    st = fs.statSync(ground);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw new Error(`refused: ${q(ground)} is not a directory; a world is never created here`);
  const [n, started, open] = sittingOpen(ground);
  if (open) {
    if (n === 0 && started) throw new Error(`refused: ${name} -- ${started}. THE LINE will not open a second engine on a world whose record it cannot read`);
    const [, gone] = sittingOrphaned(ground);
    if (!gone) {
      throw new Error(
        `refused: ${name} has an open sitting (${Math.trunc(n)}, opened ${started}). One engine per world -- a second would fork the ledger. Close it where it is being sat in, or open a different world`,
      );
    }
  }
  const fields = splitCommand(coreCmd);
  if (!fields.length) throw new Error('refused: the engine command is empty');
  const args = [...fields.slice(1), '--headless', '--ground', ground];
  let cwd = ground;
  const script = fields.slice(1).find((f) => f.toLowerCase().endsWith('.py'));
  if (script) {
    const d = path.dirname(script);
    if (d && d !== '.' && fs.existsSync(d)) cwd = d;
  }
  const child = spawnFn(fields[0], args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const e = new Engine(name, ground, coreCmd, child);
  let timer;
  const first = await Promise.race([
    (async () => {
      for (;;) {
        const ev = await e.next();
        if (!ev) return null;
        const k = evStr(ev, 'event');
        if (k === 'opened' || k === 'closed' || k === 'error') return ev;
      }
    })(),
    new Promise((r) => {
      timer = setTimeout(() => r('timeout'), OPEN_TIMEOUT);
    }),
  ]);
  clearTimeout(timer);
  if (first === 'timeout') {
    await e.shutdown();
    throw new Error(`the engine did not open inside ${OPEN_TIMEOUT / 1000}s; it was closed cleanly so its world stays openable${e.stderrTail()}`);
  }
  if (!first || evStr(first, 'event') !== 'opened') {
    const why = first && evStr(first, 'text') ? evStr(first, 'text') : 'the engine closed before it opened';
    await e.shutdown();
    throw new Error(`the engine did not open: ${why}${e.stderrTail()}`);
  }
  e.opened = first;
  return e;
}

/** One engine per world, and no orphans. */
class Engines {
  constructor() {
    this.open = new Map();
    this.opening = Promise.resolve();
  }

  get(ground) {
    const e = this.open.get(ground);
    if (e && !e.alive()) {
      this.open.delete(ground);
      return null;
    }
    return e || null;
  }

  list() {
    return [...this.open.values()].filter((e) => e.alive());
  }

  /** Serialised (C2): two opens never race into one ledger. */
  openOne(name, ground, coreCmd, spawnFn) {
    const run = this.opening.then(async () => {
      const have = this.get(ground);
      if (have) return have;
      const e = await openEngine(name, ground, coreCmd, spawnFn);
      this.open.set(ground, e);
      return e;
    });
    this.opening = run.catch(() => {});
    return run;
  }

  async closeOne(ground) {
    const e = this.open.get(ground);
    this.open.delete(ground);
    if (!e) throw new Error('no engine is open on that world');
    return e.close();
  }

  async closeAll() {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map((e) => e.close().catch(() => {})));
  }
}

const engines = new Engines();

// ---- rendering a turn --------------------------------------------------------------------

/** renderRun: the turn reported off the engine's OWN events, never a seat's prose (LAW 5). */
function renderRun(world, objective, res) {
  const f = res.final || {};
  if (res.waiting) {
    return `WAITING on ${q(world)}\n\n  ${evStr(f, 'prompt')}\n\nAnswer with run_answer. Nothing is assumed on your behalf (RULE 6).`;
  }
  const kind = evStr(f, 'event');
  if (kind !== 'delivery') return `${kind.toUpperCase()}: ${evStr(f, 'text')}\n${objective}`;
  let b = `${world} · ${evStr(f, 'pipeline')} · ${evStr(f, 'elapsed')}s\n\n${evStr(f, 'text')}\n`;
  b += '\n--- what actually ran ---\n';
  for (const ev of res.events) {
    if (evStr(ev, 'event') === 'tool_result') b += `  tool ${evStr(ev, 'action').padEnd(18)} ${ev.failed === true ? 'FAILED' : 'ok'}\n`;
  }
  if (Array.isArray(f.steps)) {
    for (const st of f.steps) b += `  seat ${String(st.seat).padEnd(18)} ${st.elapsed}s${st.skipped === true ? ' SKIPPED' : ''}\n`;
  }
  for (const k of ['failures', 'out_of_time']) {
    if (Array.isArray(f[k]) && f[k].length) b += `  ${k}: [${f[k].join(' ')}]\n`;
  }
  if (Array.isArray(f.notes)) for (const n of f.notes) b += `  note: ${n}\n`;
  b += `  transcript: ${evStr(f, 'transcript')} · ${res.tokens} tokens streamed\n`;
  return b;
}

/** runHead: `voice` every seat on one model, `voices` a model per seat over it. */
function runHead(args) {
  let voices = null;
  const v = args.voices;
  if (v != null && !(typeof v === 'string' && !v.trim())) {
    let doc = v;
    if (typeof v === 'string') {
      try {
        doc = JSON.parse(v);
      } catch (e) {
        throw new Error(`run_start voices must be a JSON object of seat -> model: ${e.message}`);
      }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('run_start voices must be a JSON object of seat -> model, or one as a string -- refused rather than run with a head nobody named');
    }
    voices = {};
    for (const [seat, model] of Object.entries(doc)) {
      if (typeof model !== 'string') throw new Error(`run_start voices: seat ${q(seat)} names ${typeof model}, not a model tag -- refused rather than guessed at`);
      if (!model.trim()) throw new Error(`run_start voices: seat ${q(seat)} names no model -- refused rather than run on nothing`);
      voices[seat] = model.trim();
    }
  }
  return { model: str(args, 'voice').trim(), voices };
}

// ---- the core's scripts, run in the world --------------------------------------------------

const RELEASE_STEPS = { bump: true, index: false, check: true, ci: true, record: true };
const releaseMark = (s) => /^v\d+\.\d+\.\d+$/.test(s);
const STANDUP_SETS = { morning: '', court: '--court', all: '--all' };
const SUITE_SCRIPTS = { strokes: 'test_manjuel.py', smoke: 'smoke_cli.py' };
const SUITE_SETS = { strokes: ['strokes'], smoke: ['smoke'], both: ['strokes', 'smoke'] };
let suiteRunning = false;

function python(coreCmd, what) {
  const f = splitCommand(coreCmd);
  if (!f.length) throw new Error(`refused: the door has no python to run ${what} with`);
  return f[0];
}

function needFile(t, rel, what) {
  const p = path.join(t.home, ...rel.split('/'));
  let ok = false;
  try {
    ok = fs.statSync(p).isFile();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`refused: ${q(t.name)} carries no ${rel} -- ${what} is the core's own, and this world is not it`);
  return p;
}

async function toolReleaseStep(coreCmd, t, args) {
  const step = str(args, 'step').trim().toLowerCase();
  if (!(step in RELEASE_STEPS)) throw new Error(`refused: the release's steps are bump, index, check, ci and record; ${q(step)} is none of them`);
  const mark = str(args, 'mark').trim();
  if (RELEASE_STEPS[step] && !releaseMark(mark)) throw new Error(`refused: ${step} names its mark as vX.Y.Z, and ${q(mark)} is not one`);
  const py = python(coreCmd, "the release's steps");
  const script = needFile(t, 'tests/cut.py', "the release's steps");
  const res = await spawn(py, RELEASE_STEPS[step] ? [script, step, mark] : [script, step], { dir: t.home, timeout: 45 * 60000 });
  if (res.timedOut) throw res.err;
  const out = res.combined.replace(/\r\n/g, '\n').trim();
  if (res.err) throw new Error(`release step ${step} refused (${res.err.message}):\n${out}`);
  return out;
}

async function toolStandupRun(coreCmd, t, args) {
  const set = str(args, 'set').trim().toLowerCase() || 'morning';
  if (!(set in STANDUP_SETS)) throw new Error(`refused: the standup's sets are morning, court and all; ${q(set)} is none of them`);
  const py = python(coreCmd, 'the standup');
  const script = needFile(t, 'tests/standup.py', 'the standup');
  const e = engines.get(t.home);
  if (e) throw new Error(`refused: an engine is open on ${q(t.name)} (sitting ${evStr(e.opened, 'sitting')}), and the standup opens a sitting of its own -- close it first (env_close)`);
  const [n, started, sat] = sittingOpen(t.home);
  if (sat) throw new Error(`refused: ${q(t.name)} has an open sitting (${Math.trunc(n)}, opened ${started}), and the standup opens one of its own`);
  const res = await spawn(py, STANDUP_SETS[set] ? [script, STANDUP_SETS[set]] : [script], { dir: t.home, timeout: 30 * 60000 });
  if (res.timedOut) throw res.err;
  const combined = res.combined.replace(/\r\n/g, '\n');
  let tally = '';
  let report = '';
  for (let ln of combined.split('\n')) {
    ln = ln.trim();
    if (!ln.includes('cases met their expectations')) continue;
    tally = ln;
    const i = ln.indexOf('report: ');
    if (i >= 0) {
      report = ln.slice(i + 8).trim();
      tally = ln.slice(0, i).trim();
    }
  }
  const exit = res.err ? res.err.message : 'exit 0';
  let head = tally
    ? `STANDUP ${set} on ${q(t.name)} · ${exit} · ${tally}`
    : `STANDUP ${set} on ${q(t.name)} · ${exit} · the script printed no tally -- read what it said below`;
  if (report) head += ' · report ' + report;
  return head + '\n\n' + combined.trim();
}

function suiteStamp(home, suite) {
  let book;
  try {
    book = JSON.parse(fs.readFileSync(path.join(home, 'tests', 'last_run.json'), 'utf8'));
  } catch (e) {
    return e instanceof SyntaxError ? 'no stamp (tests/last_run.json is not readable JSON)' : `no stamp (tests/last_run.json: ${e.message})`;
  }
  const r = book && book[suite];
  if (!r) return 'no stamp for ' + suite;
  if (r.state === 'running') return 'DID NOT FINISH (the stamp still says running)';
  return `${Math.trunc(r.passed || 0)}/${Math.trunc(r.total || 0)} ${r.green === true ? 'green' : 'RED'}`;
}

function suiteTail(out) {
  const lines = out.replace(/\n+$/, '').split('\n');
  const fails = [];
  for (const ln of lines) {
    if (!ln.includes('[FAIL]')) continue;
    fails.push(ln.trimEnd());
    if (fails.length >= 60) {
      fails.push('  ... more failures; read tests/last_run.md');
      break;
    }
  }
  const tail = lines.filter((ln) => !ln.includes('[PASS]') && !ln.includes('[FAIL]')).slice(-6);
  return fails.length ? fails.join('\n') + '\n' + tail.join('\n') : tail.join('\n');
}

async function toolSuiteRun(coreCmd, t, args) {
  const set = str(args, 'set').trim().toLowerCase() || 'both';
  const names = SUITE_SETS[set];
  if (!names) throw new Error(`refused: the suites are strokes, smoke and both; ${q(set)} is none of them`);
  const py = python(coreCmd, 'the suites');
  for (const n of names) needFile(t, 'tests/' + SUITE_SCRIPTS[n], 'the suites');
  if (suiteRunning) throw new Error('refused: a suite is already running on this computer; one at a time, or the browser-count stroke reds for both');
  suiteRunning = true;
  try {
    const deadline = Date.now() + 30 * 60000;
    const heads = [];
    let body = '';
    for (const n of names) {
      const left = deadline - Date.now();
      if (left <= 0) {
        heads.push(n + ': not run, the bound was spent');
        break;
      }
      const res = await spawn(py, [path.join(t.home, 'tests', SUITE_SCRIPTS[n])], { dir: t.home, timeout: left });
      if (res.timedOut) throw res.err;
      heads.push(`${n}: ${suiteStamp(t.home, n)} · ${res.err ? res.err.message : 'exit 0'}`);
      body += `\n--- ${n} (tests/${SUITE_SCRIPTS[n]}) ---\n${suiteTail(res.combined.replace(/\r\n/g, '\n'))}\n`;
    }
    return `SUITES ${set} on ${q(t.name)} · ${heads.join(' · ')}\n${body}`;
  } finally {
    suiteRunning = false;
  }
}

/** ask_steward wakes the tenant's own --engine command; the door line names none, so it says so. */
async function toolAskSteward(t, args) {
  const question = str(args, 'question').trim();
  if (!question) throw new Error('ask_steward needs a question — he cannot weigh the empty string');
  if (!t.engine) throw new Error(`ask_steward has no engine wired for project ${q(t.name)}: nothing to wake. The operator wires one with --engine.`);
  const fields = splitCommand(t.engine);
  if (!fields.length) throw new Error(`ask_steward engine command is empty for ${q(t.name)}`);
  const res = await spawn(fields[0], [...fields.slice(1), question], { dir: t.home, timeout: 120000 });
  if (res.timedOut) throw new Error('REFUSED — the weighing did not finish inside 120 seconds; the engine may be cold. Nothing is claimed.');
  if (res.err) {
    const tail = res.stderr.replace(/[\r\n]+$/, '').split('\n');
    throw new Error(`REFUSED — the engine did not answer (${res.err.message}): ${tail[tail.length - 1] || ''}`);
  }
  const out = res.stdout.trim();
  if (!out) throw new Error('REFUSED — the engine said nothing');
  return out;
}

// ---- the tools -------------------------------------------------------------------------------

const coreOf = (args) => {
  const reg = regOf(args);
  return (reg && reg.coreCmd) || '';
};

async function toolEnvOpen(t, args) {
  const e = await engines.openOne(t.name, t.home, coreOf(args));
  const o = e.opened || {};
  return (
    `OPENED ${t.name} · sitting ${evStr(o, 'sitting')} · session ${evStr(o, 'session')}\n  ${evStr(o, 'git')}\n` +
    `  rack ${o.rack_ok === true ? 'reachable' : 'UNREACHABLE'} · pipeline ${evStr(o, 'pipeline')}\n  seats: ${truncateRunes(evStr(o, 'seats'), 300)}`
  );
}

async function toolEnvClose(t) {
  const tollPaid = await engines.closeOne(t.home);
  if (!tollPaid) {
    return `CLOSED ${t.name} -- BUT THE ENGINE HAD TO BE KILLED after ${SHUTDOWN_GRACE / 1000}s. The toll may not have been paid and \`ended\` may not have been written; check the world's sessions.jsonl before opening it again.`;
  }
  return `CLOSED ${t.name} -- the sitting is tolled and the engine reaped`;
}

async function toolRunStart(t, args) {
  const objective = str(args, 'objective').trim();
  if (!objective) throw new Error('run_start needs an objective');
  const head = runHead(args);
  const e = engines.get(t.home);
  if (!e) throw new Error(`no engine is open on ${q(t.name)} -- env_open first`);
  return renderRun(t.name, objective, await e.run(objective, str(args, 'feed'), str(args, 'method'), head));
}

async function toolRunAnswer(t, args) {
  const e = engines.get(t.home);
  if (!e) throw new Error(`no engine is open on ${q(t.name)}`);
  return renderRun(t.name, '(answered)', await e.answer(str(args, 'text')));
}

async function toolRunCancel(t) {
  const e = engines.get(t.home);
  if (!e) throw new Error(`no engine is open on ${q(t.name)}`);
  e.cancel();
  return 'CANCELLED -- the turn was interrupted; the sitting stands';
}

const engineTools = [
  {
    name: 'ask_steward',
    writes: true,
    description: 'the weighed ruling with receipts, never raw model output; one-shot under the ask lock',
    args: ['question', 'project?'],
    fn: toolAskSteward,
  },
  { name: 'env_open', writes: true, description: 'open the Manjuel engine inside a world; refuses a world already being sat in', args: ['project?'], fn: toolEnvOpen },
  { name: 'env_close', writes: true, description: "close the world's sitting properly and reap its engine", args: ['project?'], fn: toolEnvClose },
  {
    name: 'run_start',
    writes: true,
    description:
      "run one objective through the council; the delivery with what actually ran. `voice` runs every seat on one model for this turn and `voices` names a model per seat over it (flow_run's two words); the declared targets are put back when the turn ends",
    args: ['objective', 'project?', 'feed?', 'method?', 'voice?', 'voices?'],
    fn: toolRunStart,
  },
  { name: 'run_answer', writes: true, description: 'answer what the run asked; the gate crossing the wire, never a default', args: ['text', 'project?'], fn: toolRunAnswer },
  {
    name: 'standup_run',
    writes: true,
    description:
      "run the estate's live standup in this world -- the morning set (default), the court, or all -- and hand back its tally and report; it opens and tolls a sitting of its own, so it refuses while one is open here",
    args: ['set?', 'project?'],
    fn: (t, args) => toolStandupRun(coreOf(args), t, args),
  },
  {
    name: 'suite_run',
    writes: false,
    description:
      "run the estate's own suites in this world -- the strokes, the smoke, or both (default) -- one after the other with the python the door runs the engine with; the suites stamp their own proof (tests/last_run.json, run_history) and the head reads that stamp back, failures first",
    args: ['set?', 'project?'],
    fn: (t, args) => toolSuiteRun(coreOf(args), t, args),
  },
  {
    name: 'release_step',
    writes: true,
    description:
      "one of the release's own steps, run by the core's tests/cut.py in this world: bump the pins, atlas's version files and both changelogs to a mark; rebuild the toll index; check the release gate; wait for GitHub's runs and check again; or record where a cut's marks sit",
    args: ['step', 'mark?', 'project?'],
    fn: (t, args) => toolReleaseStep(coreOf(args), t, args),
  },
  { name: 'run_cancel', writes: false, description: 'interrupt the turn in flight; the sitting stays open', args: ['project?'], fn: toolRunCancel },
];

module.exports = { engineTools, engines, Engines, Engine, openEngine, renderRun, runHead, splitCommand, sittingOpen, sittingOrphaned, suiteStamp, suiteTail, releaseMark };
