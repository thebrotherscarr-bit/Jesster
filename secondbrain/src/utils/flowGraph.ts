import type { ScheduleView } from '../types/desktop.ts';

/**
 * The Flows shelf's graph (components/FlowsShelf.tsx): one flow drawn as block cards wired output to input.
 *
 * THE SEAM FOR PIECE 2. Today a flow is one of the app's schedules (electron/agent/schedules.cjs, workflows.cjs) and
 * its graph is read off the recipe's shape: the gather steps, then the one summarize turn, then each place it
 * is delivered; a schedule with only a prompt is one turn, then where it goes. Piece 2 switches flowGraph to Steward's
 * MAF Workflow.to_dict() (its executors and edges, the shape DevUI's workflow_dump carries): only this function
 * changes; the shelf draws whatever nodes and edges it returns.
 */
export type FlowNodeKind = 'step' | 'summarize' | 'turn' | 'deliver';

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

/** What the open flow's cards show of its run, from the run state the schedule already carries. */
export type FlowRunState = 'idle' | 'running' | 'done' | 'failed';

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
