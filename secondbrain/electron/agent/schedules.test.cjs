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
});

// ---- workflows (agent/workflows.cjs): a schedule's steps, as data ------------------------------------------------

const workflows = require('./workflows.cjs');
const { resumeSchedules } = require('./schedules.cjs');

/** A ground with the Estate's five repositories (a .git folder each), the plan file, and Steward's eval runs. */
function fakeGround() {
  const ground = fs.mkdtempSync(path.join(os.tmpdir(), 'ground-'));
  const repos = workflows.estateRepos(ground);
  for (const r of repos) fs.mkdirSync(path.join(r.dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(ground, 'WHATS_LEFT.md'), "# WHAT'S LEFT\r\n\r\n## Today's working path\r\n\r\n1. The eval framework, step 1.\r\n\r\n## The plan by office\r\n\r\nold\r\n");
  const stewardDir = path.join(ground, 'worlds', 'steward');
  const evalsDir = path.join(stewardDir, 'harness', 'steward', 'evals');
  fs.mkdirSync(evalsDir, { recursive: true });
  fs.writeFileSync(path.join(evalsDir, 'run-bar.ps1'), 'param()\r\n');
  fs.writeFileSync(path.join(evalsDir, 'ext-aider-py.yaml'), 'name: aider-py\r\n');
  const runs = path.join(stewardDir, 'storage', 'evals', 'runs', 'small-night');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'progress.txt'), '2026-11-05T01:00:00 bar small-night : sets small\r\n2026-11-05T01:40:00 done  small v4 (T0) run 1: 9/10 cases\r\n2026-11-05T01:40:09 BAR DONE\r\n');
  return { ground, repos, stewardDir };
}

