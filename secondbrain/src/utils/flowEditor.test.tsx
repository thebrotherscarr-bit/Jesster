import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as flowEditor from './flowEditor.ts';
import { BLOCKS, EdGraph, EdNode, KINDS, graphToRecipe, recipeToGraph, saveSpec } from './flowEditor.ts';
import { automationFormOf, saveAutomation } from './flowSetup.ts';
import { FlowsShelfView, knownSets } from '../components/FlowsShelf.tsx';
import { FlowEditor } from '../components/FlowEditor.tsx';
import { AutomationsSection } from '../components/settings/AutomationsSection.tsx';
import type { ScheduleView, SchedulesBridge } from '../types/desktop.ts';

// The Flows shelf's editor (the operator, 2026-11-05: "I don't have a way to create my own flows", and "the old graph
// had like pieces where i could wire it together with a legend of what each piece did").
const require = createRequire(import.meta.url);
const workflows = require('../../electron/agent/workflows.cjs');
const flowExamples = require('../../electron/agent/flowExamples.cjs');

const at = { x: 0, y: 0 };
const n = (id: string, block: EdNode['block'], extra: Partial<EdNode> = {}): EdNode => ({ id, block, position: at, ...extra });
const w = (...pairs: [string, string][]) => pairs.map(([source, target]) => ({ id: `${source}->${target}`, source, target }));
const refused = (g: EdGraph, why: RegExp) => {
  const r = graphToRecipe(g);
  assert.equal(r.ok, false, `refused: ${why}`);
  if (!r.ok) assert.match(r.error, why);
};

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

test('the palette is every fixed step, Summarize, Note and Telegram, each with a kind and one line of what it does', () => {
  const steps = BLOCKS.filter((b) => b.kind === 'gather' || b.kind === 'eval').map((b) => b.id).sort();
  assert.deepEqual(steps, [...workflows.STEPS].sort(), "the palette's steps are workflows.cjs STEPS");
  assert.deepEqual(BLOCKS.filter((b) => b.kind !== 'gather' && b.kind !== 'eval').map((b) => b.id), ['summarize', 'note', 'telegram']);
  for (const b of BLOCKS) assert.ok(b.what.length > 10 && KINDS[b.kind], b.id);
});

test('graph → recipe: the gather blocks in wire order, one summarize, then where it goes', () => {
  // laid out in any order: the wires say the order
  const g: EdGraph = {
    nodes: [n('t', 'telegram'), n('b', 'repo_log'), n('s', 'summarize', { prompt: ' Say what moved ' }), n('a', 'versions'), n('e', 'eval_start', { set: 'small, steps', runs: 2 }), n('note', 'note')],
    edges: w(['a', 'e'], ['e', 'b'], ['b', 's'], ['s', 'note'], ['s', 't']),
  };
  const r = graphToRecipe(g);
  assert.deepEqual(r, { ok: true, recipe: { steps: ['versions', { step: 'eval_start', sets: ['small', 'steps'], runs: 2 }, 'repo_log'], summarize: 'Say what moved', deliver: ['note', 'telegram'] } });
  if (r.ok) assert.doesNotThrow(() => workflows.validateSteps(r.recipe.steps), 'what Save sends, validateSteps takes');
  // no summarize: the deliveries hang off the last gather block
  assert.deepEqual(graphToRecipe({ nodes: [n('a', 'versions'), n('d', 'note')], edges: w(['a', 'd']) }), { ok: true, recipe: { steps: ['versions'], deliver: ['note'] } });
});

