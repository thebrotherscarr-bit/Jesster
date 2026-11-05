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
  assert.equal(main.match(/sched\.runSchedule\(s, scheduleDeps\(\)\)/g).length, 2, 'the tick and Run now');
  assert.match(main, /onCard: phoneCard,/);
  assert.match(main, /busy: \(\) => getAgent\(\)\.busy\(\),/);
  assert.match(main, /await sched\.resumeSchedules\(scheduleDeps\(\)\)/);
  assert.match(main, /const stewardEvals = \(\) => estate\.evalsApi\(\{ stewardDir: stewardDirNow \}\)/);
  assert.match(main, /evals: stewardEvals\(\),/);
  assert.match(main, /const stewardRecipes = workflows\.stewardRecipes\(\{ url: `http:\/\/127\.0\.0\.1:\$\{steward\.MCP_PORT\}\/mcp` \}\)/);
  assert.ok(main.includes('    steward: stewardRecipes,'), 'the scheduler hands workflows to Steward')
  // the Flows shelf's Set up and Run now (2026-11-05): a change goes through edit, busy is the agent's
  assert.match(main, /ipcMain\.handle\('schedules:edit', \(event, id, spec\) => \{\s+guard\(event\);\s+getSchedules\(\)\.edit\(id, spec \|\| \{\}\);/);
  assert.match(main, /ipcMain\.handle\('schedules:busy', \(event\) => \{\s+guard\(event\);\s+return getAgent\(\)\.busy\(\);/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8');
  assert.match(preload, /edit: \(id, spec\) => ipcRenderer\.invoke\('schedules:edit', id, spec\)/);
  assert.match(preload, /busy: \(\) => ipcRenderer\.invoke\('schedules:busy'\)/);
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
      runRecipe: async (recipe, since) => (seen.started.push({ recipe, since }), { run_id: `run${seen.started.length}`, state: 'running' }),
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
  assert.deepEqual(workflows.validateSteps([{ step: 'eval_start', sets: ['aider-py'] }, 'eval_wait']), [{ step: 'eval_start', sets: ['aider-py'], runs: 1, transport: 'ag-ui' }, { step: 'eval_wait', hours: 8 }], 'over AG-UI by default');
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
  assert.deepEqual(seen.started[0].recipe.steps, [{ step: 'eval_start', sets: ['aider-py'], runs: 1, transport: 'ag-ui' }, { step: 'eval_wait', hours: 8 }]);
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

test("stewardRecipes speaks MCP's tools/call to his host: run_recipe with the recipe and its window, recipe_status by id; an error result throws", async () => {
  const posted = [];
  const replies = [
    { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"run_id": "r1", "state": "running"}' }], isError: false } },
    { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"state": "done", "ok": true, "text": "t", "short": "s"}' }], isError: false } },
    { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'no workflow step "run_shell"' }], isError: true } },
  ];
  const s = workflows.stewardRecipes({ url: 'http://127.0.0.1:43121/mcp', post: async (url, body) => (posted.push([url, body]), replies.shift()) });
  assert.deepEqual(await s.runRecipe({ name: 'x', steps: ['plan_left'] }, 1.5), { run_id: 'r1', state: 'running' });
  assert.deepEqual(await s.recipeStatus('r1'), { state: 'done', ok: true, text: 't', short: 's' });
  await assert.rejects(s.runRecipe({ steps: ['run_shell'] }), /run_recipe: no workflow step "run_shell"/);
  assert.deepEqual(posted[0], ['http://127.0.0.1:43121/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_recipe', arguments: { recipe: { name: 'x', steps: ['plan_left'] }, since: 1.5 } } }]);
  assert.deepEqual(posted[1][1].params, { name: 'recipe_status', arguments: { run_id: 'r1' } });
  assert.equal(workflows.STEWARD_MCP, 'http://127.0.0.1:43121/mcp');
});
