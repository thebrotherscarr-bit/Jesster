const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('../vaultfs.cjs');
const { Schedules, parseWhen, nextRun, runSchedule, describeWhen } = require('./schedules.cjs');

const at = (s) => new Date(s).getTime(); // local time

test('when: the accepted forms, and a clear error otherwise', () => {
  assert.deepEqual(parseWhen('Daily 8:30'), { type: 'daily', time: '08:30' });
  assert.deepEqual(parseWhen('weekdays 17:00'), { type: 'weekdays', time: '17:00' });
  assert.deepEqual(parseWhen('weekly Monday 09:00'), { type: 'weekly', day: 'mon', time: '09:00' });
  assert.deepEqual(parseWhen('every 3h'), { type: 'every', minutes: 180 });
  assert.deepEqual(parseWhen('every 30 minutes'), { type: 'every', minutes: 30 });
  assert.equal(parseWhen('once 2026-10-23 09:00').type, 'once');
  assert.throws(() => parseWhen('every 2m'), /at least 5 minutes/);
  assert.throws(() => parseWhen('daily 25:00'), /bad time/);
  assert.throws(() => parseWhen('sometimes'), /must look like/);
  assert.equal(describeWhen(parseWhen('every 2h')), 'every 2 h');
});

test('next run times', () => {
  const wed0800 = at('2026-10-21T08:00:00'); // a Wednesday
  assert.equal(nextRun(parseWhen('daily 08:30'), wed0800), at('2026-10-21T08:30:00'));
  assert.equal(nextRun(parseWhen('daily 07:30'), wed0800), at('2026-10-22T07:30:00'));
  const fri1800 = at('2026-10-23T18:00:00');
  assert.equal(nextRun(parseWhen('weekdays 08:30'), fri1800), at('2026-10-26T08:30:00'), 'skips the weekend');
  assert.equal(nextRun(parseWhen('weekly mon 09:00'), wed0800), at('2026-10-26T09:00:00'));
  assert.equal(nextRun(parseWhen('every 3h'), wed0800), wed0800 + 3 * 3600000);
  assert.equal(nextRun(parseWhen('once 2026-10-21 07:00'), wed0800), null, 'a past one-off never runs');
});

test('a run files a note, refuses risky tools, reschedules; missed runs catch up; one-offs end', async () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')));
  const schedules = new Schedules(() => vault);
  const t0 = at('2026-10-21T08:00:00');
  const s = schedules.add({ name: 'Morning digest', prompt: 'summarize my todo', when: 'daily 08:30', deliver: ['note', 'telegram'] }, t0);
  assert.equal(schedules.due(t0).length, 0);
  // the app was closed at 08:30; it opens at 10:00 the same day: one catch-up run
  const t1 = at('2026-10-21T10:00:00');
  assert.deepEqual(schedules.due(t1).map((x) => x.id), [s.id]);
  let approved = null;
  let sent = null;
  const agent = {
    ask: async ({ text, source, approve, save }) => {
      approved = await approve('terminal_run', {}, 'rm -rf');
      assert.equal(source, 'schedule');
      assert.equal(save, false);
      return { answer: `digest for: ${text}` };
    },
  };
  const r = await runSchedule(schedules.due(t1)[0], { schedules, agent, vault, now: t1, deliverers: { telegram: async (m) => (sent = m) } });
  assert.equal(approved, false, 'risky tools are refused unattended');
  assert.match(sent, /Morning digest\n\ndigest for: summarize my todo/);
  const note = vault.load().find((n) => n.id === r.id);
  assert.ok(note.tags.includes('automation'));
  assert.match(note.content, /digest for: summarize my todo/);
  const after = schedules.all()[0];
  assert.equal(after.lastResult, 'ok');
  assert.equal(after.next, at('2026-10-22T08:30:00'));
  assert.equal(schedules.due(t1).length, 0, 'no second run the same day');

  const once = schedules.add({ name: 'Reminder', prompt: 'x', when: 'once 2026-10-21 11:00' }, t1);
  await runSchedule(once, { schedules, agent, vault, now: at('2026-10-21T11:00:00') });
  assert.equal(schedules.all().find((x) => x.id === once.id).enabled, false);

  schedules.update('morning digest', { enabled: false });
  assert.equal(schedules.due(at('2026-10-30T09:00:00')).length, 0, 'paused schedules do not run');
  schedules.remove(s.id);
  assert.equal(schedules.all().length, 1);
});

