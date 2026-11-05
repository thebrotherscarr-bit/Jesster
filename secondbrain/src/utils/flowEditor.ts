import type { ScheduleSpec, ScheduleView } from '../types/desktop.ts';
import { flowGraph } from './flowGraph.ts';

/**
 * The Flows shelf's editor (the operator, 2026-11-05: "I don't have a way to create my own flows", and "the old graph
 * had like pieces where i could wire it together with a legend of what each piece did"): block cards from a fixed
 * palette, dropped on the canvas and wired output to input, saved as the same recipe Set up saves (schedules.cjs
 * add/edit, checked there by workflows.cjs validateSteps). A recipe is a line: the gather blocks in wire order, at most
 * one Summarize, then where it goes. graphToRecipe says, in plain words, why a graph cannot be one; recipeToGraph
 * loads a saved flow back onto the canvas.
 */

/** A block's kind, which is also its colour in the palette and its key in the legend. */
export type BlockKind = 'gather' | 'eval' | 'steward' | 'deliver';

export const KINDS: Record<BlockKind, { title: string; what: string }> = {
  gather: { title: 'Gather', what: 'reads something and adds it to what the flow has gathered' },
  eval: { title: 'Eval', what: "starts Steward's eval sets, or waits for them" },
  steward: { title: 'Steward', what: 'one turn of Steward writing from what was gathered' },
  deliver: { title: 'Deliver', what: 'where the result goes' },
};

/** The palette: the fixed steps (workflows.cjs STEPS), Summarize, and the two deliveries. */
export const BLOCKS = [
  { id: 'pull_ff', kind: 'gather', label: 'Pull main', what: 'Brings each repo current: main, fast-forward only, clean tree only.' },
  { id: 'versions', kind: 'gather', label: 'Versions', what: "Each repo's branch and head, and how far it is from origin/main." },
  { id: 'repo_log', kind: 'gather', label: 'Repo log', what: "The commits on each repo's main since the last run." },
  { id: 'merged_prs', kind: 'gather', label: 'Merged PRs', what: 'The pull requests merged in each repo since the last run.' },
  { id: 'releases', kind: 'gather', label: 'Releases', what: 'The releases of SecondBrain and Atlas since the last run.' },
  { id: 'plan_left', kind: 'gather', label: 'Plan left', what: "What is left on the plan (WHATS_LEFT.md's plan)." },
  { id: 'eval_bars', kind: 'gather', label: 'Eval bars', what: "The newest eval runs' result lines: which bars were met." },
  { id: 'eval_start', kind: 'eval', label: 'Eval set', what: 'Starts an eval set (its own window), runs times.' },
  { id: 'eval_wait', kind: 'eval', label: 'Wait for eval', what: 'Waits (up to 8 h, without holding the app) until the eval says BAR DONE.' },
  { id: 'summarize', kind: 'steward', label: 'Summarize (Steward)', what: 'Steward writes the result from what was gathered, as your prompt asks.' },
  { id: 'note', kind: 'deliver', label: 'Note', what: 'Files the result as a note (tag automation).' },
  { id: 'telegram', kind: 'deliver', label: 'Telegram', what: 'Sends a one-line result to your Telegram.' },
] as const satisfies readonly { id: string; kind: BlockKind; label: string; what: string }[];

export type BlockId = (typeof BLOCKS)[number]['id'];
export const blockOf = (id: BlockId) => BLOCKS.find((b) => b.id === id)!;

/** One block on the canvas, with its settings: an eval set's set and runs, Summarize's prompt. */
export interface EdNode {
  id: string;
  block: BlockId;
  position: { x: number; y: number };
  set?: string;
  runs?: number;
  prompt?: string;
}
export interface EdEdge {
  id: string;
  source: string;
  target: string;
  /** which dots the wire joins (the layout's; a hand-drawn wire's are React Flow's) */
  sourceHandle?: string | null;
  targetHandle?: string | null;
}
export interface EdGraph {
  nodes: EdNode[];
  edges: EdEdge[];
}

