import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CARD, COLUMN, ROW, WRAP, flowGraph, flowRunState, lastResultLine } from './flowGraph.ts';
import { FLOWS_STEWARD_OPEN_KEY, keepPanel, panelOpen } from './agentConsole.ts';
import { FlowsShelfView, OPEN_VIEW, openViewport } from '../components/FlowsShelf.tsx';
import type { ScheduleView } from '../types/desktop.ts';

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
