import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CARD, COLUMN, LIVE_POLLS, ROW, WRAP, flowGraph, flowGraphFromMaf, flowRunState, keepPolling, lastResultLine, msLabel, runLine, stepFor } from './flowGraph.ts';
import { FLOWS_STEWARD_OPEN_KEY, keepPanel, panelOpen } from './agentConsole.ts';
import { FlowsShelfView, OPEN_VIEW, openViewport } from '../components/FlowsShelf.tsx';
import type { FlowRun, MafWorkflowDict, ScheduleView } from '../types/desktop.ts';

// The Flows shelf, piece 1 (the operator, 2026-11-05; plan-the-flows-shelf-ide-for-steward-s-f-04a93a): the flows
// listed, the open one drawn as block cards wired output to input, from flowGraph (the seam piece 2 moves to MAF).

const schedule = (over: Partial<ScheduleView>): ScheduleView => ({
  id: 's1',
  name: 'Morning',
  prompt: '',
  whenText: 'daily 08:30',
  whenLabel: 'every day at 08:30',
  deliver: ['note'],
  enabled: true,
  next: null,
  lastRun: null,
  lastResult: null,
  ...over,
});

const wires = (g: ReturnType<typeof flowGraph>) => g.edges.map((e) => `${e.source}->${e.target}`);

test('a recipe is its gather steps in a line, then summarize, then each delivery', () => {
  const g = flowGraph({ prompt: '', steps: ['repo_log', { step: 'merged_prs', repo: 'jesster' }], summarize: 'Say what moved', deliver: ['note', 'telegram'] });
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.kind, n.label]),
    [
      ['step-0', 'step', 'repo_log'],
      ['step-1', 'step', 'merged_prs'],
      ['summarize', 'summarize', 'Steward: summarize'],
      ['deliver-note', 'deliver', 'note'],
      ['deliver-telegram', 'deliver', 'telegram'],
    ],
  );
  assert.equal(g.nodes[1].detail, 'repo: jesster', "a step's arguments are its detail");
  assert.equal(g.nodes[2].detail, 'Say what moved');
  assert.deepEqual(wires(g), ['step-0->step-1', 'step-1->summarize', 'summarize->deliver-note', 'summarize->deliver-telegram']);
  // along a row the wire runs side to side; from one band to the next, bottom to top
  assert.deepEqual([g.edges[0].sourceHandle, g.edges[0].targetHandle], ['right', 'left']);
  assert.deepEqual([g.edges[1].sourceHandle, g.edges[1].targetHandle], ['bottom', 'top']);
  // a recipe with no summarize delivers from its last step
  assert.deepEqual(wires(flowGraph({ prompt: '', steps: ['versions'], deliver: ['note'] })), ['step-0->deliver-note']);
});

test('a schedule with only a prompt is one turn, then the note', () => {
  const g = flowGraph({ prompt: 'Check the bar', backend: 'steward', deliver: ['note'] });
  assert.deepEqual(g.nodes.map((n) => [n.id, n.kind, n.label]), [['turn', 'turn', 'Steward: Check the bar'], ['deliver-note', 'deliver', 'note']]);
  assert.deepEqual(wires(g), ['turn->deliver-note']);
  assert.equal(flowGraph({ prompt: 'x', deliver: [] }).nodes.at(-1)?.label, 'note', 'no delivery named: the note');
  assert.match(flowGraph({ prompt: 'x', backend: 'local', deliver: ['note'] }).nodes[0].label, /^Agent: x/);
});

