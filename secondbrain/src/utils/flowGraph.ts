import type { FlowRun, FlowRunStep, MafWorkflowDict, ScheduleView } from '../types/desktop.ts';

/**
 * The Flows shelf's graph (components/FlowsShelf.tsx): one flow drawn as block cards wired output to input.
 *
 * THE SEAM FOR PIECE 2. Today a flow is one of the app's schedules (electron/agent/schedules.cjs, workflows.cjs) and
 * its graph is read off the recipe's shape: the gather steps, then the one summarize turn, then each place it
 * is delivered; a schedule with only a prompt is one turn, then where it goes. Piece 2 switches flowGraph to Steward's
 * MAF Workflow.to_dict() (its executors and edges, the shape DevUI's workflow_dump carries): only this function
 * changes; the shelf draws whatever nodes and edges it returns.
 * (2026-11-05: built. flowGraphFromMaf draws a flow from Steward's recipe_graph, MAF's Workflow.to_dict(), its
 * executors and edges as they are; flowGraph stays as the drawing when his host is down, "offline: drawn locally".)
 */
export type FlowNodeKind = 'begin' | 'step' | 'summarize' | 'turn' | 'deliver';

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  /** one line under the label: a step's arguments, the summarize or prompt text */
  detail?: string;
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** which side the wire leaves and enters: along a row it is right to left, between rows bottom to top */
  sourceHandle: 'right' | 'bottom';
  targetHandle: 'left' | 'top';
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** The part of a schedule the graph reads. */
export type FlowSource = Pick<ScheduleView, 'prompt' | 'deliver' | 'steps' | 'summarize' | 'backend'>;

/**
 * The layout (the operator, 2026-11-05: "making it this huge left-right line with no wrap or stack is kind of weird and
 * unusable", then "they dont have to all fit at once, just needs to be visible and aesthetic"): layered, each layer a
 * band of rows. The gather steps fill rows of WRAP cards, reading like text; summarize sits centred on the band below;
 * the deliveries share the band under it. Cards are one fixed, readable size (CARD) on an even grid (COLUMN by ROW,
 * centring on half a column), so nothing overlaps and no flow becomes one endless line.
 */
export const CARD = { width: 240, height: 104 };
export const WRAP = 3;
export const COLUMN = 300;
export const ROW = 170;

const stepName = (s: string | { step: string; [arg: string]: unknown }) => (typeof s === 'string' ? s : String(s.step || ''));
const stepArgs = (s: string | { step: string; [arg: string]: unknown }) => {
  if (typeof s === 'string') return '';
  const rest = Object.entries(s).filter(([k]) => k !== 'step');
  return rest.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
};

export function flowGraph(flow: FlowSource): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const deliver = Array.isArray(flow.deliver) && flow.deliver.length ? flow.deliver : ['note'];
  // the band's width in columns: the widest layer, at most WRAP
  const width = Math.max(1, Math.min(WRAP, Math.max(steps.length, deliver.length)));
  // `count` cards centred in a row of the band
  const centred = (i: number, count: number, row: number) => ({ x: ((width - count) / 2 + i) * COLUMN, y: row * ROW });
  const posOf = (id: string) => nodes.find((n) => n.id === id)!.position;
  const wire = (source: string, target: string) => {
    const along = posOf(source).y === posOf(target).y;
    edges.push({ id: `${source}->${target}`, source, target, sourceHandle: along ? 'right' : 'bottom', targetHandle: along ? 'left' : 'top' });
  };
  let last: string | null = null;
  let row = 0;
  if (steps.length) {
    const rows = Math.ceil(steps.length / WRAP);
    for (const [i, s] of steps.entries()) {
      const id = `step-${i}`;
      const detail = stepArgs(s);
      const r = Math.floor(i / WRAP);
      const inRow = r === rows - 1 ? steps.length - r * WRAP : WRAP;
      nodes.push({ id, kind: 'step', label: stepName(s), ...(detail ? { detail } : {}), position: centred(i % WRAP, inRow, r) });
      if (last) wire(last, id);
      last = id;
    }
    row = rows;
    if (flow.summarize) {
      nodes.push({ id: 'summarize', kind: 'summarize', label: 'Steward: summarize', detail: flow.summarize, position: centred(0, 1, row++) });
      wire(last!, 'summarize');
      last = 'summarize';
    }
  } else {
    const who = flow.backend === 'steward' ? 'Steward' : 'Agent';
    nodes.push({ id: 'turn', kind: 'turn', label: `${who}: ${flow.prompt || '(no prompt)'}`, position: centred(0, 1, row++) });
    last = 'turn';
  }
  for (const [i, d] of deliver.entries()) {
    const id = `deliver-${d}`;
    const r = row + Math.floor(i / WRAP);
    const inRow = Math.min(WRAP, deliver.length - Math.floor(i / WRAP) * WRAP);
    nodes.push({ id, kind: 'deliver', label: d, position: centred(i % WRAP, inRow, r) });
    if (last) wire(last, id);
  }
  return { nodes, edges };
}