test('a Steward schedule sends its prompt to Steward as an automation turn; its cards wait on the user, then time out No', async () => {
  const { AgentService } = require('./service.cjs');
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-steward-')));
  const schedules = new Schedules(() => vault);
  const t0 = at('2026-11-05T22:00:00');
  const s = schedules.add({ name: 'Overnight evals', prompt: 'Start the overnight evals: eval_start sets ["aider-py"] runs 1.', when: 'daily 23:00', backend: 'steward' }, t0);
  assert.equal(s.backend, 'steward');
  assert.equal(schedules.add({ name: 'x', prompt: 'y', when: 'daily 08:00', backend: 'nope' }, t0).backend, 'local', 'only local or steward');

  const sent = [];
  const answers = [];
  const steward = {
    ensure: async () => 'http://steward',
    turn: async ({ text, approve }) => {
      sent.push(text);
      answers.push(await approve('secondbrain_service_control', { service: 'steward', action: 'restart' }, 'restart steward'));
      return { answer: 'Started aider-py-2026-11-05.', previous: 'r1', calls: [] };
    },
  };
  const cards = [];
  const history = [];
  // the tab's own backend is the local loop: a Steward schedule goes to Steward all the same
  const agent = new AgentService({ getVault: () => vault, getModel: () => ({ backend: 'local' }), steward, history: { append: (e) => history.push(e) }, emit: (ch, e) => ch === 'agent:approval' && cards.push(e) });
  const phone = [];
  // a short timeout stands in for the 10 minutes; runSchedule's own call takes CARD_TIMEOUT_MS
  const realAsk = agent.ask.bind(agent);
  const asked = [];
  agent.ask = (req) => (asked.push(req), realAsk({ ...req, cardTimeoutMs: 30 }));
  const t1 = at('2026-11-05T23:00:30');
  // the card's timer is unref'd (it never holds SecondBrain open), so the test holds the event loop while it waits
  const hold = setInterval(() => {}, 1000);
  const r = await runSchedule(schedules.due(t1)[0], { schedules, agent, vault, now: t1, onCard: (c) => phone.push(c) }).finally(() => clearInterval(hold));

  assert.equal(asked[0].source, 'automation');
  assert.equal(asked[0].automation, 'Overnight evals');
  assert.equal(asked[0].approve, undefined, 'an automation is never handed an approver of its own');
  assert.match(sent[0], /^\[from an automation \(Overnight evals\) \| [^\]]+ local \(UTC[+-]\d\d:\d\d\) \| [^\]]*\d\d:\d\d UTC\]\nStart the overnight evals/);
  assert.equal(cards.length, 1, 'the card is the window\'s (and so the Approvals shelf\'s)');
  assert.match(cards[0].summary, /^\[from an automation \(Overnight evals\)\]\nrestart steward/);
  assert.deepEqual(phone.map((c) => c.id), [cards[0].id], 'and Telegram\'s');
  assert.deepEqual(answers, [false], 'unanswered: No');
  assert.equal(history[0].answer, 'timeout');
  assert.equal(history[0].source, 'from an automation (Overnight evals)');
  assert.deepEqual(agent.cards(), [], 'no card left waiting');
  assert.equal(r.ok, true);
  const note = vault.load().find((n) => n.id === r.id);
  assert.match(note.content, /daily at 23:00, Steward/);
  assert.match(note.content, /Started aider-py-2026-11-05/);
  assert.equal(schedules.all().find((x) => x.id === s.id).lastResult, 'ok');

  // with no Steward set up, the run fails and says why; it never falls back to the local loop
  const none = new AgentService({ getVault: () => vault, getModel: () => ({ backend: 'local' }) });
  const failed = await runSchedule(schedules.all().find((x) => x.id === s.id), { schedules, agent: none, vault, now: at('2026-11-06T23:00:00') });
  assert.equal(failed.ok, false);
  assert.match(failed.answer, /Steward is not set up/);
});