test('the layout is layered and wrapped: rows of readable cards on an even grid, never one endless line', () => {
  // Startup's recipe: seven steps, summarize, two deliveries
  const steps = ['pull_ff', 'versions', 'repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left'];
  const g = flowGraph({ prompt: '', steps, summarize: 'Write it up', deliver: ['note', 'telegram'] });
  const pos = Object.fromEntries(g.nodes.map((n) => [n.id, n.position]));
  // bounded across: at most WRAP cards wide, whatever the length
  for (const n of g.nodes) assert.ok(n.position.x >= 0 && n.position.x <= (WRAP - 1) * COLUMN, `${n.id} within the band`);
  // the steps wrap like text: rows of WRAP, each row below the last
  const stepRows = [...new Set(steps.map((_, i) => pos[`step-${i}`].y))];
  assert.deepEqual(stepRows, [0, ROW, 2 * ROW]);
  assert.deepEqual([0, 1, 2].map((i) => pos[`step-${i}`].x), [0, COLUMN, 2 * COLUMN], 'the first row reads left to right');
  // then the layers below: summarize, then the deliveries
  assert.ok(pos.summarize.y > Math.max(...stepRows), 'summarize under the steps');
  assert.ok(pos['deliver-note'].y > pos.summarize.y && pos['deliver-note'].y === pos['deliver-telegram'].y, 'deliveries share the band under it');
  assert.equal(pos.summarize.x, COLUMN, 'a lone card is centred');
  // on the grid (columns, half columns for centring; rows), and no two cards overlap at their fixed size
  for (const n of g.nodes) {
    assert.equal(n.position.x % (COLUMN / 2), 0, `${n.id} on the grid`);
    assert.equal(n.position.y % ROW, 0, `${n.id} on a row`);
  }
  for (const a of g.nodes)
    for (const b of g.nodes)
      if (a !== b)
        assert.ok(
          Math.abs(a.position.x - b.position.x) >= CARD.width || Math.abs(a.position.y - b.position.y) >= CARD.height,
          `${a.id} and ${b.id} do not overlap`,
        );
  // readable: cards are a fixed size with even gaps between them
  assert.ok(CARD.width >= 220 && CARD.height >= 96, 'cards are big enough to read');
  assert.ok(COLUMN - CARD.width >= 40 && ROW - CARD.height >= 40, 'even gaps for the wires');
  // the canvas opens at a readable zoom on the first blocks, not shrunk to fit them all
  const view = openViewport(g.nodes);
  assert.deepEqual(view, { x: OPEN_VIEW.margin, y: OPEN_VIEW.margin, zoom: 1 });
  const lone = flowGraph({ prompt: 'x', deliver: ['note'] });
  assert.equal(openViewport(lone.nodes).zoom, 1);
});

test("a flow's run state is read off the schedule: running, done or failed", () => {
  assert.equal(flowRunState(schedule({})), 'idle');
  assert.equal(flowRunState(schedule({ running: true })), 'running');
  assert.equal(flowRunState(schedule({ pending: { label: "Steward's run r1", until: 0 } })), 'running');
  assert.equal(flowRunState(schedule({ lastRun: 1, lastResult: 'ok' })), 'done');
  assert.equal(flowRunState(schedule({ lastRun: 1, lastResult: 'skipped: Steward busy' })), 'failed');
  assert.equal(lastResultLine(schedule({ pending: { label: "Steward's run r1", until: 0 } })), "waiting on Steward's run r1");
});

test("the list says each flow's last result", () => {
  assert.equal(lastResultLine(schedule({})), 'not run yet');
  assert.equal(lastResultLine(schedule({ running: true })), 'running now');
  assert.equal(lastResultLine(schedule({ pending: { tag: 'bar-1', until: 0 } })), 'waiting on bar-1');
  assert.match(lastResultLine(schedule({ lastRun: Date.UTC(2026, 10, 5), lastResult: 'ok' })), /^ok · /);
  assert.match(lastResultLine(schedule({ lastRun: Date.UTC(2026, 10, 5), lastResult: 'Steward is down' })), /^Steward is down · /);
});

test("Steward's card on the shelf is folded until opened, and remembered", () => {
  const kept = new Map<string, string>();
  const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  assert.equal(panelOpen(store, FLOWS_STEWARD_OPEN_KEY, false), false, 'closed the first time');
  keepPanel(store, FLOWS_STEWARD_OPEN_KEY, true);
  assert.equal(panelOpen(store, FLOWS_STEWARD_OPEN_KEY, false), true, 'open stays open');
});

