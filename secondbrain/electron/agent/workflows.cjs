/**
 * Workflow automations: a schedule whose recipe Steward runs as a MAF workflow (the operator, 2026-11-05: "we can build
 * workflows for the evals, and then keep him as the general purpose agent for personal use during the day"). MAF ships
 * workflows and has no scheduler, so the split is: SecondBrain keeps the clock (schedules.cjs), checks the recipe and
 * hands it to Steward's MCP host (mcp_app.py on 127.0.0.1:43121, run_recipe), then reads recipe_status on each tick
 * until the run ends; Steward builds and runs it (worlds\steward recipe_workflow.py: one executor per step, then
 * summarize, then deliver, checkpointed), in a session of its own, never his chat thread.
 *
 * A recipe is DATA on the schedule, the shape Steward's later automation_save will write (his `automations` skill):
 *
 *   { name, when, prompt, deliver: ['note', 'telegram'],
 *     steps: ['pull_ff', 'versions', 'repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left'],   // STEPS only
 *     summarize: 'Write the daily what-happened from this ...' }                                         // optional
 *
 * A step is a name, or { step, ...its arguments } (eval_start { sets, runs, transport }: with no
 * transport, SecondBrain's eval_start picks it: AG-UI for asks sets only, in-process for the rest),
 * eval_wait { hours }). A recipe that starts an eval is skipped while any conversation is mid-turn ("skipped: Steward
 * busy"): his personal use comes first.
 */
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const estate = require('../estate.cjs');
const mcpv = require('../mcpversion.cjs');

const STEPS = ['repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left', 'versions', 'pull_ff', 'eval_start', 'eval_wait'];
const EVAL_MAX_HOURS = 8;
const DAY_MS = 24 * 3600 * 1000;
// a run that has not ended this long after it started is filed as such (the longest eval_wait, and an hour more)
const RUN_MAX_MS = (EVAL_MAX_HOURS + 1) * 3600 * 1000;
const STEWARD_MCP = 'http://127.0.0.1:43121/mcp';
const CLIENT_INFO = { name: 'secondbrain-workflows', version: '1' };

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
      // no transport named: none is sent, and eval_start picks AG-UI for asks sets only (the operator, 2026-11-05: "use
      // it"), in-process for any other set, which evals.py refuses on a host (2026-11-05: bfcl over ag-ui exited 2)
      if (s.transport === undefined) return { step: 'eval_start', sets: s.sets.map(String), runs };
      const transport = String(s.transport);
      if (!estate.TRANSPORTS.includes(transport)) throw new Error(`eval_start transport is one of ${estate.TRANSPORTS.join(', ')}`);
      return { step: 'eval_start', sets: s.sets.map(String), runs, transport };
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

/** The recipe Steward is handed: the schedule's own data. */
function recipeOf(s) {
  return { name: s.name, prompt: s.prompt || '', steps: validateSteps(s.steps), ...(s.summarize ? { summarize: s.summarize } : {}), deliver: s.deliver || ['note'] };
}

// ---- Steward's MCP host ------------------------------------------------------------------------------------------