test('an automation card answered in time is the answer, and the timer ends with it', async () => {
  const { AgentService, CARD_TIMEOUT_MS } = require('./service.cjs');
  assert.equal(CARD_TIMEOUT_MS, 600000, '10 minutes, as Telegram\'s');
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-steward-')));
  let approved = null;
  const steward = { ensure: async () => 'http://s', turn: async ({ approve }) => ((approved = await approve('x', {}, 'do x')), { answer: 'ok', previous: 'r', calls: [] }) };
  const agent = new AgentService({ getVault: () => vault, getModel: () => ({}), steward, emit: (ch, e) => ch === 'agent:approval' && setImmediate(() => agent.answerApproval(e.id, true, false)) });
  await agent.ask({ text: 'go', source: 'automation', automation: 'A', save: false, cardTimeoutMs: 20 });
  assert.equal(approved, true);
});

test("main.cjs hands the scheduler Telegram's cards and the Estate Steward's evals", () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.equal(main.match(/sched\.runSchedule\(s, scheduleDeps\(\)\)/g).length, 1, 'the tick');
  // Run now (2026-11-08): the shelf's schedules:run and the Estate's saved_flow_run are one function, sched.runNow
  assert.match(main, /async function runFlowNow\(id\) \{\s+const r = await sched\.runNow\(id, scheduleDeps\(\)\);/);
  assert.match(main, /ipcMain\.handle\('schedules:run', async \(event, id\) => \{\s+guard\(event\);\s+return runFlowNow\(id\);/);
  // saved_flow_status (ADR-0017) reads Steward's runs through the shelf's own client, as schedules:runStatus does
  assert.match(main, /flows: \{ list: \(\) => schedulesView\(\), run: \(id\) => runFlowNow\(id\), status: \(runId\) => stewardRecipes\.recipeStatus\(runId\), runs: \(id, limit\) => stewardRecipes\.recipeRuns\(id, limit\) \},/);
  assert.match(main, /getSchedules\(\)\.clearStale\(\);/, 'a running left by a quit is cleared at start');
  assert.match(main, /flowExamples\.dropStaleTransports\(\{ schedules: getSchedules\(\), vaultDir: vdir, sets \}\)/);
  assert.match(main, /onCard: phoneCard,/);
  assert.match(main, /busy: \(\) => getAgent\(\)\.busy\(\),/);
  assert.match(main, /await sched\.resumeSchedules\(scheduleDeps\(\)\)/);
  assert.match(main, /const stewardEvals = \(\) => estate\.evalsApi\(\{ stewardDir: stewardDirNow \}\)/);
  assert.match(main, /evals: stewardEvals\(\),/);
  // Steward's MCP host on its port; SECONDBRAIN_STEWARD_MCP_URL only for the Playwright suite's fake host (e2e/)
  assert.match(main, /const stewardRecipes = workflows\.stewardRecipes\(\{ url: process\.env\.SECONDBRAIN_STEWARD_MCP_URL \|\| `http:\/\/127\.0\.0\.1:\$\{steward\.MCP_PORT\}\/mcp` \}\)/);
  assert.match(main, /schedulerTimer = setInterval\(schedulerTick, SCHEDULER_MS\);/);
  assert.match(main, /const SCHEDULER_MS = Number\(process\.env\.SECONDBRAIN_SCHEDULER_MS\) \|\| 30000;/, 'the tick is 30 s unless the suite sets it');
  assert.ok(main.includes('    steward: stewardRecipes,'), 'the scheduler hands workflows to Steward')
  // the Flows shelf's Set up and Run now (2026-11-05): a change goes through edit, busy is the agent's
  assert.match(main, /ipcMain\.handle\('schedules:edit', \(event, id, spec\) => \{\s+guard\(event\);\s+getSchedules\(\)\.edit\(id, spec \|\| \{\}\);/);
  assert.match(main, /ipcMain\.handle\('schedules:busy', \(event\) => \{\s+guard\(event\);\s+return getAgent\(\)\.busy\(\);/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8');
  assert.match(preload, /edit: \(id, spec\) => ipcRenderer\.invoke\('schedules:edit', id, spec\)/);
  assert.match(preload, /busy: \(\) => ipcRenderer\.invoke\('schedules:busy'\)/);
  // the Flows shelf, piece 2 (ADR-0008): the graph, the runs and a run's live steps, each from Steward's MCP host
  assert.match(main, /ipcMain\.handle\('schedules:graph', async \(event, id\) => \{[\s\S]*?return stewardRecipes\.recipeGraph\(workflows\.recipeOf\(s\)\);/);
  assert.match(main, /ipcMain\.handle\('schedules:runs', async \(event, id, limit\) => \{[\s\S]*?return stewardRecipes\.recipeRuns\(/);
  assert.match(main, /ipcMain\.handle\('schedules:runStatus', async \(event, runId\) => \{[\s\S]*?return stewardRecipes\.recipeStatus\(/);
  assert.match(preload, /graph: \(id\) => ipcRenderer\.invoke\('schedules:graph', id\)/);
  assert.match(preload, /runs: \(id, limit\) => ipcRenderer\.invoke\('schedules:runs', id, limit\)/);
  assert.match(preload, /runStatus: \(runId\) => ipcRenderer\.invoke\('schedules:runStatus', runId\)/);
});

test('an automation changed from the Flows shelf: each field checked as add checks it, nothing written on a refusal', () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-edit-')));
  const schedules = new Schedules(() => vault);
  const t0 = at('2026-11-05T12:00:00');
  const s = schedules.add({ name: 'Startup', prompt: 'Review the work', when: 'weekdays 06:00', deliver: ['note', 'telegram'] }, t0);
  const before = JSON.stringify(schedules.all());
  assert.throws(() => schedules.edit(s.id, { when: 'sometimes' }), /must look like/);
  assert.throws(() => schedules.edit(s.id, { steps: ['run_shell'] }), /no workflow step "run_shell"/);
  assert.throws(() => schedules.edit(s.id, { name: ' ' }), /needs a name/);
  assert.throws(() => schedules.edit(s.id, { prompt: '' }), /needs a name and a prompt/);
  assert.throws(() => schedules.edit('nope', { name: 'x' }), /no schedule "nope"/);
  assert.equal(JSON.stringify(schedules.all()), before, 'a refused change writes nothing');
  // a new time: parsed, its label and next run with it; the rest untouched
  const t = schedules.edit(s.id, { when: 'daily 07:15' }, t0);
  assert.deepEqual([t.whenText, t.when, t.next], ['daily 07:15', { type: 'daily', time: '07:15' }, at('2026-11-06T07:15:00')]);
  assert.deepEqual([t.name, t.prompt, t.deliver, t.id, t.enabled], ['Startup', 'Review the work', ['note', 'telegram'], s.id, true]);
  // made a recipe, then a prompt again: steps and summarize come and go
  const r = schedules.edit(s.id, { steps: ['repo_log', 'versions'], summarize: 'Write it up', backend: 'steward' });
  assert.deepEqual([r.steps, r.summarize, r.backend], [['repo_log', 'versions'], 'Write it up', 'steward']);
  const p = schedules.edit(s.id, { steps: [], summarize: '', prompt: 'Just say hi', deliver: ['note'] });
  assert.equal('steps' in p || 'summarize' in p, false);
  assert.deepEqual([p.prompt, p.deliver], ['Just say hi', ['note']]);
  assert.equal(schedules.all().length, 1);
});
// ---- workflows (agent/workflows.cjs): a recipe is data; Steward runs it as a MAF workflow --------------------------

const workflows = require('./workflows.cjs');
const { resumeSchedules } = require('./schedules.cjs');

/** Steward's run_recipe and recipe_status as a recorded fake: each run's states are read in order. */
function fakeSteward(states) {
  const seen = { started: [], read: [] };
  return {
    seen,
    steward: {
      runRecipe: async (recipe, since, extra) => (seen.started.push({ recipe, since, extra }), { run_id: `run${seen.started.length}`, state: 'running' }),
      recipeStatus: async (id) => (seen.read.push(id), states.shift() || { state: 'running' }),
    },
  };
}

const STARTUP_STEPS = ['pull_ff', 'versions', 'repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left'];

test('a workflow is data: steps from the fixed list only, each checked when saved', () => {
  assert.deepEqual(workflows.STEPS, ['repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left', 'versions', 'pull_ff', 'eval_start', 'eval_wait']);
  assert.throws(() => workflows.validateSteps(['repo_log', 'run_shell']), /no workflow step "run_shell"/);
  assert.throws(() => workflows.validateSteps([]), /one or more steps/);
  assert.throws(() => workflows.validateSteps([{ step: 'eval_start' }]), /needs sets/);
  assert.throws(() => workflows.validateSteps([{ step: 'eval_start', sets: ['x'], runs: 9 }]), /runs is 1 to 3/);
  assert.throws(() => workflows.validateSteps([{ step: 'eval_wait', hours: 30 }]), /at most 8/);
  assert.deepEqual(workflows.validateSteps([{ step: 'eval_start', sets: ['aider-py'] }, 'eval_wait']), [{ step: 'eval_start', sets: ['aider-py'], runs: 1 }, { step: 'eval_wait', hours: 8 }], 'no transport sent: eval_start picks it by set (bfcl, aider-py in-process)');
  assert.deepEqual(workflows.validateSteps([{ step: 'eval_start', sets: ['small'], transport: 'ag-ui' }]), [{ step: 'eval_start', sets: ['small'], runs: 1, transport: 'ag-ui' }], 'a named transport is kept');
  assert.throws(() => workflows.validateSteps([{ step: 'eval_start', sets: ['x'], transport: 'carrier-pigeon' }]), /transport is one of/);
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));
  const schedules = new Schedules(() => vault);
  assert.throws(() => schedules.add({ name: 'x', when: 'daily 08:00', steps: ['nope'] }), /no workflow step/);
  const s = schedules.add({ name: 'Night', when: 'daily 23:00', steps: [{ step: 'eval_start', sets: ['aider-py'] }, 'eval_wait'] });
  assert.equal(workflows.isWorkflow(s), true);
  assert.throws(() => schedules.update(s.id, { steps: ['nope'] }), /no workflow step/, 'a change is checked too');
});

test("Startup, the baseline: SecondBrain hands his schedule's recipe to Steward's run_recipe and files what recipe_status returns", async () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));
  const schedules = new Schedules(() => vault);
  const prompt = 'Review work from the previous day on Github and bring all repos current. Review the plan for the build and summarize what is left.';
  const mine = schedules.add({ name: 'Startup', prompt, when: 'weekdays 06:00', deliver: ['note', 'telegram'] }, at('2026-11-04T12:00:00'));
  // his schedule as it stands, tuned in place: his name, time and prompt, with the recipe added
  const tuned = schedules.update(mine.id, { steps: STARTUP_STEPS, summarize: 'Write the daily what-happened from this.' });
  assert.deepEqual([tuned.name, tuned.prompt, tuned.whenText], ['Startup', prompt, 'weekdays 06:00']);

  const { steward, seen } = fakeSteward([
    { state: 'running' },
    { state: 'done', ok: true, text: 'Yesterday: Jesster #71 landed.\n\n---\n\n<details>gathered</details>', short: 'Yesterday: Jesster #71 landed.' },
  ]);
  const sent = [];
  const agent = { ask: async () => assert.fail('no chat turn: Steward runs the recipe as a workflow') };
  const base = { schedules, vault, agent, steward, deliverers: { telegram: async (m) => sent.push(m) }, busy: () => true };
  const t1 = at('2026-11-05T06:00:10');
  const parked = await runSchedule(schedules.due(t1)[0], { ...base, now: t1 });
  assert.equal(parked.parked.run_id, 'run1', 'Startup starts no eval, so a busy Steward does not skip it');
  assert.deepEqual(seen.started[0].recipe, { name: 'Startup', prompt, steps: STARTUP_STEPS, summarize: 'Write the daily what-happened from this.', deliver: ['note', 'telegram'] });
  assert.equal(seen.started[0].since, (t1 - 24 * 3600000) / 1000, 'the last day, in seconds, when it never ran');
  assert.deepEqual(seen.started[0].extra, { flow: mine.id, trigger: 'schedule' }, 'the flow and what started it, for its run history');
  assert.equal(schedules.all()[0].lastResult, "waiting on Steward's run run1");
  assert.deepEqual(await resumeSchedules({ ...base, now: t1 + 30000 }), [], 'still running');
  const [filed] = await resumeSchedules({ ...base, now: t1 + 60000 });
  assert.equal(filed.ok, true);
  const note = vault.load().find((n) => n.id === filed.id);
  assert.match(note.content, /weekdays at 06:00, workflow/);
  assert.match(note.content, /Yesterday: Jesster #71 landed/);
  assert.deepEqual(sent, ['Startup: Yesterday: Jesster #71 landed.'], 'one short line to Telegram');
  assert.deepEqual([schedules.all()[0].pending, schedules.all()[0].lastResult], [null, 'ok']);
});

test('the nightly eval recipe: skipped while Steward is busy; a failed or overlong run is filed as such', async () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));
  const schedules = new Schedules(() => vault);
  schedules.add({ name: 'Nightly aider-py', when: 'daily 23:00', deliver: ['note', 'telegram'], steps: [{ step: 'eval_start', sets: ['aider-py'] }, 'eval_wait'] }, at('2026-11-05T12:00:00'));
  const { steward, seen } = fakeSteward([{ state: 'failed', error: 'RuntimeError: An eval is running now' }]);
  const sent = [];
  const base = { schedules, vault, agent: {}, steward, deliverers: { telegram: async (m) => sent.push(m) } };
  const t1 = at('2026-11-05T23:00:05');
  const skipped = await runSchedule(schedules.due(t1)[0], { ...base, now: t1, busy: () => true });
  assert.equal(skipped.skipped, true);
  assert.equal(schedules.all()[0].lastResult, 'skipped: Steward busy');
  assert.deepEqual(seen.started, [], 'his personal use comes first');

  const t2 = at('2026-11-06T23:00:05');
  await runSchedule(schedules.due(t2)[0], { ...base, now: t2, busy: () => false });
  assert.deepEqual(seen.started[0].recipe.steps, [{ step: 'eval_start', sets: ['aider-py'], runs: 1 }, { step: 'eval_wait', hours: 8 }]);
  const [failed] = await resumeSchedules({ ...base, now: t2 + 60000 });
  assert.equal(failed.ok, false);
  assert.deepEqual(sent, ['Nightly aider-py: Failed: RuntimeError: An eval is running now']);

  const t3 = at('2026-11-07T23:00:05');
  await runSchedule(schedules.due(t3)[0], { ...base, now: t3, busy: () => false });
  assert.deepEqual(await resumeSchedules({ ...base, now: t3 + workflows.RUN_MAX_MS - 1000 }), []);
  const [late] = await resumeSchedules({ ...base, now: t3 + workflows.RUN_MAX_MS + 1000 });
  assert.equal(late.ok, false);
  assert.match(vault.load().find((n) => n.id === late.id).content, /had not ended 9 hours after it started/);
});

test("stewardRecipes speaks MCP 2026-07-28's tools/call to his host: run_recipe with the recipe and its window, recipe_status by id; an error result throws", async () => {
  const posted = [];
  const replies = [
    { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"run_id": "r1", "state": "running"}' }], isError: false } },
    { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"state": "done", "ok": true, "text": "t", "short": "s"}' }], isError: false } },
    { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'no workflow step "run_shell"' }], isError: true } },
  ];
  const s = workflows.stewardRecipes({ url: 'http://127.0.0.1:43121/mcp', post: async (url, body, headers) => (posted.push([url, body, headers]), replies.shift()) });
  assert.deepEqual(await s.runRecipe({ name: 'x', steps: ['plan_left'] }, 1.5), { run_id: 'r1', state: 'running' });
  assert.deepEqual(await s.recipeStatus('r1'), { state: 'done', ok: true, text: 't', short: 's' });
  await assert.rejects(s.runRecipe({ steps: ['run_shell'] }), /run_recipe: no workflow step "run_shell"/);
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'secondbrain-workflows', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  assert.deepEqual(posted[0], [
    'http://127.0.0.1:43121/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_recipe', arguments: { recipe: { name: 'x', steps: ['plan_left'] }, since: 1.5 }, _meta: meta } },
    { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'run_recipe' },
  ]);
  assert.deepEqual(posted[1][1].params, { name: 'recipe_status', arguments: { run_id: 'r1' }, _meta: meta });
  assert.equal(posted[1][2]['Mcp-Name'], 'recipe_status');
});

test('a recipe call reaches the host as one the 2026-07-28 server check (mcpversion.classify, with its headers) serves as modern', async () => {
  const http = require('http');
  const mcpv = require('../mcpversion.cjs');
  let seen;
  const host = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      seen = [JSON.parse(text), req.headers];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"state": "running"}' }] } }));
    });
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  try {
    const s = workflows.stewardRecipes({ url: `http://127.0.0.1:${host.address().port}/mcp` });
    assert.deepEqual(await s.recipeStatus('r1'), { state: 'running' });
  } finally {
    host.close();
  }
  const era = mcpv.classify(seen[0], seen[1]);
  assert.equal(era.error, undefined);
  assert.equal(era.era, 'modern');
  assert.equal(era.version, '2026-07-28');
  assert.equal(seen[1]['mcp-name'], 'recipe_status');
  assert.match(seen[1].accept, /application\/json/);
  assert.match(seen[1].accept, /text\/event-stream/);
  assert.equal(workflows.STEWARD_MCP, 'http://127.0.0.1:43121/mcp');
});