test('the shelf renders the list and the open flow on the canvas, block by block', () => {
  const flows = [
    schedule({ id: 'a', name: 'Morning digest', steps: ['repo_log', 'releases'], summarize: 'Digest it', lastRun: Date.UTC(2026, 10, 5), lastResult: 'ok' }),
    schedule({ id: 'b', name: 'Bar check', prompt: 'Check the bar', backend: 'steward' }),
  ];
  const html = renderToStaticMarkup(
    <FlowsShelfView flows={flows} selectedId="a" onSelect={() => {}} stewardOpen={false} onStewardOpen={() => {}} />,
  );
  for (const f of flows) assert.ok(html.includes(`data-flow="${f.id}"`), `${f.name} is listed`);
  assert.match(html, /Morning digest/);
  assert.match(html, /not run yet/, "a flow's last result is in the list");
  assert.match(html, /aria-label="Flow canvas"/);
  assert.match(html, /react-flow/, 'the canvas is drawn');
  const blocks = [...html.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(blocks, ['step', 'step', 'summarize', 'deliver'], 'one card per block of the open flow');
  assert.match(html, /Steward: summarize/);
  assert.ok(!html.includes('aria-label="Steward"'), "Steward's card is folded");
  assert.ok(!html.includes('data-run='), 'no Run now without a run path');

  const open = renderToStaticMarkup(<FlowsShelfView flows={flows} selectedId="b" onSelect={() => {}} stewardOpen onStewardOpen={() => {}} />);
  assert.deepEqual([...open.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]), ['turn', 'deliver']);
  assert.match(open, /aria-label="Steward"/, "opened, Steward's card is there");
});

// ---- piece 2 (ADR-0008, 2026-11-05): the graph from Steward's MAF workflow, and the run history ------------------------

/** Steward's recipe_graph for { steps: ['repo_log', { step: 'eval_start', ... }], summarize }, as MAF's to_dict() gave it. */
const TO_DICT: MafWorkflowDict = {
  name: 'recipe_night',
  start_executor_id: 'begin',
  edge_groups: [
    { id: 'InternalEdgeGroup/1', type: 'InternalEdgeGroup', edges: [{ source_id: 'internal:begin', target_id: 'begin' }] },
    { id: 'InternalEdgeGroup/2', type: 'InternalEdgeGroup', edges: [{ source_id: 'internal:1_repo_log', target_id: '1_repo_log' }] },
    { id: 'SingleEdgeGroup/3', type: 'SingleEdgeGroup', edges: [{ source_id: 'begin', target_id: '1_repo_log' }] },
    { id: 'SingleEdgeGroup/4', type: 'SingleEdgeGroup', edges: [{ source_id: '1_repo_log', target_id: '2_eval_start' }] },
    { id: 'SingleEdgeGroup/5', type: 'SingleEdgeGroup', edges: [{ source_id: '2_eval_start', target_id: 'summarize' }] },
    { id: 'SingleEdgeGroup/6', type: 'SingleEdgeGroup', edges: [{ source_id: 'summarize', target_id: 'deliver' }] },
  ],
  // MAF's own order is not the run's: the canvas follows the edges from start_executor_id
  executors: {
    deliver: { id: 'deliver', type: 'Deliver' },
    begin: { id: 'begin', type: 'Begin' },
    '2_eval_start': { id: '2_eval_start', type: 'GatherStep' },
    '1_repo_log': { id: '1_repo_log', type: 'GatherStep' },
    summarize: { id: 'summarize', type: 'Summarize' },
  },
  output_executors: ['deliver'],
};
const NIGHT = { prompt: '', steps: ['repo_log', { step: 'eval_start', sets: ['aider-py'] }], summarize: 'Say how the bar did', deliver: ['note', 'telegram'] };

/** Steward's recipe_runs for that flow (step_states over each run's MAF event log). */
const RUNS: FlowRun[] = [
  {
    run_id: 'r2', flow: 'n', trigger: 'now', state: 'done', ok: false, short: 'Failed: An eval is running now', started: '2026-11-05T22:00:00+00:00', ended: '2026-11-05T22:00:02+00:00',
    steps: [
      { id: 'begin', step: 'begin', state: 'done', ms: 2, ok: true },
      { id: '1_repo_log', step: 'repo_log', state: 'done', ms: 840, ok: true },
      { id: '2_eval_start', step: 'eval_start', state: 'failed', ms: 1250, ok: false, error: 'An eval is running now' },
      { id: 'summarize', step: 'summarize', state: 'skipped', ms: null, ok: false },
      { id: 'deliver', step: 'deliver', state: 'done', ms: 3, ok: true },
    ],
  },
  { run_id: 'r1', flow: 'n', trigger: 'schedule', state: 'done', ok: true, started: '2026-11-04T23:00:00+00:00', ended: '2026-11-04T23:40:00+00:00', steps: [] },
];

