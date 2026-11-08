import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as flowSetup from './flowSetup.ts';
import {
  LEGACY_LABEL,
  automationFormOf,
  automationsOf,
  blankAutomation,
  cleanError,
  flowsOf,
  removeAutomation,
  removeFlow,
  runBlocked,
  runFlow,
  saveAutomation,
  setFlowEnabled,
  whenChoices,
  whenText,
} from './flowSetup.ts';
import { FlowsShelfView } from '../components/FlowsShelf.tsx';
import { failedReason } from './flowGraph.ts';
import { AutomationsSection } from '../components/settings/AutomationsSection.tsx';
import type { ScheduleView, SchedulesBridge } from '../types/desktop.ts';

// The Flows shelf's Run now and Set up. ADR-0009 (Steward docs/decisions, 2026-11-05): a flow is an ordered chain of
// steps made only with + New flow; an automation is a saved flow, when and on/off; there is no prompt type.
const require = createRequire(import.meta.url);
const { parseWhen, Schedules, tools } = require('../../electron/agent/schedules.cjs');

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

const startup = schedule({ id: 'a', name: 'Startup', steps: ['pull_ff', 'versions', 'repo_log'], summarize: 'Daily' });
const mine = schedule({ id: 'b', name: 'Mine', steps: ['versions'], whenText: '', whenLabel: 'only on Run now' });
const legacy = schedule({ id: 'c', name: 'Old prompt', prompt: 'Say hi', backend: 'steward', whenText: 'daily 08:00', whenLabel: 'daily at 08:00' });