test("the Flows shelf's reads: recipe_graph with the flow's recipe, recipe_runs by flow, each bounded; Run now is kept as such", async () => {
  const posted = [];
  const replies = [
    { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"workflow": {"start_executor_id": "begin", "executors": {}, "edge_groups": []}}' }] } },
    { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '[{"run_id": "r1", "state": "done", "ok": true, "steps": []}]' }] } },
    { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'flow is the flow\'s id' }], isError: true } },
    { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: '{"run_id": "r2", "state": "running"}' }] } },
  ];
  const s = workflows.stewardRecipes({ post: async (url, body, headers, timeout) => (posted.push([body.params, headers['Mcp-Name'], timeout]), replies.shift()) });
  assert.equal((await s.recipeGraph({ name: 'x', steps: ['plan_left'] })).workflow.start_executor_id, 'begin');
  assert.deepEqual(await s.recipeRuns('f1', 5), [{ run_id: 'r1', state: 'done', ok: true, steps: [] }]);
  await assert.rejects(s.recipeRuns(''), /recipe_runs: flow is the flow's id/);
  assert.deepEqual(posted.map((p) => [p[0].name, p[0].arguments, p[1]]), [
    ['recipe_graph', { recipe: { name: 'x', steps: ['plan_left'] } }, 'recipe_graph'],
    ['recipe_runs', { flow: 'f1', limit: 5 }, 'recipe_runs'],
    ['recipe_runs', { flow: '', limit: 10 }, 'recipe_runs'],
  ]);
  assert.ok(posted.every((p) => p[2] > 0 && p[2] <= 5000), 'a host that is down is told within seconds');
  await s.runRecipe({ name: 'x', steps: ['plan_left'] }, 1, { flow: 'f1', trigger: 'now' });
  assert.deepEqual(posted[3][0].arguments, { recipe: { name: 'x', steps: ['plan_left'] }, since: 1, flow: 'f1', trigger: 'now' });

  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));
  const schedules = new Schedules(() => vault);
  const f = schedules.add({ name: 'Plan', when: '', steps: ['plan_left'] });
  const { steward, seen } = fakeSteward([]);
  await runSchedule(f, { schedules, vault, agent: {}, steward, deliverers: {}, trigger: 'now' });
  assert.deepEqual(seen.started[0].extra, { flow: f.id, trigger: 'now' });
});