const blocksOf = (html: string) => [...html.matchAll(/data-block="([a-z]+)" data-state="([a-z]+)"/g)].map((m) => [m[1], m[2]]);

test("the canvas is drawn from Steward's MAF workflow: one card per executor in run order, MAF's wires, the recipe's words", () => {
  const g = flowGraphFromMaf(TO_DICT, NIGHT);
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.kind, n.label]),
    [
      ['begin', 'begin', 'begin'],
      ['1_repo_log', 'step', 'repo_log'],
      ['2_eval_start', 'step', 'eval_start'],
      ['summarize', 'summarize', 'Steward: summarize'],
      ['deliver', 'deliver', 'note, telegram'],
    ],
  );
  assert.equal(g.nodes[2].detail, 'sets: ["aider-py"]', "a gather step's arguments, from the recipe");
  assert.equal(g.nodes[3].detail, 'Say how the bar did');
  assert.deepEqual(wires(g), ['begin->1_repo_log', '1_repo_log->2_eval_start', '2_eval_start->summarize', 'summarize->deliver'], 'internal edges are left out');
  // the same grid as the local drawing: bands of one kind, side to side along a row, bottom to top between rows
  const pos = Object.fromEntries(g.nodes.map((n) => [n.id, n.position]));
  assert.deepEqual([pos.begin.y, pos['1_repo_log'].y, pos['2_eval_start'].y, pos.summarize.y, pos.deliver.y], [0, ROW, ROW, 2 * ROW, 3 * ROW]);
  assert.deepEqual([g.edges[1].sourceHandle, g.edges[1].targetHandle], ['right', 'left']);
  assert.deepEqual([g.edges[0].sourceHandle, g.edges[0].targetHandle], ['bottom', 'top']);
  for (const n of g.nodes) assert.ok(n.position.x % (COLUMN / 2) === 0 && n.position.x >= 0 && n.position.x <= (WRAP - 1) * COLUMN, `${n.id} on the grid`);
  // seven gather steps wrap at WRAP as the local drawing does
  const seven = ['pull_ff', 'versions', 'repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left'];
  const wide: MafWorkflowDict = {
    start_executor_id: 'begin',
    executors: Object.fromEntries([['begin', 'Begin'], ...seven.map((s, i) => [`${i + 1}_${s}`, 'GatherStep']), ['deliver', 'Deliver']].map(([id, type]) => [id, { id, type }])),
    edge_groups: [['begin', '1_pull_ff'], ...seven.slice(1).map((s, i) => [`${i + 1}_${seven[i]}`, `${i + 2}_${s}`]), ['7_plan_left', 'deliver']].map(([a, b]) => ({ type: 'SingleEdgeGroup', edges: [{ source_id: a, target_id: b }] })),
  };
  assert.deepEqual([...new Set(flowGraphFromMaf(wide, { prompt: '', steps: seven, deliver: ['note'] }).nodes.filter((n) => n.kind === 'step').map((n) => n.position.y))], [ROW, 2 * ROW, 3 * ROW]);
});

test("the shelf draws the open flow from MAF when Steward answers, and locally, saying so, when his host is down", () => {
  const flows = [schedule({ id: 'n', name: 'Night', ...NIGHT })];
  const props = { flows, selectedId: 'n', onSelect: () => {}, stewardOpen: false, onStewardOpen: () => {} };
  const maf = renderToStaticMarkup(<FlowsShelfView {...props} graph={{ workflow: TO_DICT }} />);
  assert.match(maf, /data-graph="maf"/);
  assert.deepEqual([...maf.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]), ['begin', 'step', 'step', 'summarize', 'deliver']);
  assert.ok(!maf.includes('offline: drawn locally'));
  const down = renderToStaticMarkup(<FlowsShelfView {...props} graph="offline" />);
  assert.match(down, /data-graph="local"/);
  assert.match(down, /offline: drawn locally/);
  assert.deepEqual([...down.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]), ['step', 'step', 'summarize', 'deliver', 'deliver'], "the recipe's own shape");
  // a legacy prompt-only schedule has no MAF workflow: drawn locally, with no note
  const legacy = renderToStaticMarkup(<FlowsShelfView {...props} flows={[schedule({ id: 'n', prompt: 'hi', backend: 'steward' })]} graph="offline" />);
  assert.ok(!legacy.includes('offline: drawn locally'));
});

