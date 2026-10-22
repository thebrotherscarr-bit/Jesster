/**
 * Flows: blocks wired output -> input, run in order. Every block takes the
 * text wired into it and hands on text. The engine knows nothing about notes or
 * models; the blocks' work comes in as `runners`, so the same flow runs in the
 * app and in tests.
 */

export type BlockType = 'input' | 'note' | 'search' | 'model' | 'template' | 'save' | 'output';

export interface BlockData {
  /** input: the text; template / model: the template, with {{input}}, {{input1}}…, {{date}} */
  text?: string;
  /** note: id or title; save: the note's title template */
  note?: string;
  /** search: words when nothing is wired in; how many notes */
  limit?: number;
  /** model: 'local' or a provider id ('anthropic' | 'openai' | 'google') */
  model?: string;
  /** save: 'create' a new note each run, or 'append' to the note titled */
  mode?: 'create' | 'append';
  shelf?: string;
  tags?: string;
  [k: string]: unknown;
}

export interface FlowNode {
  id: string;
  type: BlockType;
  position: { x: number; y: number };
  data: BlockData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

export interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface BlockContext {
  node: FlowNode;
  /** the outputs wired in, in the order of the upstream blocks' height on the canvas */
  inputs: string[];
  /** what a template sees: {{input}} (all inputs), {{input1}}…, {{date}} */
  fill: (template: string) => string;
  signal?: AbortSignal;
}

export type Runner = (ctx: BlockContext) => Promise<string> | string;
export type Runners = Partial<Record<BlockType, Runner>>;

export type BlockState =
  | { status: 'waiting' }
  | { status: 'running' }
  | { status: 'done'; output: string; ms: number }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

/** The blocks in an order where every block comes after the ones wired into it. */
export function order(flow: Flow): FlowNode[] {
  const ids = new Set(flow.nodes.map((n) => n.id));
  const into = new Map<string, number>(flow.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>();
  for (const e of flow.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    into.set(e.target, (into.get(e.target) || 0) + 1);
    out.set(e.source, [...(out.get(e.source) || []), e.target]);
  }
  const byPos = (a: FlowNode, b: FlowNode) => a.position.x - b.position.x || a.position.y - b.position.y;
  const ready = flow.nodes.filter((n) => !into.get(n.id)).sort(byPos);
  const done: FlowNode[] = [];
  const node = new Map(flow.nodes.map((n) => [n.id, n]));
  while (ready.length) {
    const n = ready.shift()!;
    done.push(n);
    for (const t of out.get(n.id) || []) {
      into.set(t, into.get(t)! - 1);
      if (into.get(t) === 0) {
        ready.push(node.get(t)!);
        ready.sort(byPos);
      }
    }
  }
  if (done.length !== flow.nodes.length) {
    const stuck = flow.nodes.filter((n) => !done.includes(n)).map((n) => n.id).sort();
    throw new Error(`the wires go round in a loop through ${stuck.join(', ')}; a flow has to run one way`);
  }
  return done;
}

export function fillTemplate(template: string, inputs: string[], now = new Date()): string {
  const all = inputs.filter((x) => x.trim()).join('\n\n');
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return template
    .replace(/\{\{\s*input(\d+)\s*\}\}/g, (_, i) => inputs[Number(i) - 1] ?? '')
    .replace(/\{\{\s*input\s*\}\}/g, all)
    .replace(/\{\{\s*date\s*\}\}/g, date);
}

/**
 * Run the whole flow. A block whose inputs all failed or came out empty is
 * skipped (and so are the blocks after it), so a dead branch stops quietly
 * while the others carry on.
 */
export async function runFlow(
  flow: Flow,
  runners: Runners,
  onState: (id: string, s: BlockState) => void = () => {},
  { signal, now }: { signal?: AbortSignal; now?: Date } = {}
): Promise<Record<string, BlockState>> {
  const seq = order(flow);
  const states: Record<string, BlockState> = {};
  const set = (id: string, s: BlockState) => {
    states[id] = s;
    onState(id, s);
  };
  seq.forEach((n) => set(n.id, { status: 'waiting' }));
  const pos = new Map(flow.nodes.map((n) => [n.id, n.position]));
  for (const node of seq) {
    if (signal?.aborted) {
      set(node.id, { status: 'skipped', reason: 'stopped' });
      continue;
    }
    const wired = flow.edges
      .filter((e) => e.target === node.id && states[e.source])
      .sort((a, b) => (pos.get(a.source)?.y ?? 0) - (pos.get(b.source)?.y ?? 0));
    const ups = wired.map((e) => states[e.source]);
    if (ups.length && ups.every((s) => s.status !== 'done' || !s.output.trim())) {
      set(node.id, { status: 'skipped', reason: ups.some((s) => s.status === 'error') ? 'a block before it failed' : 'nothing came in' });
      continue;
    }
    const inputs = ups.map((s) => (s.status === 'done' ? s.output : ''));
    const run = runners[node.type];
    if (!run) {
      set(node.id, { status: 'error', error: `no runner for ${node.type} blocks` });
      continue;
    }
    set(node.id, { status: 'running' });
    const t0 = Date.now();
    try {
      const output = await run({ node, inputs, fill: (t) => fillTemplate(t, inputs, now), signal });
      set(node.id, { status: 'done', output: String(output ?? ''), ms: Date.now() - t0 });
    } catch (e) {
      set(node.id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return states;
}

// ------------------------------------------------------------ in the vault --

const FENCE = /```flow\n([\s\S]*?)\n```/;

/** A flow kept as a note: a line about it, then the flow as JSON in a ```flow block. */
export function flowToNoteBody(flow: Flow, about = ''): string {
  const clean: Flow = {
    nodes: flow.nodes.map(({ id, type, position, data }) => ({ id, type, position: { x: Math.round(position.x), y: Math.round(position.y) }, data })),
    edges: flow.edges.map(({ id, source, target }) => ({ id, source, target })),
  };
  return `${about.trim() || 'A flow: blocks wired output to input. Open it in the Flows tab.'}\n\n\`\`\`flow\n${JSON.stringify(clean, null, 1)}\n\`\`\`\n`;
}

export function flowFromNoteBody(body: string): Flow | null {
  const m = FENCE.exec(body || '');
  if (!m) return null;
  try {
    const f = JSON.parse(m[1]);
    if (!Array.isArray(f.nodes) || !Array.isArray(f.edges)) return null;
    return f as Flow;
  } catch {
    return null;
  }
}

/** What the flow does, in words, for the note's first line. */
export function describe(flow: Flow): string {
  try {
    return order(flow).map((n) => n.type).join(' → ');
  } catch {
    return 'a flow with a loop in it';
  }
}
