import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RECIPE_STEPS, blankForm, cleanError, formOf, runBlocked, runFlow, saveFlow, removeFlow, setFlowEnabled, specOf, whenChoices, whenText } from './flowSetup.ts';
import { FlowsShelfView } from '../components/FlowsShelf.tsx';
import { AutomationsSection } from '../components/settings/AutomationsSection.tsx';
import type { ScheduleView, SchedulesBridge } from '../types/desktop.ts';

// The Flows shelf's Run now and Set up (the operator, 2026-11-05: "need a way to actually run the things ... where do
// i input the stuff that you asked me to set?"). The automations moved here from the Agent console; same IPC.
const require = createRequire(import.meta.url);
const workflows = require('../../electron/agent/workflows.cjs');
const { parseWhen } = require('../../electron/agent/schedules.cjs');

const schedule = (over: Partial<ScheduleView>): ScheduleView => ({
  id: 's1',
  name: 'Startup',
  prompt: '',
  whenText: 'weekdays 06:00',
  whenLabel: 'weekdays at 06:00',
  deliver: ['note'],
  enabled: true,
  next: null,
  lastRun: null,
  lastResult: null,
  ...over,
});

/** The schedules bridge as a recorded fake: every call it gets, and a refusal when told to. */
function fakeBridge(refuse?: string) {
  const calls: [string, ...unknown[]][] = [];
  const list = [schedule({})];
  const answer = async (name: string, ...args: unknown[]) => {
    calls.push([name, ...args]);
    if (refuse) throw new Error(`Error invoking remote method 'schedules:${name}': Error: ${refuse}`);
    return list;
  };
  const bridge: SchedulesBridge = {
    list: () => answer('list'),
    add: (spec) => answer('add', spec),
    edit: (id, spec) => answer('edit', id, spec),
    update: (id, patch) => answer('update', id, patch),
    remove: (id) => answer('remove', id),
    run: async (id) => (calls.push(['run', id]), { note: 'n1', ok: true, schedules: list }),
    busy: async () => false,
  };
  return { bridge, calls };
}

test("the recipe's steps are workflows.cjs STEPS less the eval workflow's two", () => {
  assert.deepEqual([...RECIPE_STEPS].sort(), workflows.STEPS.filter((s: string) => !['eval_start', 'eval_wait'].includes(s)).sort());
});

test('the plain when choices are text parseWhen reads, and read back', () => {
  const f = blankForm();
  const cases = [
    { ...f, whenKind: 'daily' as const, time: '08:30' },
    { ...f, whenKind: 'weekdays' as const, time: '06:00' },
    { ...f, whenKind: 'weekly' as const, day: 'fri', time: '17:45' },
    { ...f, whenKind: 'every' as const, every: 3, everyUnit: 'h' as const },
    { ...f, whenKind: 'every' as const, every: 30, everyUnit: 'm' as const },
    { ...f, whenKind: 'once' as const, date: '2026-12-01', time: '09:00' },
  ];
  for (const c of cases) {
    const text = whenText(c);
    assert.doesNotThrow(() => parseWhen(text), text);
    const back = whenChoices(text);
    assert.equal(whenText({ ...f, ...back }), text, `${text} reads back`);
  }
  assert.deepEqual(whenChoices('weekly Monday 9:00'), { ...whenChoices(''), whenKind: 'weekly', day: 'mon', time: '09:00' });
});

test('the form makes each kind of automation as add and edit take it', () => {
  const f = { ...blankForm(), name: ' Morning ', prompt: 'Say what is left', telegram: true };
  assert.deepEqual(specOf(f), { name: 'Morning', when: 'weekdays 08:30', deliver: ['note', 'telegram'], prompt: 'Say what is left', backend: 'steward', steps: [], summarize: '' });
  const recipe = specOf({ ...f, type: 'recipe', steps: ['repo_log', 'versions'], summarize: 'Write it up' });
  assert.deepEqual([recipe.steps, recipe.summarize, recipe.backend], [['repo_log', 'versions'], 'Write it up', 'steward']);
  assert.deepEqual(workflows.validateSteps(recipe.steps), ['repo_log', 'versions']);
  const evals = specOf({ ...f, type: 'evals', sets: 'aider-py, small', runs: 2 });
  assert.deepEqual(evals.steps, [{ step: 'eval_start', sets: ['aider-py', 'small'], runs: 2 }, 'eval_wait']);
  assert.doesNotThrow(() => workflows.validateSteps(evals.steps));
  // a schedule read back into the form: his Startup recipe, an eval workflow, an old local prompt
  const startup = formOf(schedule({ steps: ['pull_ff', 'versions'], summarize: 'Daily', deliver: ['note', 'telegram'], prompt: 'Review' }));
  assert.deepEqual([startup.type, startup.steps, startup.summarize, startup.telegram, startup.whenKind, startup.time], ['recipe', ['pull_ff', 'versions'], 'Daily', true, 'weekdays', '06:00']);
  const night = formOf(schedule({ steps: [{ step: 'eval_start', sets: ['aider-py'], runs: 2, transport: 'ag-ui' }, { step: 'eval_wait', hours: 8 }] }));
  assert.deepEqual([night.type, night.sets, night.runs], ['evals', 'aider-py', 2]);
  assert.equal(formOf(schedule({ prompt: 'x', backend: 'local' })).type, 'local');
  assert.equal(formOf(schedule({ prompt: 'x', backend: 'steward' })).type, 'steward');
});

