/**
 * Workflow automations: a schedule run as a fixed list of steps at its time, not as a chat turn, so Steward stays
 * the operator's agent for his own use during the day (the operator, 2026-11-05: "we can build workflows for the
 * evals, and then keep him as the general purpose agent for personal use during the day").
 *
 * A workflow is DATA on the schedule (schedules.cjs), the shape Steward's own automation_save will write later:
 *
 *   { name, when, prompt, deliver: ['note', 'telegram'],
 *     steps: ['pull_ff', 'repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left'],   // from STEPS only
 *     summarize: 'Write the daily what-happened from this ...' }                             // optional
 *
 * A step is a name, or { step: name, ...its arguments } (eval_start { sets, runs }, eval_wait { hours }). Every step
 * is read-only but two bounded acts: pull_ff (a fast-forward of main, only on main with a clean work tree, and for the
 * ground only while no Manjuel sitting is open: RULE 9; anything else is listed "not pulled: <why>") and eval_start
 * (estate.cjs: eval sets only, refused while an eval runs). No step raises a card. With `summarize`, one Steward turn
 * in a fresh conversation, tagged "[from an automation (<name>)]", writes the result from what the steps gathered;
 * without it the gathered text is the result. The note is filed as today's runs are, and Telegram gets one short line.
 *
 * eval_wait does not hold the scheduler: the run is parked on the schedule (`pending`), and each tick reads
 * eval_status until "BAR DONE" (8 hours at most, or `hours`), then runs the steps after it and files the result.
 * A workflow that starts an eval is skipped while any conversation is mid-turn ("skipped: Steward busy").
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const estate = require('../estate.cjs');

const STEPS = ['repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left', 'pull_ff', 'eval_start', 'eval_wait'];
const EVAL_MAX_HOURS = 8;
const DAY_MS = 24 * 3600 * 1000;
const MAX_SECTION = 4000;
const PLAN_FILE = 'WHATS_LEFT.md';
const PLAN_SECTION = "Today's working path";

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const first = (text) => String(text || '').split('\n').filter(Boolean)[0] || '';

/** A step as { step, ...args }. */
function stepOf(x) {
  return typeof x === 'string' ? { step: x } : { ...(x || {}) };
}

/** The steps checked against STEPS (the only steps there are); throws naming the bad one. Returns them normalised. */
function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('a workflow needs one or more steps');
  return steps.map((x) => {
    const s = stepOf(x);
    if (!STEPS.includes(s.step)) throw new Error(`no workflow step "${s.step}" (the steps are: ${STEPS.join(', ')})`);
    if (s.step === 'eval_start') {
      if (!Array.isArray(s.sets) || !s.sets.length) throw new Error('eval_start needs sets');
      const runs = s.runs === undefined ? 1 : Number(s.runs);
      if (!Number.isInteger(runs) || runs < 1 || runs > estate.MAX_RUNS) throw new Error(`eval_start runs is 1 to ${estate.MAX_RUNS}`);
      return { step: 'eval_start', sets: s.sets.map(String), runs };
    }
    if (s.step === 'eval_wait') {
      const hours = s.hours === undefined ? EVAL_MAX_HOURS : Number(s.hours);
      if (!(hours > 0 && hours <= EVAL_MAX_HOURS)) throw new Error(`eval_wait hours is at most ${EVAL_MAX_HOURS}`);
      return { step: 'eval_wait', hours };
    }
    return typeof x === 'string' ? x : { step: s.step };
  });
}

/** Whether a schedule is a workflow (has steps). */
function isWorkflow(s) {
  return Boolean(s && Array.isArray(s.steps) && s.steps.length);
}

// ---- what the steps run on ---------------------------------------------------------------------------------------

/** One command, never through a shell, bounded: { code, out, err }. git never prompts. */
function run(cmd, args, cwd, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

/** The Estate's repositories from the ground (Desktop\Research); `releases` marks the two whose releases are read. */
function estateRepos(ground) {
  if (!ground) return [];
  return [
    { name: 'research', dir: ground, ground: true },
    { name: 'steward', dir: path.join(ground, 'worlds', 'steward') },
    { name: 'jesster', dir: path.join(ground, 'worlds', 'jesster'), releases: true },
    { name: 'atlas', dir: path.join(ground, 'atlas'), releases: true },
    { name: 'neiro', dir: path.join(ground, 'worlds', 'neiro') },
  ];
}

const isRepo = (r) => fs.existsSync(path.join(r.dir, '.git'));

/** A fast-forward pull of main, only on main with a clean work tree (and no open sitting on the ground); else why not. */
async function pullMain(repo, { run: exec, sitting }) {
  if (repo.ground) {
    const n = sitting ? sitting() : '';
    if (n) return `not pulled: Manjuel sitting ${n} is open (RULE 9)`;
  }
  const branch = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo.dir);
  if (branch.code !== 0) return `not pulled: ${first(branch.err) || 'not a git repository'}`;
  if (branch.out !== 'main') return `not pulled: on branch ${branch.out}, not main`;
  // tracked changes against HEAD, staged or not; read-only (the index is not written)
  const dirty = await exec('git', ['diff-index', '--quiet', 'HEAD', '--'], repo.dir);
  if (dirty.code !== 0) return 'not pulled: the work tree has uncommitted changes';
  const pull = await exec('git', ['pull', '--ff-only', 'origin', 'main'], repo.dir, 120000);
  if (pull.code !== 0) return `not pulled: ${String(pull.err).split('\n').filter(Boolean).pop() || 'git pull failed'}`;
  return /Already up to date/i.test(pull.out) ? 'current (nothing to pull)' : 'pulled (fast-forward)';
}