test('graph → recipe refuses, in plain words, what cannot be a recipe', () => {
  refused({ nodes: [], edges: [] }, /empty/);
  refused({ nodes: [n('s', 'summarize', { prompt: 'x' }), n('d', 'note')], edges: w(['s', 'd']) }, /at least one gather/);
  refused({ nodes: [n('a', 'versions')], edges: [] }, /Note or a Telegram/);
  refused({ nodes: [n('a', 'versions'), n('s1', 'summarize', { prompt: 'x' }), n('s2', 'summarize', { prompt: 'y' }), n('d', 'note')], edges: w(['a', 's1'], ['s1', 's2'], ['s2', 'd']) }, /two Summarize/);
  refused({ nodes: [n('a', 'versions'), n('b', 'repo_log'), n('d', 'note')], edges: w(['a', 'b'], ['b', 'a'], ['b', 'd']) }, /loop/);
  refused({ nodes: [n('a', 'versions'), n('d', 'note')], edges: w(['a', 'a'], ['a', 'd']) }, /loop/);
  // deliver before gather
  refused({ nodes: [n('d', 'note'), n('a', 'versions'), n('t', 'telegram')], edges: w(['d', 'a'], ['a', 't']) }, /Note is wired on to Versions: a delivery ends the flow/);
  refused({ nodes: [n('a', 'versions'), n('s', 'summarize', { prompt: 'x' }), n('b', 'repo_log'), n('d', 'note')], edges: w(['a', 's'], ['s', 'b'], ['b', 'd']) }, /Summarize comes after every gather/);
  refused({ nodes: [n('a', 'versions'), n('b', 'repo_log'), n('d', 'note')], edges: w(['a', 'd']) }, /Repo log is not wired in/);
  refused({ nodes: [n('a', 'versions'), n('b', 'repo_log'), n('c', 'releases'), n('d', 'note')], edges: w(['a', 'b'], ['a', 'c'], ['b', 'd']) }, /2 wires out to the next steps/);
  refused({ nodes: [n('a', 'versions'), n('b', 'repo_log'), n('c', 'releases'), n('d', 'note')], edges: w(['a', 'c'], ['b', 'c'], ['c', 'd']) }, /2 wires in/);
  refused({ nodes: [n('a', 'versions'), n('b', 'repo_log'), n('d', 'note')], edges: w(['a', 'b'], ['a', 'd']) }, /deliveries cannot hang off it/);
  refused({ nodes: [n('a', 'versions'), n('s', 'summarize', { prompt: 'x' }), n('d', 'note')], edges: w(['a', 'd']) }, /not wired in|Summarize is not wired/);
  refused({ nodes: [n('a', 'versions'), n('s', 'summarize', { prompt: '' }), n('d', 'note')], edges: w(['a', 's'], ['s', 'd']) }, /Summarize needs a prompt/);
  refused({ nodes: [n('e', 'eval_start', { set: '', runs: 1 }), n('d', 'note')], edges: w(['e', 'd']) }, /Eval set needs a set/);
  refused({ nodes: [n('a', 'versions'), n('d', 'note'), n('d2', 'note')], edges: w(['a', 'd'], ['a', 'd2']) }, /two Note blocks/);
});

test('recipe → graph → recipe: a saved flow opens on the canvas as it was saved (every example too)', () => {
  const recipes = [
    { steps: ['pull_ff', 'versions', 'repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left'], summarize: 'Write the day', deliver: ['note', 'telegram'] },
    { steps: ['versions'], deliver: ['note'] },
    { steps: [{ step: 'eval_start', sets: ['small'], runs: 3 }, 'eval_wait'], deliver: ['telegram'] },
    ...flowExamples.examples([{ name: 'small', tier: 'T0' }, { name: 'aider-py', tier: 'ext' }]).map((e: { steps: unknown[]; summarize: string; deliver: string[] }) => ({ steps: e.steps, summarize: e.summarize, deliver: e.deliver })),
  ] as Pick<ScheduleView, 'steps' | 'summarize' | 'deliver'>[];
  for (const r of recipes) {
    const g = recipeToGraph(r);
    const back = graphToRecipe(g);
    assert.ok(back.ok, JSON.stringify(back));
    if (back.ok) assert.deepEqual(back.recipe, { steps: r.steps, ...(r.summarize ? { summarize: r.summarize } : {}), deliver: r.deliver });
  }
  // the stored shape (validateSteps adds transport and hours) opens and saves back to the same steps
  const stored = workflows.validateSteps([{ step: 'eval_start', sets: ['small'], runs: 1 }, 'eval_wait', 'eval_bars']);
  const back = graphToRecipe(recipeToGraph({ steps: stored, summarize: 'x', deliver: ['note'] }));
  assert.ok(back.ok);
  if (back.ok) assert.deepEqual(workflows.validateSteps(back.recipe.steps), stored);
  assert.equal(recipeToGraph({ steps: stored, deliver: ['note'] }).nodes[0].set, 'small');
});

test('Save: a new flow goes with no when (Run now only); a change keeps its when', () => {
  const recipe = { steps: ['versions'], summarize: 's', deliver: ['note'] };
  assert.deepEqual(saveSpec(' Mine ', recipe, true), { name: 'Mine', backend: 'steward', steps: ['versions'], summarize: 's', deliver: ['note'], prompt: '', when: '' });
  assert.equal('when' in saveSpec('Mine', recipe, false), false);
});