/** git and gh as recorded fakes: steward is on a feature branch, neiro has uncommitted changes, the rest are clean. */
function fakeRun(calls) {
  return async (cmd, args, cwd) => {
    calls.push([cmd, ...args, path.basename(cwd)]);
    const repo = path.basename(cwd);
    if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, out: repo === 'steward' ? 'fix-x' : 'main', err: '' };
    if (cmd === 'git' && args[0] === 'diff-index') return { code: repo === 'neiro' ? 1 : 0, out: '', err: '' };
    if (cmd === 'git' && args[0] === 'pull') return { code: 0, out: repo === 'jesster' ? 'Fast-forward' : 'Already up to date.', err: '' };
    if (cmd === 'git' && args[0] === 'log') return { code: 0, out: repo === 'jesster' ? 'ae02179 2026-11-05 Merge pull request #71' : '', err: '' };
    if (cmd === 'gh' && args[0] === 'pr') return { code: 0, out: JSON.stringify(repo === 'jesster' ? [{ number: 71, title: 'Steward keep-up', mergedAt: '2026-11-05T02:00:00Z' }] : []), err: '' };
    if (cmd === 'gh' && args[0] === 'release') return { code: 0, out: JSON.stringify(repo === 'jesster' ? [{ tagName: 'secondbrain-b85', publishedAt: '2026-11-05T03:00:00Z' }, { tagName: 'secondbrain-b80', publishedAt: '2026-10-01T03:00:00Z' }] : []), err: '' };
    return { code: 1, out: '', err: 'unexpected' };
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

test('Startup, the baseline: the steps gather read-only, pull only clean mains, then one Steward turn writes the what-happened', async () => {
  const { ground, repos, stewardDir } = fakeGround();
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));
  const schedules = new Schedules(() => vault);
  const prompt = 'Review work from the previous day on Github and bring all repos current. Review the plan for the build and summarize what is left.';
  const t0 = at('2026-11-04T12:00:00');
  // his schedule as it stands, tuned in place: his name, time and prompt, with the recipe added
  const mine = schedules.add({ name: 'Startup', prompt, when: 'weekdays 06:00', deliver: ['note', 'telegram'] }, t0);
  const tuned = schedules.update(mine.id, { steps: STARTUP_STEPS, summarize: 'Write the daily what-happened from this: a short plain summary, under 300 words.' });
  assert.deepEqual([tuned.name, tuned.prompt, tuned.whenText], ['Startup', prompt, 'weekdays 06:00']);

  const calls = [];
  const asked = [];
  const agent = { busy: () => false, ask: async (req) => (asked.push(req), { answer: 'Yesterday: Jesster #71 landed and b85 shipped.\nMore.' }) };
  const sent = [];
  const t1 = at('2026-11-05T06:00:10');
  const r = await runSchedule(schedules.due(t1)[0], {
    schedules, agent, vault, now: t1, deliverers: { telegram: async (m) => sent.push(m) }, onCard: () => {},
    repos, ground, stewardDir, run: fakeRun(calls), sitting: () => '112',
    versions: async () => [
      { name: 'research', branch: 'main', head: 'aaa1111', origin_main: 'aaa1111', behind: 0, ahead: 0, clean: true },
      { name: 'steward', branch: 'fix-x', head: 'bbb2222', origin_main: 'ccc3333', behind: 3, ahead: 1, clean: false },
    ],
  });

  assert.equal(r.ok, true);
  assert.equal(asked.length, 1, 'one Steward turn');
  assert.equal(asked[0].source, 'automation');
  assert.equal(asked[0].automation, 'Startup');
  assert.equal(asked[0].approve, undefined);
  assert.equal(asked[0].sessionId, undefined, 'a fresh conversation');
  const text = asked[0].text;
  assert.match(text, /^Write the daily what-happened/);
  assert.match(text, /The automation's own words: Review work from the previous day/);
  assert.match(text, /research: not pulled: Manjuel sitting 112 is open \(RULE 9\)/);
  assert.match(text, /steward: not pulled: on branch fix-x, not main/);
  assert.match(text, /neiro: not pulled: the work tree has uncommitted changes/);
  assert.match(text, /jesster: pulled \(fast-forward\)/);
  assert.match(text, /atlas: current \(nothing to pull\)/);
  assert.match(text, /ae02179 2026-11-05 Merge pull request #71/);
  assert.match(text, /#71 Steward keep-up/);
  assert.match(text, /jesster: secondbrain-b85 \(2026-11-05T03:00:00Z\)\n/, 'only releases since the last run');
  assert.match(text, /done {2}small v4 \(T0\) run 1: 9\/10 cases/);
  assert.match(text, /1\. The eval framework, step 1\./);
  assert.match(text, /- research: main at aaa1111; origin\/main aaa1111, 0 behind, 0 ahead, clean/);
  assert.match(text, /- steward: fix-x at bbb2222; origin\/main ccc3333, 3 behind, 1 ahead, uncommitted changes/, 'drift shows in the morning');
  assert.doesNotMatch(text, /The plan by office/, 'only the working path');
  // the pulls happened only where allowed, and nothing ran git status or git diff
  const pulls = calls.filter((c) => c[0] === 'git' && c[1] === 'pull').map((c) => c.at(-1));
  assert.deepEqual(pulls.sort(), ['atlas', 'jesster']);
  assert.ok(!calls.some((c) => c[0] === 'git' && ['status', 'diff'].includes(c[1])), 'never git status or git diff');
  assert.ok(calls.filter((c) => c[1] === 'pull').every((c) => c.includes('--ff-only') && c.includes('main')));
  assert.ok(calls.filter((c) => c[1] === 'log').every((c) => c.includes(`--since=${new Date(t1 - 24 * 3600000).toISOString()}`)), 'the last day when it never ran');

  const note = vault.load().find((n) => n.id === r.id);
  assert.match(note.content, /weekdays at 06:00, workflow/);
  assert.match(note.content, /Yesterday: Jesster #71 landed/);
  assert.match(note.content, /What the steps gathered/);
  assert.deepEqual(sent, ['Startup: Yesterday: Jesster #71 landed and b85 shipped.'], 'one short line to Telegram');
  assert.equal(schedules.all()[0].lastResult, 'ok');
});

test('the nightly eval workflow: skipped while Steward is busy; else eval_start, parked on eval_wait, filed at BAR DONE', async () => {
  const { ground, stewardDir } = fakeGround();
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')));
  const schedules = new Schedules(() => vault);
  const s = schedules.add({ name: 'Nightly aider-py', when: 'daily 23:00', deliver: ['note', 'telegram'], steps: [{ step: 'eval_start', sets: ['aider-py'], runs: 1 }, 'eval_wait'] }, at('2026-11-05T12:00:00'));
  const launched = [];
  const evals = { dir: () => stewardDir, running: async () => false, launch: async (spec) => (launched.push(spec), { pid: 1 }) };
  const sent = [];
  const agent = { ask: async () => assert.fail('no chat turn: an eval workflow has no summarize') };
  const base = { schedules, agent, vault, evals, ground, stewardDir, repos: [], deliverers: { telegram: async (m) => sent.push(m) } };

  const t1 = at('2026-11-05T23:00:05');
  const skipped = await runSchedule(schedules.due(t1)[0], { ...base, now: t1, busy: () => true });
  assert.equal(skipped.skipped, true);
  assert.equal(schedules.all()[0].lastResult, 'skipped: Steward busy');
  assert.deepEqual(launched, [], 'his personal use comes first');

  const t2 = at('2026-11-06T23:00:05');
  const parked = await runSchedule(schedules.due(t2)[0], { ...base, now: t2, busy: () => false });
  assert.deepEqual(launched, [{ dir: stewardDir, sets: ['aider-py'], runs: 1, tag: 'aider-py-2026-11-06-2300', transport: 'ag-ui' }], 'run-bar.ps1 -Transport ag-ui');
  assert.equal(parked.parked.tag, 'aider-py-2026-11-06-2300');
  assert.equal(schedules.all()[0].lastResult, 'waiting on aider-py-2026-11-06-2300');
  assert.deepEqual(await resumeSchedules({ ...base, now: t2 + 60000 }), [], 'no progress file yet: still waiting');

  const folder = path.join(stewardDir, 'storage', 'evals', 'runs', 'aider-py-2026-11-06-2300');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'progress.txt'), '2026-11-06T23:00:06 start aider-py run 1\r\n');
  assert.deepEqual(await resumeSchedules({ ...base, now: t2 + 120000 }), []);
  fs.appendFileSync(path.join(folder, 'progress.txt'), '2026-11-07T03:12:00 done  aider-py v1 (ext) run 1: 21/34 cases, 21/34 checks\r\n2026-11-07T03:12:04 BAR DONE\r\n');
  const [filed] = await resumeSchedules({ ...base, now: at('2026-11-07T03:12:30') });
  assert.equal(filed.ok, true);
  const note = vault.load().find((n) => n.id === filed.id);
  assert.match(note.content, /aider-py-2026-11-06-2300 ended \(BAR DONE\)/);
  assert.match(note.content, /21\/34 cases/);
  assert.deepEqual(sent, ['Nightly aider-py: done  aider-py v1 (ext) run 1: 21/34 cases, 21/34 checks']);
  const after = schedules.all().find((x) => x.id === s.id);
  assert.deepEqual([after.pending, after.lastResult], [null, 'ok']);

  // a run that never says BAR DONE is filed after its hours, not waited on for ever
  const t3 = at('2026-11-07T23:00:05');
  await runSchedule(schedules.due(t3)[0], { ...base, now: t3, busy: () => false });
  const [late] = await resumeSchedules({ ...base, now: t3 + 8 * 3600000 + 1000 });
  assert.equal(late.ok, false);
  assert.match(vault.load().find((n) => n.id === late.id).content, /did not say BAR DONE within 8 h/);
});