/** What a canvas saves: the recipe's part of a schedule. */
export interface Recipe {
  steps: (string | { step: string; [arg: string]: unknown })[];
  summarize?: string;
  deliver: string[];
}

export type RecipeResult = { ok: true; recipe: Recipe } | { ok: false; error: string };

/** The order a line goes in: gather and eval blocks, then Summarize, then the deliveries. */
const rank = (b: BlockId) => ({ gather: 0, eval: 0, steward: 1, deliver: 2 })[blockOf(b).kind];

let seq = 0;
/** A new block's id: unique on the canvas. */
export const newNodeId = (block: BlockId, taken: { id: string }[]) => {
  let id = '';
  do id = `${block}-${++seq}`;
  while (taken.some((n) => n.id === id));
  return id;
};

/** A new block with its default settings. */
export function newNode(block: BlockId, position: { x: number; y: number }, taken: { id: string }[]): EdNode {
  const n: EdNode = { id: newNodeId(block, taken), block, position };
  if (block === 'eval_start') return { ...n, set: '', runs: 1 };
  if (block === 'summarize') return { ...n, prompt: '' };
  return n;
}

/**
 * The canvas as a recipe, or why it cannot be one. Every check names the block it is about, so the editor can say it
 * inline: a loop, a block not wired in, two wires out of a line, two Summarize blocks, a delivery anywhere but the end.
 */
export function graphToRecipe(g: EdGraph): RecipeResult {
  const fail = (error: string): RecipeResult => ({ ok: false, error });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const name = (id: string) => blockOf(byId.get(id)!.block).label;
  if (!g.nodes.length) return fail('The canvas is empty: drag blocks from the palette on the left.');
  const edges = g.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  const gathers = g.nodes.filter((n) => rank(n.block) === 0);
  const sums = g.nodes.filter((n) => n.block === 'summarize');
  const delivers = g.nodes.filter((n) => rank(n.block) === 2);
  if (!gathers.length) return fail('A flow needs at least one gather or eval block to start from.');
  if (sums.length > 1) return fail('There are two Summarize blocks; a flow has one Steward turn. Remove one.');
  if (!delivers.length) return fail('Add where it goes: a Note or a Telegram block at the end.');
  for (const b of ['note', 'telegram'] as const) {
    if (delivers.filter((n) => n.block === b).length > 1) return fail(`There are two ${blockOf(b).label} blocks; one is enough.`);
  }
  if (edges.some((e) => e.source === e.target)) return fail(`${name(edges.find((e) => e.source === e.target)!.source)} is wired to itself: that is a loop.`);
  // a loop: Kahn's order leaves blocks over
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.target, indeg.get(e.target)! + 1);
  const queue = g.nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const e of edges.filter((x) => x.source === id)) {
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (!indeg.get(e.target)) queue.push(e.target);
    }
  }
  if (seen < g.nodes.length) return fail('The wires make a loop. A flow runs one way: gather, then summarize, then deliver.');
  for (const e of edges) {
    const [s, t] = [byId.get(e.source)!, byId.get(e.target)!];
    if (rank(s.block) === 2) return fail(`${name(s.id)} is wired on to ${name(t.id)}: a delivery ends the flow, nothing comes after it.`);
    if (rank(s.block) > rank(t.block)) return fail(`${name(s.id)} is wired on to ${name(t.id)}: Summarize comes after every gather block.`);
  }
  const ins = (id: string) => edges.filter((e) => e.target === id);
  const outs = (id: string) => edges.filter((e) => e.source === id);
  for (const n of g.nodes) {
    if (ins(n.id).length > 1) return fail(`${name(n.id)} has ${ins(n.id).length} wires in; a flow is one line, so each block takes one.`);
  }
  // the line: from the one block nothing is wired into, along one wire at a time
  const starts = g.nodes.filter((n) => !ins(n.id).length);
  if (starts.length > 1) {
    const loose = starts.find((n) => rank(n.block) !== 0) || starts[1];
    return fail(`${name(loose.id)} is not wired in. Wire it into the line, or delete it.`);
  }
  const line: EdNode[] = [];
  let at: EdNode | undefined = starts[0];
  while (at && rank(at.block) < 2) {
    line.push(at);
    const out = outs(at.id);
    const next = out.filter((e) => rank(byId.get(e.target)!.block) < 2);
    if (next.length > 1) return fail(`${name(at.id)} has ${next.length} wires out to the next steps; a flow is one line. Keep one.`);
    if (next.length && out.length > next.length) return fail(`${name(at.id)} goes on to more steps, so deliveries cannot hang off it: wire them from the end of the line.`);
    at = next.length ? byId.get(next[0].target) : undefined;
  }
  const tail = line[line.length - 1];
  if (rank(tail.block) === 0 && sums.length) return fail(`Summarize is not wired after ${name(tail.id)}. Wire the last gather block into it.`);
  const out = outs(tail.id).map((e) => byId.get(e.target)!);
  const unwired = delivers.find((d) => !out.includes(d));
  if (unwired) return fail(`${name(unwired.id)} is not wired from the end of the line (${name(tail.id)}).`);
  const steps: Recipe['steps'] = [];
  let summarize: string | undefined;
  for (const n of line) {
    if (n.block === 'summarize') {
      summarize = String(n.prompt || '').trim();
      if (!summarize) return fail('Summarize needs a prompt: click it and say what Steward should write.');
    } else if (n.block === 'eval_start') {
      const sets = String(n.set || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!sets.length) return fail('Eval set needs a set: click it and pick one.');
      steps.push({ step: 'eval_start', sets, runs: Number(n.runs) || 1 });
    } else steps.push(n.block);
  }
  const deliver = (['note', 'telegram'] as const).filter((b) => delivers.some((d) => d.block === b));
  return { ok: true, recipe: { steps, ...(summarize ? { summarize } : {}), deliver } };
}