test("the open flow's runs are listed under it; a click lights each block with that run's step: done, failed, skipped, ms", () => {
  const flows = [schedule({ id: 'n', name: 'Night', ...NIGHT })];
  const props = { flows, selectedId: 'n', onSelect: () => {}, stewardOpen: false, onStewardOpen: () => {}, graph: { workflow: TO_DICT }, runs: RUNS };
  const list = renderToStaticMarkup(<FlowsShelfView {...props} />);
  assert.deepEqual([...list.matchAll(/data-run-id="([^"]+)" data-run-state="([a-z]+)"/g)].map((m) => [m[1], m[2]]), [['r2', 'failed'], ['r1', 'done']], 'newest first');
  assert.match(list, /not ok · Run now · .* · 2\.0 s/);
  assert.match(list, /ok · scheduled · .* · 40 min/);
  assert.ok(blocksOf(list).every(([, s]) => s === 'idle'), 'no run picked: the flow as the schedule carries it');

  const lit = renderToStaticMarkup(<FlowsShelfView {...props} selectedRun="r2" />);
  assert.deepEqual(blocksOf(lit), [['begin', 'done'], ['step', 'done'], ['step', 'failed'], ['summarize', 'skipped'], ['deliver', 'done']]);
  assert.match(lit, /failed · 1\.3 s/);
  assert.match(lit, /done · 840 ms/);
  assert.match(lit, /showing run: not ok · Run now/);

  // the same run on the local drawing, his host down: each card finds its step by its place in the recipe
  const local = renderToStaticMarkup(<FlowsShelfView {...props} graph="offline" selectedRun="r2" />);
  assert.deepEqual(blocksOf(local), [['step', 'done'], ['step', 'failed'], ['summarize', 'skipped'], ['deliver', 'done'], ['deliver', 'done']]);
  assert.equal(stepFor('step-1', RUNS[0].steps)?.id, '2_eval_start');
  assert.equal(stepFor('deliver-telegram', RUNS[0].steps)?.id, 'deliver');

  // live: the run going now lights the blocks until it is filed
  const going: FlowRun = { run_id: 'r3', state: 'running', steps: [{ id: 'begin', step: 'begin', state: 'done', ms: 1, ok: true }, { id: '1_repo_log', step: 'repo_log', state: 'running', ms: null, ok: false }, { id: '2_eval_start', step: 'eval_start', state: 'waiting', ms: null, ok: false }] };
  const live = renderToStaticMarkup(<FlowsShelfView {...props} liveRun={going} />);
  assert.deepEqual(blocksOf(live).slice(0, 3), [['begin', 'done'], ['step', 'running'], ['step', 'waiting']]);
  // the history when Steward's host is down
  const err = renderToStaticMarkup(<FlowsShelfView {...props} runs={null} runsError="Runs: Steward's host did not answer." />);
  assert.match(err, /Runs: Steward(&#x27;|')s host did not answer\./);
});

test('the live canvas is read while its run goes, and stops: when it ends, at its deadline, or after LIVE_POLLS reads', () => {
  assert.equal(keepPolling({ state: 'running' }, 1, 10, 20), true);
  assert.equal(keepPolling(null, 1, 10, 20), true, 'not read yet (or his host missed one): read again');
  assert.equal(keepPolling({ state: 'done' }, 1, 10, 20), false);
  assert.equal(keepPolling({ state: 'failed' }, 1, 10, 20), false);
  assert.equal(keepPolling({ state: 'running' }, 1, 30, 20), false, 'past the deadline');
  assert.equal(keepPolling({ state: 'running' }, LIVE_POLLS, 10), false, 'bounded');
  assert.deepEqual([msLabel(840), msLabel(1250), msLabel(2400000), msLabel(null)], ['840 ms', '1.3 s', '40 min', '']);
  assert.match(runLine({ run_id: 'x', state: 'failed', error: 'TimeoutError', steps: [] }), /^failed: TimeoutError/);
});
