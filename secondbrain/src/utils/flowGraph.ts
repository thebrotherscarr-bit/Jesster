import type { ScheduleView } from '../types/desktop.ts';

/**
 * The Flows shelf's graph (components/FlowsShelf.tsx): one flow drawn as block cards wired output to input, read-only.
 *
 * THE SEAM FOR PIECE 2. Today a flow is one of the app's schedules (electron/agent/schedules.cjs, workflows.cjs) and
 * its graph is read off the recipe's shape: the gather steps in a line, then the one summarize turn, then each place it
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
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** The part of a schedule the graph reads. */
export type FlowSource = Pick<ScheduleView, 'prompt' | 'deliver' | 'steps' | 'summarize' | 'backend'>;

const COLUMN = 300;
const ROW = 140;

const stepName = (s: string | { step: string; [arg: string]: unknown }) => (typeof s === 'string' ? s : String(s.step || ''));
const stepArgs = (s: string | { step: string; [arg: string]: unknown }) => {
  if (typeof s === 'string') return '';
  const rest = Object.entries(s).filter(([k]) => k !== 'step');
  return rest.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
};

export function flowGraph(flow: FlowSource): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const at = (col: number, row = 0, rows = 1) => ({ x: col * COLUMN, y: (row - (rows - 1) / 2) * ROW });
  const wire = (source: string, target: string) => edges.push({ id: `${source}->${target}`, source, target });
  let last: string | null = null;
  let col = 0;
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  if (steps.length) {
    for (const [i, s] of steps.entries()) {
      const id = `step-${i}`;
      const detail = stepArgs(s);
      nodes.push({ id, kind: 'step', label: stepName(s), ...(detail ? { detail } : {}), position: at(col++) });
      if (last) wire(last, id);
      last = id;
    }
    if (flow.summarize) {
      nodes.push({ id: 'summarize', kind: 'summarize', label: 'Steward: summarize', detail: flow.summarize, position: at(col++) });
      if (last) wire(last, 'summarize');
      last = 'summarize';
    }
  } else {
    const who = flow.backend === 'steward' ? 'Steward' : 'Agent';
    nodes.push({ id: 'turn', kind: 'turn', label: `${who}: ${flow.prompt || '(no prompt)'}`, position: at(col++) });
    last = 'turn';
  }
  const deliver = Array.isArray(flow.deliver) && flow.deliver.length ? flow.deliver : ['note'];
  for (const [i, d] of deliver.entries()) {
    const id = `deliver-${d}`;
    nodes.push({ id, kind: 'deliver', label: d, position: at(col, i, deliver.length) });
    if (last) wire(last, id);
  }
  return { nodes, edges };
}

/** A flow's last result in the list, in plain words: never run, running, waiting, ok or what went wrong. */
export function lastResultLine(s: Pick<ScheduleView, 'lastRun' | 'lastResult' | 'running' | 'pending'>): string {
  if (s.running) return 'running now';
  if (s.pending) return `waiting on ${s.pending.tag}`;
  if (!s.lastRun) return 'not run yet';
  const when = new Date(s.lastRun);
  const t = Number.isNaN(when.getTime()) ? '' : when.toLocaleString();
  return `${s.lastResult === 'ok' ? 'ok' : s.lastResult || 'no result'}${t ? ` · ${t}` : ''}`;
}