/** One JSON-RPC POST to `url` with `extra` headers, at most `timeout` ms: the parsed reply, or an Error. */
function postJson(url, body, extra = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...extra,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`Steward's MCP host answered ${res.statusCode}: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error("Steward's MCP host did not answer in time")));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Steward's recipe tools over his MCP host, at MCP 2026-07-28 (no initialize, no session; the MCP SDK serves it):
 * runRecipe(recipe, since) → { run_id }, recipeStatus(run_id) → { state, ok, text, short, error }. Every request
 * carries the protocol version, client info and capabilities in params._meta (basic/versioning) and the
 * MCP-Protocol-Version, Mcp-Method and Mcp-Name headers that mirror them (transports/streamable-http "Request
 * Metadata"), as mcpversion.cjs builds them. `post(url, body, headers)` is the transport (tests give one).
 */
function stewardRecipes({ url = STEWARD_MCP, post = postJson } = {}) {
  let n = 0;
  const call = async (name, args, timeout) => {
    const msg = { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args, _meta: mcpv.requestMeta(CLIENT_INFO) } };
    const reply = await (timeout ? post(url, msg, mcpv.requestHeaders(msg), timeout) : post(url, msg, mcpv.requestHeaders(msg)));
    if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
    const text = ((reply.result && reply.result.content) || []).find((c) => c.type === 'text')?.text || '';
    if (reply.result && reply.result.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
  return {
    // `extra`: { flow, trigger }, kept by Steward for the flow's run history (recipe_runs)
    runRecipe: (recipe, since, extra) => call('run_recipe', { recipe, since, ...(extra || {}) }),
    recipeStatus: (runId) => call('recipe_status', { run_id: runId }, READ_MS),
    // the Flows shelf (ADR-0008): the recipe built as its MAF workflow (to_dict), and one flow's runs; both read only
    recipeGraph: (recipe) => call('recipe_graph', { recipe }, READ_MS),
    recipeRuns: (flow, limit = 10) => call('recipe_runs', { flow, limit }, READ_MS),
  };
}

// the shelf's reads wait at most this long: a host that is down is told quickly, and the canvas is drawn locally
const READ_MS = 5000;

// ---- the scheduler's side ------------------------------------------------------------------------------------------

/**
 * A workflow's run at its time: skipped while a conversation is mid-turn if it starts an eval; else run_recipe, and
 * the run parked on the schedule (`pending`) for the ticks to read. deps: { steward (stewardRecipes), busy, now,
 * trigger ('now' from Run now; 'schedule' otherwise) }. The flow's id and the trigger go with it, for the run history.
 */
async function startWorkflow(s, deps) {
  const recipe = recipeOf(s);
  if (recipe.steps.some((x) => stepOf(x).step === 'eval_start') && deps.busy && deps.busy()) return { skipped: 'skipped: Steward busy' };
  const now = deps.now ?? Date.now();
  const since = (s.lastRun || now - DAY_MS) / 1000;
  const r = await deps.steward.runRecipe(recipe, since, { flow: s.id, trigger: deps.trigger === 'now' ? 'now' : 'schedule' });
  return { parked: { run_id: r.run_id, label: `Steward's run ${r.run_id}`, started: now, until: now + RUN_MAX_MS } };
}

/** A parked run read once on a tick: null while it runs; else its result, { done: { ok, answer, short } }. */
async function resumeWorkflow(s, deps) {
  const p = s.pending;
  const now = deps.now ?? Date.now();
  const st = await deps.steward.recipeStatus(p.run_id);
  if (st.state === 'running') {
    if (now <= p.until) return null;
    return { done: { ok: false, answer: `Steward's run ${p.run_id} had not ended ${Math.round(RUN_MAX_MS / 3600000)} hours after it started.`, short: 'no result in time' } };
  }
  if (st.state === 'done') return { done: { ok: Boolean(st.ok), answer: st.text || '', short: st.short || '' } };
  return { done: { ok: false, answer: `Failed: ${st.error || st.state}`, short: `Failed: ${st.error || st.state}` } };
}

// ---- also used by estate_status's versions (main.cjs) --------------------------------------------------------------

/** One command, never through a shell, bounded: { code, out, err }. git never prompts. */
function run(cmd, args, cwd, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

/**
 * The Estate's repositories from the ground (Desktop\Research); `releases` marks the two whose releases are read.
 * Neiro is not one since 2026-11-05: retired as a gate and archived read-only, each part's own CI is its gate.
 */
function estateRepos(ground) {
  if (!ground) return [];
  return [
    { name: 'research', dir: ground, ground: true },
    { name: 'steward', dir: path.join(ground, 'worlds', 'steward') },
    { name: 'jesster', dir: path.join(ground, 'worlds', 'jesster'), releases: true },
    { name: 'atlas', dir: path.join(ground, 'atlas'), releases: true },
  ];
}

module.exports = { STEPS, EVAL_MAX_HOURS, RUN_MAX_MS, STEWARD_MCP, validateSteps, isWorkflow, stepOf, recipeOf, stewardRecipes, postJson, startWorkflow, resumeWorkflow, run, estateRepos };
