import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { flowGraph, lastResultLine } from './flowGraph.ts';
import { FLOWS_STEWARD_OPEN_KEY, keepPanel, panelOpen } from './agentConsole.ts';
import { FlowsShelfView } from '../components/FlowsShelf.tsx';
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
  // left to right, output to input
  assert.ok(g.nodes[0].position.x < g.nodes[1].position.x && g.nodes[1].position.x < g.nodes[2].position.x);
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
  assert.ok(!/>\s*(Run now|Schedule)\s*</.test(html), 'no Run now or Schedule yet (piece 3)');

  const open = renderToStaticMarkup(<FlowsShelfView flows={flows} selectedId="b" onSelect={() => {}} stewardOpen onStewardOpen={() => {}} />);
  assert.deepEqual([...open.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]), ['turn', 'deliver']);
  assert.match(open, /aria-label="Steward"/, "opened, Steward's card is there");
});