test('the plain when choices are text parseWhen reads, and read back', () => {
  const f = blankAutomation();
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

test("ADR-0009: no prompt type, in the form, the helpers or the app's way in", () => {
  // the form: a flow, when, on/off; no prompt, no type, no steps, no summarize, no Telegram
  const { bridge } = fakeBridge();
  const form = renderToStaticMarkup(<AutomationsSection bridge={bridge} flows={[startup, mine]} selected={mine} onChange={() => {}} startNew />);
  assert.match(form, /aria-label="Flow"/);
  assert.match(form, /aria-label="How often"/);
  assert.match(form, /aria-label="On"/);
  for (const gone of ['Steward prompt', 'Local agent prompt', 'aria-label="Prompt"', 'aria-label="What it does"', 'aria-label="Steps"', 'aria-label="Summarize prompt"', 'also send to Telegram'])
    assert.ok(!form.includes(gone), `no ${gone}`);
  assert.deepEqual(Object.keys(blankAutomation()).sort(), ['date', 'day', 'enabled', 'every', 'everyUnit', 'flowId', 'time', 'whenKind']);
  for (const old of ['specOf', 'formOf', 'saveFlow', 'blankForm', 'RECIPE_STEPS']) assert.ok(!(old in flowSetup), `${old} is gone`);
  // the app: schedules:add takes only a flow, and the local agent has no schedule_create
  const sched = new Schedules(() => ({ dir: 'unused' }));
  assert.throws(() => sched.addFlow({ name: 'x', prompt: 'do things', when: 'daily 08:00', backend: 'steward' }), /saved flow/);
  assert.ok(!tools(() => sched).some((t: { name: string }) => t.name === 'schedule_create'));
  assert.match(readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8'), /getSchedules\(\)\.addFlow\(spec \|\| \{\}\)/);
});

test('an automation is a saved flow plus when and on/off, through the same IPC; a refusal comes back in plain words', async () => {
  const { bridge, calls } = fakeBridge();
  await saveAutomation(bridge, { ...blankAutomation('b'), whenKind: 'daily', time: '23:00' }, null);
  assert.deepEqual(calls.splice(0), [['edit', 'b', { when: 'daily 23:00' }], ['update', 'b', { enabled: true }]]);
  // moved to another flow: the when comes off the first (it stays, Run now only)
  await saveAutomation(bridge, { ...blankAutomation('a'), enabled: false }, 'b');
  assert.deepEqual(calls.splice(0), [['edit', 'b', { when: '' }], ['edit', 'a', { when: 'weekdays 08:30' }], ['update', 'a', { enabled: false }]]);
  await assert.rejects(saveAutomation(bridge, blankAutomation(''), null), /Pick a saved flow/);
  // deleting an automation keeps its flow; a legacy prompt is removed
  await removeAutomation(bridge, startup);
  assert.deepEqual(calls.splice(0), [['edit', 'a', { when: '' }]]);
  await removeAutomation(bridge, legacy);
  assert.deepEqual(calls.splice(0), [['remove', 'c']]);
  await setFlowEnabled(bridge, 'a', false);
  assert.deepEqual(calls.at(-1), ['update', 'a', { enabled: false }]);
  await removeFlow(bridge, 'a');
  assert.deepEqual(calls.at(-1), ['remove', 'a']);
  assert.deepEqual(automationFormOf(startup), { ...blankAutomation('a'), whenKind: 'weekdays', time: '06:00' });

  const refused = fakeBridge('when must look like: "daily 08:30"').bridge;
  await assert.rejects(saveAutomation(refused, blankAutomation('a'), null), (e) => cleanError(e) === 'when must look like: "daily 08:30"');
});

test('flows and automations: a flow has steps; an automation is a flow with a when, or a legacy prompt shown to convert', () => {
  const list = [startup, mine, legacy];
  assert.deepEqual(flowsOf(list).map((s) => s.id), ['a', 'b']);
  assert.deepEqual(automationsOf(list).map((s) => s.id), ['a', 'c'], 'a flow with no when is not an automation');
  const { bridge } = fakeBridge();
  const html = renderToStaticMarkup(<AutomationsSection bridge={bridge} flows={list} selected={startup} onChange={() => {}} />);
  assert.match(html, /data-automation="a"/);
  assert.match(html, /data-automation="c"/);
  assert.doesNotMatch(html, /data-automation="b"/);
  assert.match(html, new RegExp(`data-legacy[^>]*>${LEGACY_LABEL}<`));
  assert.match(html, /aria-label="Change Startup"/);
  assert.doesNotMatch(html, /aria-label="Change Old prompt"/, 'a legacy prompt is not edited here');
  assert.match(html, /aria-label="Delete Old prompt"/);
  assert.match(html, /aria-label="Enable Startup"/);
});

test('one create button for flows: + New flow; Set up builds none', () => {
  const { bridge } = fakeBridge();
  const html = renderToStaticMarkup(
    <FlowsShelfView flows={[startup, mine]} selectedId="a" onSelect={() => {}} stewardOpen={false} onStewardOpen={() => {}} onNew={() => {}}
      onSetupOpen={() => {}} setupOpen bridge={bridge} onFlowsChange={() => {}} onDelete={() => {}} />,
  );
  assert.equal([...html.matchAll(/data-new-flow/g)].length, 1, 'one + New flow');
  const setup = renderToStaticMarkup(<AutomationsSection bridge={bridge} flows={[startup, mine]} selected={startup} onChange={() => {}} startNew />);
  assert.doesNotMatch(setup, /data-new-flow|data-palette|New flow</, 'no flow is built in Set up');
  assert.match(html, /data-delete-flow="a"/, 'a flow is deleted on the shelf');
});

test('Run now calls the run path, and is held with the reason only while that flow runs', async () => {
  const { bridge, calls } = fakeBridge();
  const r = await runFlow(bridge, 's1');
  assert.deepEqual(calls, [['run', 's1']], 'schedules:run, the path the scheduler takes');
  assert.equal(r.ok, true);
  assert.equal(runBlocked(schedule({})), null);
  assert.match(runBlocked(schedule({ running: true }))!, /running now/);
  assert.match(runBlocked(schedule({ pending: { label: "Steward's run r1", until: 0 } }))!, /waiting on Steward's run r1/);
  assert.match(runBlocked(null)!, /Pick a flow/);
  // 2026-11-08: a conversation with Steward held every Run now, and no flow started; nothing but its own run holds it
  assert.equal(runBlocked.length, 1, 'no busy argument');
  assert.doesNotMatch(readFileSync(new URL('../components/FlowsShelf.tsx', import.meta.url), 'utf8'), /stewardBusy|schedules\.busy/);
  // the shelf's Run now is wired to it
  assert.match(readFileSync(new URL('../components/FlowsShelf.tsx', import.meta.url), 'utf8'), /await runFlow\(schedules, id\)/);
});

test('the shelf shows Run now, the last run and the cards running, done or failed', () => {
  const flows = [
    schedule({ id: 'a', name: 'Startup', steps: ['repo_log'], lastRun: Date.UTC(2026, 10, 5), lastResult: 'ok' }),
    schedule({ id: 'b', name: 'Night', prompt: 'x', backend: 'steward', running: true }),
    schedule({ id: 'c', name: 'Broken', prompt: 'x', backend: 'steward', lastRun: 1, lastResult: 'Failed: down' }),
  ];
  const view = (selectedId: string) =>
    renderToStaticMarkup(<FlowsShelfView flows={flows} selectedId={selectedId} onSelect={() => {}} stewardOpen={false} onStewardOpen={() => {}} onRun={() => {}} />);
  const a = view('a');
  assert.match(a, /data-run="a"/);
  assert.ok(!/data-run="a"[^>]* disabled=""/.test(a), 'Run now is ready');
  assert.match(a, /last run: ok · /);
  assert.deepEqual([...a.matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]), ['done', 'done']);
  const b = view('b');
  assert.match(b, /data-run="b"[^>]* disabled=""/, 'held while it runs');
  assert.match(b, /It is running now/);
  assert.deepEqual([...new Set([...b.matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]))], ['running']);
  const c = view('c');
  assert.deepEqual([...new Set([...c.matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]))], ['failed']);
  // a failed run says why on the flow, in plain words: the first line of its error
  assert.match(c, /data-failed="c"[^>]*>Last run failed: (<!-- -->)?down</);
  assert.match(c, /failed: down · /);
  assert.ok(!/data-run="c"[^>]* disabled=""/.test(c), 'a failed run does not hold Run now');
  assert.ok(!/data-failed/.test(a), 'nothing failed on a flow that ran ok');
});

test("a failed run's reason is the first line of its error, without the Failed: prefix", () => {
  const failed = schedule({ lastRun: 1, lastResult: 'Failed: eval_start: evals.py --transport: a host transport runs an asks set (small, heldout) only; bfcl must run in-process.\nmore' });
  assert.equal(failedReason(failed), 'eval_start: evals.py --transport: a host transport runs an asks set (small, heldout) only; bfcl must run in-process.');
  assert.equal(failedReason(schedule({ lastRun: 1, lastResult: 'ok' })), null);
  assert.equal(failedReason(schedule({ lastRun: 1, lastResult: 'skipped: Steward busy' })), 'skipped: Steward busy');
  assert.equal(failedReason(schedule({ lastRun: 1, lastResult: 'Failed: x', running: true })), null, 'a run going now has no failure yet');
  assert.equal(failedReason(schedule({})), null, 'never run');
});

test('Set up folds out on the shelf like the Phone view, holds the automations, and shows what was refused', () => {
  const { bridge } = fakeBridge();
  const props = { flows: [startup], selectedId: 'a', onSelect: () => {}, stewardOpen: false, onStewardOpen: () => {}, onSetupOpen: () => {}, bridge, onFlowsChange: () => {} };
  const folded = renderToStaticMarkup(<FlowsShelfView {...props} />);
  assert.match(folded, /Set up/);
  assert.ok(!folded.includes('aria-label="Automations"'), 'folded until opened');
  const open = renderToStaticMarkup(<FlowsShelfView {...props} setupOpen />);
  assert.match(open, /aria-label="Automations"/);
  assert.match(open, /aria-label="Delete Startup"/);
  const fresh = renderToStaticMarkup(<AutomationsSection bridge={bridge} flows={[startup]} selected={null} onChange={() => {}} startNew initialError={'bad time "25:00" (use HH:MM, 24-hour)'} />);
  assert.match(fresh, /New automation/);
  assert.match(fresh, /Add automation/);
  assert.match(fresh, /role="alert"[^>]*>bad time &quot;25:00&quot;/, 'the check shows inline');
  for (const t of ['Every day', 'Weekdays', 'Once a week', 'Every few hours or minutes', 'Once']) assert.ok(fresh.includes(t), t);
});

test('the automations form is on the Flows shelf only: not in Settings, not on the console', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../components/FlowsShelf.tsx'), /<AutomationsSection /);
  assert.ok(!/<AutomationsSection\b/.test(read('../components/SettingsModal.tsx')));
  assert.ok(!/<AutomationsSection\b/.test(read('../components/AgentConsole.tsx')));
});