/** Which card a MAF executor is, by its type in to_dict() (Steward's recipe_workflow.py executors). */
const MAF_KIND: Record<string, FlowNodeKind> = { Begin: 'begin', GatherStep: 'step', Summarize: 'summarize', Deliver: 'deliver' };

/**
 * A flow drawn from Steward's MAF workflow (recipe_graph: Workflow.to_dict()): one card per executor, wired by MAF's
 * edges (its internal edges left out), in the order the run takes them from start_executor_id. Each card's id is the
 * executor's id, so a run's steps (recipe_runs, recipe_status) light it by name. The recipe gives the words: a gather
 * step's arguments, the summarize text, where it is delivered. The layout is flowGraph's: bands of one kind each,
 * wrapped at WRAP on the same grid.
 */
export function flowGraphFromMaf(wf: MafWorkflowDict, flow: FlowSource): FlowGraph {
  const links = (wf.edge_groups || []).flatMap((g) => g.edges || []).filter((e) => !e.source_id.startsWith('internal:'));
  // the executors in the order the run takes them: from the start, along the edges
  const order: string[] = [];
  const queue = [wf.start_executor_id];
  while (queue.length) {
    const id = queue.shift()!;
    if (order.includes(id) || !wf.executors[id]) continue;
    order.push(id);
    queue.push(...links.filter((e) => e.source_id === id).map((e) => e.target_id));
  }
  for (const id of Object.keys(wf.executors)) if (!order.includes(id)) order.push(id);
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  const deliver = Array.isArray(flow.deliver) && flow.deliver.length ? flow.deliver : ['note'];
  const words = (id: string, kind: FlowNodeKind): { label: string; detail?: string } => {
    if (kind === 'begin') return { label: 'begin', detail: "the run's window and recipe" };
    if (kind === 'summarize') return { label: 'Steward: summarize', ...(flow.summarize ? { detail: flow.summarize } : {}) };
    if (kind === 'deliver') return { label: deliver.join(', ') };
    const m = /^(\d+)_(.+)$/.exec(id);
    const s = m ? steps[Number(m[1]) - 1] : undefined;
    const detail = s !== undefined ? stepArgs(s) : '';
    return { label: m ? m[2] : id, ...(detail ? { detail } : {}) };
  };
  // bands: runs of one kind in order (begin, the gather steps, summarize, deliver), each wrapped at WRAP
  const kinds = order.map((id) => MAF_KIND[wf.executors[id].type] || 'step');
  const bands: number[][] = [];
  kinds.forEach((k, i) => (i && kinds[i - 1] === k ? bands[bands.length - 1].push(i) : bands.push([i])));
  const width = Math.max(1, Math.min(WRAP, Math.max(...bands.map((b) => b.length))));
  const nodes: FlowNode[] = [];
  let row = 0;
  for (const band of bands) {
    const rows = Math.ceil(band.length / WRAP);
    band.forEach((at, j) => {
      const r = Math.floor(j / WRAP);
      const inRow = r === rows - 1 ? band.length - r * WRAP : WRAP;
      const id = order[at];
      nodes.push({ id, kind: kinds[at], ...words(id, kinds[at]), position: { x: ((width - inRow) / 2 + (j % WRAP)) * COLUMN, y: (row + r) * ROW } });
    });
    row += rows;
  }
  const posOf = (id: string) => nodes.find((n) => n.id === id)!.position;
  const edges: FlowEdge[] = links
    .filter((e) => wf.executors[e.source_id] && wf.executors[e.target_id])
    .map((e) => {
      const along = posOf(e.source_id).y === posOf(e.target_id).y;
      return { id: `${e.source_id}->${e.target_id}`, source: e.source_id, target: e.target_id, sourceHandle: along ? 'right' : 'bottom', targetHandle: along ? 'left' : 'top' };
    });
  return { nodes, edges };
}