// ---- Run now, 2026-11-08 ----------------------------------------------------------------------------------------------
// The operator: "NONE of the flows started". Every press after the first three never reached schedules:run (their
// lastRun stayed null): the shelf held Run now on every flow while any Steward conversation was mid-turn or a card
// waited (steward-mcp.log: the shelf read at 11-07 05:23:51 while the Agent tab's card waited, 05:22:56 to 05:24:06),
// and the reason was a grey word at the end of the bar. Run now is now held only by that flow's own run.

const { runNow, runningLine } = require('./schedules.cjs');

function evalFlows() {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'runnow-')));
  const schedules = new Schedules(() => vault);
  const evalFlow = (set) => schedules.add({ name: `Eval: ${set}`, when: '', backend: 'steward', steps: [{ step: 'eval_start', sets: [set], runs: 1 }, 'eval_wait', 'eval_bars'], summarize: 'Say it.' });
  return { vault, schedules, bfcl: evalFlow('bfcl'), small: evalFlow('small'), drift: schedules.add({ name: 'Repo drift check', when: '', backend: 'steward', steps: ['versions', 'repo_log'] }) };
}

test('Run now reaches Steward for every flow, eval or not, even while a conversation is mid-turn; a scheduled eval still waits', async () => {
  const { vault, schedules, bfcl, small, drift } = evalFlows();
  const { steward, seen } = fakeSteward([]);
  const deps = { schedules, vault, agent: {}, steward, deliverers: {}, busy: () => true };
  for (const f of [bfcl, small, drift]) {
    const r = await runNow(f.id, deps);
    assert.equal(r.run_id, `run${seen.started.length}`, `${f.name} reached run_recipe`);
    assert.equal(r.skipped, undefined);
  }
  assert.deepEqual(seen.started.map((x) => [x.recipe.name, x.extra.trigger]), [['Eval: bfcl', 'now'], ['Eval: small', 'now'], ['Repo drift check', 'now']]);
  // the scheduler's own run of an eval still gives way to his conversation
  const t = at('2026-11-09T23:00:00');
  const night = schedules.add({ name: 'Nightly', when: 'daily 23:00', steps: [{ step: 'eval_start', sets: ['bfcl'] }, 'eval_wait'] }, t - 3600000);
  const skipped = await runSchedule(schedules.all().find((x) => x.id === night.id), { ...deps, now: t });
  assert.equal(skipped.skipped, true);
  assert.equal(seen.started.length, 3);
});