test('the shelf: + New flow at the top of the list; examples and legacy prompts badged; Edit blocks and Duplicate on a flow with steps', () => {
  const flows = [
    schedule({ id: 'a', name: 'Eval: aider-py', whenText: '', whenLabel: 'only on Run now', tags: ['example', 'eval', 'ext'], steps: [{ step: 'eval_start', sets: ['aider-py'], runs: 1 }, 'eval_wait'] }),
    schedule({ id: 'b', name: 'Ask', prompt: 'hi', backend: 'steward' }),
  ];
  const html = renderToStaticMarkup(
    <FlowsShelfView flows={flows} selectedId="a" onSelect={() => {}} stewardOpen={false} onStewardOpen={() => {}} onRun={() => {}} onNew={() => {}} onEdit={() => {}} onDuplicate={() => {}} />,
  );
  assert.match(html, /data-new-flow[^>]*>.*New flow/);
  assert.match(html, /data-badge="example"/);
  assert.doesNotMatch(html, /data-badge="night"/);
  assert.match(html, /data-badge="legacy"/, 'a prompt-only schedule is legacy');
  assert.match(html, /data-edit="a"/);
  assert.match(html, /data-duplicate="a"/);
  const prompt = renderToStaticMarkup(<FlowsShelfView flows={flows} selectedId="b" onSelect={() => {}} stewardOpen={false} onStewardOpen={() => {}} onEdit={() => {}} />);
  assert.doesNotMatch(prompt, /data-edit=/, 'a prompt-only automation has no blocks to edit');
  assert.deepEqual(knownSets(flows), ['aider-py']);
});

test('ADR-0009: an eval flow runs whenever he says; no night badge and no daytime question', () => {
  const flows = [schedule({ id: 'a', name: 'Eval: aider-py', tags: ['example', 'eval'], steps: [{ step: 'eval_start', sets: ['aider-py'], runs: 1 }, 'eval_wait'] })];
  const html = renderToStaticMarkup(<FlowsShelfView flows={flows} selectedId="a" onSelect={() => {}} stewardOpen={false} onStewardOpen={() => {}} onRun={() => {}} />);
  assert.match(html, /data-run="a"/);
  assert.ok(!/data-run="a"[^>]* disabled=""/.test(html), 'Run now is ready, day or night');
  assert.doesNotMatch(html, /data-ask-night|data-badge="night"|takes hours|run now anyway/i);
  assert.ok(!('isDaytime' in flowEditor) && !('DAY_HOURS' in flowEditor), 'no daytime rule left');
  const src = readFileSync(new URL('../components/FlowsShelf.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /askNight|isDaytime|daytime=|\.night\b/, 'Run now is not held by the hour');
});

test('the editor: the palette is the legend (each block and what it does, the kinds\' colours), the canvas, Save', () => {
  const html = renderToStaticMarkup(
    <FlowEditor initial={recipeToGraph({ steps: ['versions'], summarize: 'x', deliver: ['note'] })} name="Mine" isNew sets={['small']} onSave={async () => null} onCancel={() => {}} initialError="Summarize is not wired after Versions." />,
  );
  for (const b of BLOCKS) {
    assert.match(html, new RegExp(`data-palette="${b.id}"`));
    assert.ok(html.includes(b.what.replace(/'/g, '&#x27;')), `${b.id}'s line is shown, not only on hover`);
  }
  assert.match(html, /aria-label="Legend"/);
  for (const k of Object.values(KINDS)) assert.ok(html.includes(k.title));
  assert.match(html, /data-save-flow/);
  assert.match(html, /role="alert"[^>]*>Summarize is not wired after Versions\./, 'why it cannot save, inline');
  assert.match(html, /value="Mine"/);
});

test('Set up schedules a canvas flow and keeps its blocks whole: only the when and on/off are sent', async () => {
  const calls: unknown[][] = [];
  const bridge = {
    list: async () => [], add: async () => [], remove: async () => [], run: async () => ({ note: '', ok: true, schedules: [] }),
    update: async (...a: unknown[]) => (calls.push(['update', ...a]), []), edit: async (...a: unknown[]) => (calls.push(['edit', ...a]), []),
  } as unknown as SchedulesBridge;
  const canvas = schedule({ steps: workflows.validateSteps([{ step: 'eval_start', sets: ['small'], runs: 1 }, 'eval_wait', 'eval_bars']), summarize: 'x', whenText: '' });
  await saveAutomation(bridge, { ...automationFormOf(canvas), whenKind: 'daily', time: '02:00' }, null);
  assert.deepEqual(calls, [['edit', 's1', { when: 'daily 02:00' }], ['update', 's1', { enabled: true }]], 'no steps or summarize sent: the blocks stay');
  const html = renderToStaticMarkup(<AutomationsSection bridge={bridge} flows={[canvas]} selected={canvas} onChange={() => {}} startNew />);
  assert.match(html, /data-new-automation/);
});