/**
 * One run's step on a card: by the executor's id (a graph from MAF), or, on a graph drawn locally, by the same
 * place in the recipe (step-0 is executor 1_<step>; each delivery card is the one Deliver executor).
 */
export function stepFor(nodeId: string, steps: FlowRunStep[] | undefined): FlowRunStep | undefined {
  if (!steps) return undefined;
  const local = /^step-(\d+)$/.exec(nodeId);
  if (local) return steps.find((s) => s.id.startsWith(`${Number(local[1]) + 1}_`));
  if (nodeId.startsWith('deliver-')) return steps.find((s) => s.id === 'deliver');
  return steps.find((s) => s.id === nodeId);
}

/** A run in the history list, in plain words: its result, what started it, when, and how long it took. */
export function runLine(r: FlowRun): string {
  const result = r.state === 'running' ? 'running' : r.state === 'failed' ? `failed${r.error ? `: ${r.error}` : ''}` : r.ok ? 'ok' : 'not ok';
  const by = r.trigger === 'now' ? 'Run now' : r.trigger === 'schedule' ? 'scheduled' : '';
  const start = r.started ? new Date(r.started) : null;
  const when = start && !Number.isNaN(start.getTime()) ? start.toLocaleString() : '';
  const end = r.ended ? new Date(r.ended).getTime() : NaN;
  const took = start && !Number.isNaN(end) ? msLabel(end - start.getTime()) : '';
  return [result, by, when, took].filter(Boolean).join(' · ');
}

/** A step's time on its card: ms under a second, else seconds, else minutes. */
export function msLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60000)} min`;
}

/** The live canvas reads its run again while it is running, at most LIVE_POLLS times and never past its deadline. */
export const LIVE_POLLS = 2400;
export function keepPolling(run: Pick<FlowRun, 'state'> | null, polls: number, now: number, until?: number): boolean {
  if (run && run.state !== 'running') return false;
  if (polls >= LIVE_POLLS) return false;
  return until === undefined || now <= until;
}

/** What the open flow's cards show of its run, from the run state the schedule already carries. */
export type FlowRunState = 'idle' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting';

export function flowRunState(s: Pick<ScheduleView, 'lastRun' | 'lastResult' | 'running' | 'pending'>): FlowRunState {
  if (s.running || s.pending) return 'running';
  if (!s.lastRun) return 'idle';
  return s.lastResult === 'ok' ? 'done' : 'failed';
}

/** A flow's last result in the list, in plain words: never run, running, waiting, ok or what went wrong. */
export function lastResultLine(s: Pick<ScheduleView, 'lastRun' | 'lastResult' | 'running' | 'pending'>): string {
  if (s.running) return 'running now';
  if (s.pending) return `waiting on ${s.pending.label || s.pending.tag || 'its run'}`;
  if (!s.lastRun) return 'not run yet';
  const when = new Date(s.lastRun);
  const t = Number.isNaN(when.getTime()) ? '' : when.toLocaleString();
  return `${s.lastResult === 'ok' ? 'ok' : s.lastResult || 'no result'}${t ? ` · ${t}` : ''}`;
}