test('a failed eval run clears its running and pending, says why on the flow, and the next flow\'s Run now reaches Steward', async () => {
  const { vault, schedules, bfcl, small } = evalFlows();
  const why = 'eval_start: evals.py --transport: a host transport runs an asks set (small, heldout) only; bfcl must run in-process. Nothing was started.';
  const { steward, seen } = fakeSteward([{ state: 'failed', error: why }]);
  const deps = { schedules, vault, agent: {}, steward, deliverers: {}, busy: () => false };
  const t = at('2026-11-06T16:39:52');
  const r = await runNow(bfcl.id, { ...deps, now: t });
  assert.equal(r.run_id, 'run1');
  const parked = schedules.all().find((x) => x.id === bfcl.id);
  assert.equal(parked.running, false);
  assert.equal(parked.pending.run_id, 'run1');
  await assert.rejects(runNow(bfcl.id, deps), /Eval: bfcl is running now: waiting on Steward's run run1/, 'a flow already running is refused with why');
  const [filed] = await resumeSchedules({ ...deps, now: t + 30000 });
  assert.equal(filed.ok, false);
  const after = schedules.all().find((x) => x.id === bfcl.id);
  assert.deepEqual([after.running, after.pending], [false, null], 'nothing left running or pending');
  assert.equal(after.lastResult, `Failed: ${why}`.slice(0, 200));
  // the same flow runs again, and so does another
  assert.equal((await runNow(bfcl.id, deps)).run_id, 'run2');
  assert.equal((await runNow(small.id, deps)).run_id, 'run3');
  assert.deepEqual(seen.started.map((x) => x.recipe.name), ['Eval: bfcl', 'Eval: bfcl', 'Eval: small']);
});

test('a run that throws before Steward answers is filed failed and leaves nothing running; a running left by a quit is cleared at start', async () => {
  const { vault, schedules, drift } = evalFlows();
  const down = { runRecipe: async () => { throw new Error("Steward's MCP host did not answer in time"); }, recipeStatus: async () => ({ state: 'running' }) };
  const r = await runNow(drift.id, { schedules, vault, agent: {}, steward: down, deliverers: {} });
  assert.equal(r.ok, false);
  const s = schedules.all().find((x) => x.id === drift.id);
  assert.deepEqual([s.running, s.pending], [false, null]);
  assert.match(s.lastResult, /^Failed: Steward's MCP host did not answer in time/);
  // a quit between the claim and Steward's answer leaves running: true; the app's start clears it
  schedules.update(drift.id, { running: true });
  await assert.rejects(runNow(drift.id, { schedules, vault, agent: {}, steward: down, deliverers: {} }), /is running now: it is starting/);
  assert.deepEqual(schedules.clearStale(), ['Repo drift check']);
  assert.equal(schedules.all().find((x) => x.id === drift.id).running, false);
  assert.deepEqual(schedules.clearStale(), [], 'nothing to clear twice');
  assert.equal(runningLine({ pending: { label: 'x' } }), 'waiting on x');
  await assert.rejects(runNow('nope', { schedules }), /no flow "nope"/);
});