/** The plan's working path: the PLAN_SECTION of the ground's WHATS_LEFT.md, at most MAX_SECTION characters. */
function readPlan(ground) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(ground, PLAN_FILE), 'utf8');
  } catch {
    return `(${PLAN_FILE} was not found)`;
  }
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s/.test(l) && l.includes(PLAN_SECTION));
  if (at < 0) return `(${PLAN_FILE} has no "${PLAN_SECTION}" section)`;
  const end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  const section = lines.slice(at, end < 0 ? undefined : end).join('\n').trim();
  return section.length > MAX_SECTION ? `${section.slice(0, MAX_SECTION)}\n...` : section;
}

const RESULT_LINE = (l) => / done |BAR DONE|\bbar\b/.test(l) && !/ bar \S+ : sets /.test(l);

/** The newest eval runs' result lines (storage/evals/runs/<tag>/progress.txt in Steward's folder). */
function evalBars(stewardDir, since) {
  const dir = stewardDir && path.join(stewardDir, 'storage', 'evals', 'runs');
  let runs = [];
  try {
    runs = fs
      .readdirSync(dir)
      .map((d) => ({ d, f: path.join(dir, d, 'progress.txt') }))
      .filter((r) => fs.existsSync(r.f))
      .map((r) => ({ ...r, t: fs.statSync(r.f).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return '(no eval runs found)';
  }
  const recent = runs.filter((r) => r.t >= since).slice(0, 3);
  const pick = recent.length ? recent : runs.slice(0, 1);
  if (!pick.length) return '(no eval runs found)';
  return pick
    .flatMap((r) => [`${r.d}${r.t < since ? ' (older than this window)' : ''}:`, ...fs.readFileSync(r.f, 'utf8').split(/\r?\n/).filter(RESULT_LINE).slice(-8).map((l) => `  ${l}`)])
    .join('\n');
}

// ---- the steps -------------------------------------------------------------------------------------------------

/**
 * Each step: (args, ctx) → its section's text. ctx: { repos, run, sitting, ground, stewardDir, evals, since, now,
 * state } (state carries eval_start's tag to eval_wait).
 */
const RUNNERS = {
  async pull_ff(args, ctx) {
    const lines = [];
    for (const r of ctx.repos) lines.push(`- ${r.name}: ${isRepo(r) ? await pullMain(r, ctx) : 'not found'}`);
    return `## The repositories brought current (main, fast-forward only)\n${lines.join('\n')}`;
  },
  async repo_log(args, ctx) {
    const out = ['## Commits on main'];
    for (const r of ctx.repos) {
      if (!isRepo(r)) continue;
      const log = await ctx.run('git', ['log', 'main', '--first-parent', `--since=${new Date(ctx.since).toISOString()}`, '--format=%h %ad %s', '--date=short', '-n', '40'], r.dir);
      out.push(`${r.name}:`, ...(log.code !== 0 ? [`  (git log failed: ${first(log.err)})`] : log.out ? log.out.split('\n').map((l) => `  ${l}`) : ['  none']));
    }
    return out.join('\n');
  },
  async merged_prs(args, ctx) {
    const out = ['## Merged pull requests'];
    for (const r of ctx.repos) {
      if (!isRepo(r)) continue;
      const prs = await ctx.run('gh', ['pr', 'list', '--state', 'merged', '--search', `merged:>=${dayOf(ctx.since)}`, '--json', 'number,title,mergedAt', '--limit', '40'], r.dir);
      let list = [];
      try {
        list = prs.code === 0 ? JSON.parse(prs.out || '[]') : [];
      } catch {
        /* none */
      }
      out.push(`${r.name}: ${prs.code !== 0 ? `(gh failed: ${first(prs.err)})` : list.length ? '' : 'none'}`, ...list.map((p) => `  #${p.number} ${p.title} (${p.mergedAt})`));
    }
    return out.join('\n');
  },
  async releases(args, ctx) {
    const out = ['## Releases'];
    for (const r of ctx.repos.filter((x) => x.releases && isRepo(x))) {
      const rel = await ctx.run('gh', ['release', 'list', '--limit', '10', '--json', 'tagName,publishedAt'], r.dir);
      let list = [];
      try {
        list = rel.code === 0 ? JSON.parse(rel.out || '[]').filter((x) => Date.parse(x.publishedAt) >= ctx.since) : [];
      } catch {
        /* none */
      }
      out.push(`${r.name}: ${rel.code !== 0 ? `(gh failed: ${first(rel.err)})` : list.length ? list.map((x) => `${x.tagName} (${x.publishedAt})`).join(', ') : 'none'}`);
    }
    return out.join('\n');
  },
  async eval_bars(args, ctx) {
    return `## Steward's eval bars\n${evalBars(ctx.stewardDir, ctx.since)}`;
  },
  async plan_left(args, ctx) {
    return `## What is left (${PLAN_FILE})\n${ctx.ground ? readPlan(ctx.ground) : '(the ground was not found)'}`;
  },
  async eval_start(args, ctx) {
    if (!ctx.evals) throw new Error("Steward's evals are not served here");
    const d = new Date(ctx.now);
    const tag = `${args.sets.join('_')}-${dayOf(ctx.now)}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const out = await estate.evalStart({ sets: args.sets, runs: args.runs || 1, tag }, ctx.evals);
    if (typeof out !== 'string') throw new Error(out.error);
    ctx.state.tag = JSON.parse(out).tag;
    return `## Eval run started\n${ctx.state.tag}: ${args.sets.join(', ')}, ${args.runs || 1} run(s) each`;
  },
};

/** eval_wait read once: null while the run goes on; its section when it said BAR DONE or its hours are up. */
function readEval(pending, { evals, now }) {
  const out = estate.evalStatus({ tag: pending.tag }, evals);
  const st = typeof out === 'string' ? JSON.parse(out) : { done: false, lines: [], error: out.error };
  if (!st.done && now <= pending.until) return null;
  const lines = st.lines && st.lines.length ? st.lines : [st.error || 'no progress lines'];
  const head = st.done ? `${pending.tag} ended (BAR DONE).` : `${pending.tag} did not say BAR DONE within ${pending.hours} h.`;
  const short = st.done ? ((st.lines || []).filter((l) => / done /.test(l)).pop() || 'BAR DONE').replace(/^\S+\s+/, '') : `no BAR DONE after ${pending.hours} h`;
  return { ok: Boolean(st.done), section: `## Eval run\n${head}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``, short };
}

/**
 * Run a workflow's steps from `from`. Resolves { parked: { at, tag, until, hours, sections } } at an eval_wait, or
 * { done: { ok, answer, short } } once every step and the summary have run. `sections` carries what came before.
 */
async function runSteps(s, deps, { from = 0, sections = [], state = {}, ok = true, short = '' } = {}) {
  const steps = validateSteps(s.steps);
  const ctx = { ...deps, run: deps.run || run, state, since: deps.since, now: deps.now };
  for (let i = from; i < steps.length; i++) {
    const step = stepOf(steps[i]);
    if (step.step === 'eval_wait') {
      if (!state.tag) {
        sections.push('## Eval run\n(nothing to wait for: no eval_start before eval_wait)');
        continue;
      }
      return { parked: { at: i + 1, tag: state.tag, hours: step.hours, until: ctx.now + step.hours * 3600000, since: ctx.since, sections } };
    }
    try {
      sections.push(await RUNNERS[step.step](step, ctx));
    } catch (e) {
      ok = false;
      sections.push(`## ${step.step}\nFailed: ${e.message}`);
      if (step.step === 'eval_start') return { done: { ok: false, answer: sections.join('\n\n'), short: `Failed: ${e.message}` } };
    }
  }
  const gathered = sections.join('\n\n');
  if (!s.summarize) return { done: { ok, answer: gathered, short: short || first(gathered.replace(/^## .*\n/, '')) } };
  const text =
    `${s.summarize}\n\n` +
    (s.prompt ? `(The automation's own words: ${s.prompt})\n\n` : '') +
    'What the steps gathered is below; nothing more needs running.\n\n' +
    gathered;
  const r = await deps.agent.ask({ text, source: 'automation', automation: s.name, onCard: deps.onCard, save: false });
  return {
    done: {
      ok: ok && !r.error,
      answer: `${r.answer}\n\n---\n\n<details><summary>What the steps gathered</summary>\n\n${gathered}\n\n</details>`,
      short: first(r.answer),
    },
  };
}

/** A workflow's run at its time: skipped while a conversation is mid-turn if it starts an eval. */
async function startWorkflow(s, deps) {
  const startsEval = validateSteps(s.steps).some((x) => stepOf(x).step === 'eval_start');
  if (startsEval && deps.busy && deps.busy()) return { skipped: 'skipped: Steward busy' };
  const now = deps.now ?? Date.now();
  return runSteps(s, { ...deps, now, since: s.lastRun || now - DAY_MS });
}

/** A parked run read once on a tick: null while its eval runs; else the rest of its steps, run to the end. */
async function resumeWorkflow(s, deps) {
  const p = s.pending;
  const now = deps.now ?? Date.now();
  const read = readEval(p, { evals: deps.evals, now });
  if (!read) return null;
  return runSteps(s, { ...deps, now, since: p.since }, { from: p.at, sections: [...p.sections, read.section], ok: read.ok, short: read.short });
}

module.exports = { STEPS, EVAL_MAX_HOURS, validateSteps, isWorkflow, stepOf, run, estateRepos, pullMain, readPlan, evalBars, readEval, runSteps, startWorkflow, resumeWorkflow };