test('Set up saves, changes, turns on and off, and deletes through the same IPC; a refusal comes back in plain words', async () => {
  const { bridge, calls } = fakeBridge();
  const f = { ...blankForm(), name: 'Morning', prompt: 'Say hi' };
  await saveFlow(bridge, f, null);
  assert.deepEqual(calls.at(-1), ['add', { name: 'Morning', when: 'weekdays 08:30', deliver: ['note'], prompt: 'Say hi', backend: 'steward' }], 'a new one is added, with no empty steps');
  await saveFlow(bridge, f, 's1');
  assert.equal(calls.at(-1)![0], 'edit');
  assert.equal(calls.at(-1)![1], 's1', 'the open one is changed');
  await setFlowEnabled(bridge, 's1', false);
  assert.deepEqual(calls.at(-1), ['update', 's1', { enabled: false }]);
  await removeFlow(bridge, 's1');
  assert.deepEqual(calls.at(-1), ['remove', 's1']);

  const refused = fakeBridge('when must look like: "daily 08:30"').bridge;
  await assert.rejects(saveFlow(refused, f, null), (e) => cleanError(e) === 'when must look like: "daily 08:30"');
});

test('Run now calls the run path, and is held with the reason while it runs or Steward is busy', async () => {
  const { bridge, calls } = fakeBridge();
  const r = await runFlow(bridge, 's1');
  assert.deepEqual(calls, [['run', 's1']], 'schedules:run, the path the scheduler takes');
  assert.equal(r.ok, true);
  assert.equal(runBlocked(schedule({}), false), null);
  assert.match(runBlocked(schedule({ running: true }), false)!, /running now/);
  assert.match(runBlocked(schedule({ pending: { label: "Steward's run r1", until: 0 } }), false)!, /waiting on Steward's run r1/);
  assert.match(runBlocked(schedule({}), true)!, /Steward is busy/);
  assert.match(runBlocked(null, false)!, /Pick a flow/);
  // the shelf's Run now is wired to it
  assert.match(readFileSync(new URL('../components/FlowsShelf.tsx', import.meta.url), 'utf8'), /await runFlow\(schedules, id\)/);
});

test('the shelf shows Run now, the last run and the cards running, done or failed', () => {
  const flows = [
    schedule({ id: 'a', name: 'Startup', steps: ['repo_log'], lastRun: Date.UTC(2026, 10, 5), lastResult: 'ok' }),
    schedule({ id: 'b', name: 'Night', prompt: 'x', backend: 'steward', running: true }),
    schedule({ id: 'c', name: 'Broken', prompt: 'x', backend: 'steward', lastRun: 1, lastResult: 'Failed: down' }),
  ];
  const view = (selectedId: string, busy = false) =>
    renderToStaticMarkup(<FlowsShelfView flows={flows} selectedId={selectedId} onSelect={() => {}} stewardOpen={false} onStewardOpen={() => {}} onRun={() => {}} stewardBusy={busy} />);
  const a = view('a');
  assert.match(a, /data-run="a"/);
  assert.ok(!/data-run="a"[^>]* disabled=""/.test(a), 'Run now is ready');
  assert.match(a, /last run: ok · /);
  assert.deepEqual([...a.matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]), ['done', 'done']);
  const b = view('b');
  assert.match(b, /data-run="b"[^>]* disabled=""/, 'held while it runs');
  assert.match(b, /It is running now/);
  assert.deepEqual([...new Set([...b.matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]))], ['running']);
  assert.deepEqual([...new Set([...view('c').matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]))], ['failed']);
  assert.match(view('a', true), /Steward is busy/);
});

test('Set up folds out on the shelf like the Phone view, holds the form, and shows what was refused', () => {
  const { bridge } = fakeBridge();
  const flows = [schedule({ id: 'a', name: 'Startup', steps: ['repo_log', 'versions'], summarize: 'Daily' })];
  const props = { flows, selectedId: 'a', onSelect: () => {}, stewardOpen: false, onStewardOpen: () => {}, onSetupOpen: () => {}, bridge, onFlowsChange: () => {} };
  const folded = renderToStaticMarkup(<FlowsShelfView {...props} />);
  assert.match(folded, /Set up/);
  assert.ok(!folded.includes('aria-label="Automations"'), 'folded until opened');
  const open = renderToStaticMarkup(<FlowsShelfView {...props} setupOpen />);
  assert.match(open, /aria-label="Automations"/);
  assert.match(open, /Change “Startup”/, 'the open flow is the one changed');
  assert.match(open, /Save changes/);
  assert.match(open, /aria-label="Delete Startup"/);
  assert.match(open, /aria-label="Enable Startup"/);
  for (const s of RECIPE_STEPS) assert.ok(open.includes(`>${s}</label>`) || open.includes(`/>${s}</label>`), `${s} can be picked`);
  assert.match(open, /aria-label="Summarize prompt"/);
  const fresh = renderToStaticMarkup(<AutomationsSection bridge={bridge} selected={null} onChange={() => {}} initialError={'bad time "25:00" (use HH:MM, 24-hour)'} />);
  assert.match(fresh, /New automation/);
  assert.match(fresh, /Add automation/);
  assert.match(fresh, /role="alert"[^>]*>bad time &quot;25:00&quot;/, 'the check shows inline');
  for (const t of ['Steward prompt', 'Recipe', 'Eval workflow', 'Every day', 'Weekdays', 'Once a week', 'Every few hours or minutes', 'Once']) assert.ok(fresh.includes(t), t);
});

test('the automations form is on the Flows shelf only: not in Settings, not on the console', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../components/FlowsShelf.tsx'), /<AutomationsSection /);
  assert.ok(!/<AutomationsSection\b/.test(read('../components/SettingsModal.tsx')));
  assert.ok(!/<AutomationsSection\b/.test(read('../components/AgentConsole.tsx')));
});