/** A saved flow's recipe back on the canvas, laid out as the shelf draws it (flowGraph), every block editable again. */
export function recipeToGraph(r: Pick<ScheduleView, 'steps' | 'summarize' | 'deliver'>): EdGraph {
  const steps = Array.isArray(r.steps) ? r.steps : [];
  const deliver = (Array.isArray(r.deliver) && r.deliver.length ? r.deliver : ['note']).filter((d) => d === 'note' || d === 'telegram');
  const laid = flowGraph({ prompt: '', steps, summarize: r.summarize, deliver });
  const nodes: EdNode[] = laid.nodes.map((n) => {
    if (n.kind === 'summarize') return { id: n.id, block: 'summarize', position: n.position, prompt: r.summarize || '' };
    if (n.kind === 'deliver') return { id: n.id, block: n.label as BlockId, position: n.position };
    const s = steps[Number(n.id.slice('step-'.length))];
    const o = typeof s === 'string' ? { step: s } : s;
    if (o.step === 'eval_start') {
      const sets = Array.isArray(o.sets) ? o.sets.map(String) : [];
      return { id: n.id, block: 'eval_start', position: n.position, set: sets.join(', '), runs: Number(o.runs) || 1 };
    }
    return { id: n.id, block: o.step as BlockId, position: n.position };
  });
  return { nodes, edges: laid.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })) };
}

/** What Save sends: a new flow has no "when" (it runs on Run now only; Set up schedules it); a change keeps its when. */
export function saveSpec(name: string, recipe: Recipe, isNew: boolean): Partial<ScheduleSpec> & { name: string } {
  const base = { name: name.trim(), backend: 'steward' as const, steps: recipe.steps, summarize: recipe.summarize || '', deliver: recipe.deliver };
  return isNew ? { ...base, prompt: '', when: '' } : base;
}
