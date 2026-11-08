import React, { useEffect, useMemo, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Workflow, Bot, Send, Boxes, PanelRight, X, Play, Settings2, Plus, PenLine, Copy, Trash2 } from 'lucide-react';
import type { FlowRun, MafWorkflowDict, ScheduleSpec, ScheduleView, SchedulesBridge } from '../types/desktop.ts';
import { CARD, FlowNodeKind, FlowRunState, failedReason, flowGraph, flowGraphFromMaf, flowRunState, keepPolling, lastResultLine, msLabel, runLine, stepFor } from '../utils/flowGraph.ts';
import { LEGACY_LABEL, cleanError, isLegacy, removeFlow, runBlocked, runFlow } from '../utils/flowSetup.ts';
import { FLOWS_STEWARD_OPEN_KEY, keepPanel, panelOpen } from '../utils/agentConsole.ts';
import { AutomationsSection } from './settings/AutomationsSection.tsx';
import { FlowEditor } from './FlowEditor.tsx';
import { EdGraph, Recipe, recipeToGraph, saveSpec } from '../utils/flowEditor.ts';

/**
 * The Flows shelf (the operator, 2026-11-05; plan-the-flows-shelf-ide-for-steward-s-f-04a93a, piece 1): the flows on
 * the left, the open one in the middle drawn as block cards wired output to input (the old Flows tab's look, read-only
 * here), and Steward's card folding out on the right as the Agent tab's console does. The flows are the app's
 * schedules for now; utils/flowGraph.ts turns one into its blocks and wires. Run now runs the open flow the way the
 * scheduler does, and Set up (the Phone view's Setup pattern) holds the automations, moved from the Agent console.
 * ADR-0009 (Steward docs/decisions, 2026-11-05): a flow is made only with + New flow and saved by itself; an automation
 * is a saved flow, when and on/off (Set up); any flow runs whenever the operator says, with no night badge or daytime
 * question ("run it whenever i say. day or night or whenever, its my system. same as any eval.").
 * Piece 2 (ADR-0008, 2026-11-05): the canvas is drawn from Steward's MAF workflow (recipe_graph's to_dict()), or
 * locally with "offline: drawn locally" when his host is down; under the open flow its last runs (recipe_runs), and a
 * click on one lights each block with that run's step (done, failed, skipped, its ms); while a run goes, the blocks
 * follow it (recipe_status, read every few seconds until it ends).
 */
type BlockData = { label: string; detail?: string; first: boolean; last: boolean; state: FlowRunState; ms?: string };
type RFNode = Node<BlockData, FlowNodeKind>;

const KIND: Record<FlowNodeKind, { title: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  begin: { title: 'Begin', icon: Play, color: 'text-sky-400' },
  step: { title: 'Gather', icon: Boxes, color: 'text-emerald-400' },
  summarize: { title: 'Summarize', icon: Bot, color: 'text-amber-300' },
  turn: { title: 'Turn', icon: Bot, color: 'text-amber-300' },
  deliver: { title: 'Deliver', icon: Send, color: 'text-rose-300' },
};

const STATE: Record<FlowRunState, { border: string; word: string; color: string }> = {
  idle: { border: 'border-neutral-700', word: '', color: '' },
  running: { border: 'border-sky-500', word: 'running', color: 'text-sky-300' },
  done: { border: 'border-emerald-700', word: 'done', color: 'text-emerald-400' },
  failed: { border: 'border-rose-700', word: 'failed', color: 'text-rose-400' },
  skipped: { border: 'border-neutral-800 border-dashed', word: 'skipped', color: 'text-neutral-500' },
  waiting: { border: 'border-neutral-700', word: 'waiting', color: 'text-neutral-400' },
};

const handle = '!w-2.5 !h-2.5';

/** One block card: what kind it is, its name, one line of detail, its run state, and its wires' dots (side and top). */
const BlockCard: React.FC<NodeProps<RFNode>> = ({ type, data }) => {
  const k = KIND[type];
  const Icon = k.icon;
  const st = STATE[data.state];
  return (
    <div data-block={type} data-state={data.state} style={{ width: CARD.width, minHeight: CARD.height }} className={`rounded-xl border ${st.border} bg-neutral-900 shadow-lg`}>
      {!data.first && (
        <>
          <Handle id="left" type="target" position={Position.Left} isConnectable={false} className={`${handle} !bg-sky-500`} />
          <Handle id="top" type="target" position={Position.Top} isConnectable={false} className={`${handle} !bg-sky-500`} />
        </>
      )}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-neutral-800 text-xs font-semibold text-white">
        <Icon className={`w-3.5 h-3.5 ${k.color}`} /> <span className="flex-1">{k.title}</span>
        {st.word && (
          <span className={`text-[10px] font-normal ${st.color} ${data.state === 'running' ? 'animate-pulse' : ''}`}>
            {st.word}
            {data.ms ? ` · ${data.ms}` : ''}
          </span>
        )}
      </div>
      <div className="p-2 space-y-1">
        <p className="text-xs text-neutral-100 break-words">{data.label}</p>
        {data.detail && <p className="text-[11px] text-neutral-400 break-words line-clamp-3">{data.detail}</p>}
      </div>
      {!data.last && (
        <>
          <Handle id="right" type="source" position={Position.Right} isConnectable={false} className={`${handle} !bg-amber-400`} />
          <Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} className={`${handle} !bg-amber-400`} />
        </>
      )}
    </div>
  );
};
const nodeTypes = { begin: BlockCard, step: BlockCard, summarize: BlockCard, turn: BlockCard, deliver: BlockCard };

/**
 * A flow's blocks and wires as the canvas takes them: from Steward's MAF workflow when it was read (flowGraphFromMaf),
 * else drawn locally (flowGraph). With a run (one clicked in the history, or the one going now), each block shows its
 * own step's state and ms; without one, the flow's last state as the schedule carries it.
 */
export function canvasOf(flow: ScheduleView, maf?: MafWorkflowDict | null, run?: FlowRun | null): { nodes: RFNode[]; edges: Edge[] } {
  const g = maf ? flowGraphFromMaf(maf, flow) : flowGraph(flow);
  const whole: FlowRunState = run ? (run.state === 'running' ? 'running' : run.state === 'failed' ? 'failed' : 'done') : flowRunState(flow);
  const targets = new Set(g.edges.map((e) => e.target));
  const sources = new Set(g.edges.map((e) => e.source));
  const nodes: RFNode[] = g.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position,
    // the size is given so the canvas can draw before it measures (and on the server, in the test)
    width: CARD.width,
    height: CARD.height,
    data: (() => {
      const step = run ? stepFor(n.id, run.steps) : undefined;
      const state: FlowRunState = run ? (step ? step.state : 'idle') : whole;
      return { label: n.label, detail: n.detail, first: !targets.has(n.id), last: !sources.has(n.id), state, ...(step && step.ms !== null ? { ms: msLabel(step.ms) } : {}) };
    })(),
  }));
  const edges: Edge[] = g.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    type: 'smoothstep',
    animated: whole === 'running',
  }));
  return { nodes, edges };
}

/**
 * Where the canvas opens: at a readable zoom (1), the first blocks in the top left with a margin; the rest is reached
 * by panning and zooming (the operator: "they dont have to all fit at once, just needs to be visible").
 */
export const OPEN_VIEW = { zoom: 1, margin: 32 };
export function openViewport(nodes: { position: { x: number; y: number } }[]) {
  const top = nodes.length ? Math.min(...nodes.map((n) => n.position.y)) : 0;
  const left = nodes.length ? Math.min(...nodes.filter((n) => n.position.y === top).map((n) => n.position.x)) : 0;
  return { x: OPEN_VIEW.margin - left * OPEN_VIEW.zoom, y: OPEN_VIEW.margin - top * OPEN_VIEW.zoom, zoom: OPEN_VIEW.zoom };
}

/** The open flow on the canvas, read-only: nothing is dragged, wired or deleted here; it pans and zooms. */
const FlowCanvas: React.FC<{ flow: ScheduleView; maf?: MafWorkflowDict | null; run?: FlowRun | null }> = ({ flow, maf, run }) => {
  const { nodes, edges } = useMemo(() => canvasOf(flow, maf, run), [flow, maf, run]);
  const view = useMemo(() => openViewport(nodes), [nodes]);
  return (
    <ReactFlowProvider key={flow.id} initialNodes={nodes} initialEdges={edges} initialWidth={800} initialHeight={400}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        colorMode="dark"
        defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
        defaultViewport={view}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </ReactFlowProvider>
  );
};

/** Steward's card, folded out on the right: a placeholder until piece 5 puts his chat here. */
const StewardCard: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <aside aria-label="Steward" className="flex w-[22rem] max-w-[40%] shrink-0 min-h-0 min-w-0 flex-col border-l border-neutral-800">
    <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800">
      <span className="text-[11px] text-neutral-500">
        flows <span className="text-neutral-700">/</span> <b className="text-neutral-200 font-semibold">Steward</b>
      </span>
      <button onClick={onClose} aria-label="Close Steward's card" className="ml-auto p-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto p-3">
      <p className="rounded-lg border border-dashed border-neutral-800 p-3 text-center text-[11px] text-neutral-500">
        Steward will build and change flows from here. Not yet.
      </p>
    </div>
  </aside>
);

export interface FlowsShelfViewProps {
  flows: ScheduleView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  error?: string | null;
  stewardOpen: boolean;
  onStewardOpen: (on: boolean) => void;
  /** Run now on the open flow; held, with the reason shown, only while that flow runs */
  onRun?: (id: string) => void;
  runError?: string | null;
  /** the Set up panel (the automations), folded under the bar as the Phone view's Setup is */
  setupOpen?: boolean;
  onSetupOpen?: (on: boolean) => void;
  bridge?: SchedulesBridge;
  onFlowsChange?: (list: ScheduleView[]) => void;
  /** the editor (FlowEditor): + New flow, Edit blocks and Duplicate open it; while open it takes the list's place */
  onNew?: () => void;
  onEdit?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  editor?: EditorOpen | null;
  onEditorSave?: (name: string, recipe: Recipe) => Promise<string | null>;
  onEditorCancel?: () => void;
  /** Delete on the open flow (the flow itself; Set up's delete takes off only an automation) */
  onDelete?: (id: string) => void;
  /** the open flow's graph from Steward (recipe_graph), or 'offline' when his host did not answer: drawn locally */
  graph?: { workflow: MafWorkflowDict } | 'offline' | null;
  /** the open flow's last runs, newest first (recipe_runs); null while unread */
  runs?: FlowRun[] | null;
  runsError?: string | null;
  /** the run clicked in the history: the canvas shows its steps */
  selectedRun?: string | null;
  onSelectRun?: (runId: string | null) => void;
  /** the open flow's run going now, read live (recipe_status) */
  liveRun?: FlowRun | null;
}

/** What the editor is open on: a new flow, a copy (both saved as new) or a flow's own blocks. */
export interface EditorOpen {
  key: string;
  /** the flow whose blocks change, or null for a new one */
  id: string | null;
  name: string;
  graph: EdGraph;
}

/** The eval set names the flows already name (the examples carry every set): offered in Eval set's box. */
export const knownSets = (flows: ScheduleView[]) =>
  [...new Set(flows.flatMap((f) => (f.steps || []).flatMap((x) => (typeof x !== 'string' && x.step === 'eval_start' && Array.isArray(x.sets) ? x.sets.map(String) : []))))].sort();

/** A flow's steps can be opened on the editor (a prompt-only automation has no blocks to edit). */
export const editable = (f: ScheduleView | null) => Boolean(f && Array.isArray(f.steps) && f.steps.length);

const Badge: React.FC<{ kind: 'example' | 'legacy' }> = ({ kind }) =>
  kind === 'legacy' ? (
    <span data-badge="legacy" title="A prompt-only automation from before flows: make it again as a flow with + New flow" className="shrink-0 rounded px-1 text-[10px] bg-amber-950 text-amber-300">
      {LEGACY_LABEL}
    </span>
  ) : (
    <span data-badge="example" title="A built-in example: run it, duplicate it or change it" className="shrink-0 rounded px-1 text-[10px] bg-neutral-800 text-neutral-300">
      example
    </span>
  );

/** The shelf as drawn from its data (the test renders this). */
export const FlowsShelfView: React.FC<FlowsShelfViewProps> = ({
  flows,
  selectedId,
  onSelect,
  error,
  stewardOpen,
  onStewardOpen,
  onRun,
  runError,
  setupOpen = false,
  onSetupOpen,
  bridge,
  onFlowsChange,
  onNew,
  onEdit,
  onDuplicate,
  editor = null,
  onEditorSave,
  onEditorCancel,
  onDelete,
  graph = null,
  runs = null,
  runsError = null,
  selectedRun = null,
  onSelectRun,
  liveRun = null,
}) => {
  const open = flows.find((f) => f.id === selectedId) || null;
  const clicked = (runs || []).find((r) => r.run_id === selectedRun) || null;
  // the canvas shows the run clicked; else the run going now (until the schedule files it); else the flow's last state
  const shown = clicked || liveRun;
  const maf = graph && graph !== 'offline' ? graph.workflow : null;
  const hold = runBlocked(open);
  // any flow runs whenever the operator says (ADR-0009): no night badge, no daytime question
  const run = (id: string) => onRun?.(id);
  // our blocks draw their own card: drop React Flow's default node box
  const style = <style>{'.sb-flows .react-flow__node{padding:0;border:none;background:transparent;width:auto;box-shadow:none;border-radius:0.75rem;text-align:left}'}</style>;
  if (editor && onEditorSave && onEditorCancel) {
    return (
      <div className="sb-flows flex flex-1 min-w-0 min-h-0">
        {style}
        <FlowEditor key={editor.key} initial={editor.graph} name={editor.name} isNew={!editor.id} sets={knownSets(flows)} onSave={onEditorSave} onCancel={onEditorCancel} />
        {stewardOpen && <StewardCard onClose={() => onStewardOpen(false)} />}
      </div>
    );
  }
  return (
    <div className="sb-flows flex flex-1 min-w-0 min-h-0">
      {style}
      <aside aria-label="Flows" className="flex w-64 max-w-[30%] shrink-0 min-w-0 min-h-0 flex-col border-r border-neutral-800">
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
          <span className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">Flows ({flows.length})</span>
          {onNew && (
            <button type="button" data-new-flow onClick={onNew} title="Make a new flow from blocks"
              className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md bg-sky-600 text-[11px] text-white hover:bg-sky-500">
              <Plus className="w-3.5 h-3.5" /> New flow
            </button>
          )}
        </div>
        <ul className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-0.5" aria-label="Flow list">
          {flows.map((f) => (
            <li key={f.id} className="min-w-0">
              <button
                data-flow={f.id}
                onClick={() => onSelect(f.id)}
                className={`block w-full min-w-0 text-left px-2 py-1.5 rounded-md ${f.id === selectedId ? 'bg-neutral-800 text-white' : 'text-neutral-300 hover:bg-neutral-900'}`}
              >
                <span className="flex items-center gap-1 min-w-0 text-xs">
                  <span className="truncate">{f.name}</span>
                  {f.tags?.includes('example') && <Badge kind="example" />}
                  {isLegacy(f) && <Badge kind="legacy" />}
                </span>
                <span className="block text-[11px] text-neutral-500 truncate">
                  {f.whenLabel}
                  {f.enabled ? '' : ' · off'}
                </span>
                <span className={`block text-[11px] truncate ${failedReason(f) ? 'text-rose-400' : 'text-neutral-500'}`} title={f.lastResult || undefined}>
                  {lastResultLine(f)}
                </span>
              </button>
              {f.id === selectedId && editable(f) && (runs || runsError) && (
                <div aria-label="Runs" className="ml-2 mt-0.5 mb-1 border-l border-neutral-800 pl-2">
                  {runsError && <p className="text-[11px] text-neutral-500 break-words">{runsError}</p>}
                  {runs && runs.length === 0 && <p className="text-[11px] text-neutral-500">No runs kept yet.</p>}
                  {runs && runs.length > 0 && (
                    <ul className="space-y-0.5">
                      {runs.map((r) => (
                        <li key={r.run_id}>
                          <button
                            type="button"
                            data-run-id={r.run_id}
                            data-run-state={r.state === 'done' && !r.ok ? 'failed' : r.state}
                            aria-pressed={r.run_id === selectedRun}
                            onClick={() => onSelectRun?.(r.run_id === selectedRun ? null : r.run_id)}
                            title={r.short || r.error || 'Show this run on the canvas'}
                            className={`block w-full text-left px-1.5 py-0.5 rounded text-[11px] truncate ${r.run_id === selectedRun ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-900'}`}
                          >
                            <span className={r.state === 'running' ? 'text-sky-300' : r.state === 'done' && r.ok ? 'text-emerald-400' : 'text-rose-400'}>●</span> {runLine(r)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {flows.length === 0 && !error && <p className="px-3 pb-3 text-[11px] text-neutral-500">No flows yet. Make one with New flow.</p>}
        {error && <p className="px-3 pb-3 text-[11px] text-amber-300 break-words">{error}</p>}
      </aside>

      <section className="flex flex-1 min-w-0 min-h-0 flex-col">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800 text-xs min-w-0">
          <Workflow className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span className="text-neutral-200 font-semibold truncate min-w-0">{open ? open.name : 'Flows'}</span>
          {open && <span className="text-neutral-500 truncate min-w-0">{open.whenLabel}</span>}
          <span className="ml-auto" />
          {open && onEdit && editable(open) && (
            <button type="button" data-edit={open.id} onClick={() => onEdit(open.id)} title="Change its blocks and wires on the canvas"
              className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-neutral-300 hover:text-white hover:bg-neutral-900">
              <PenLine className="w-3.5 h-3.5" /> Edit blocks
            </button>
          )}
          {open && onDuplicate && editable(open) && (
            <button type="button" data-duplicate={open.id} onClick={() => onDuplicate(open.id)} title="A copy of this flow to make your own"
              className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-neutral-300 hover:text-white hover:bg-neutral-900">
              <Copy className="w-3.5 h-3.5" /> Duplicate
            </button>
          )}
          {open && onDelete && (
            <button type="button" data-delete-flow={open.id} onClick={() => onDelete(open.id)} title="Delete this flow (and its automation)"
              className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-neutral-400 hover:text-rose-400 hover:bg-neutral-900">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          )}
          {open && onRun && (
            <button
              data-run={open.id}
              onClick={() => run(open.id)}
              disabled={Boolean(hold)}
              title={hold || 'Run this flow now, as its schedule would'}
              className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md bg-sky-600 text-white hover:bg-sky-500 disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              <Play className="w-3.5 h-3.5" /> Run now
            </button>
          )}
          {onSetupOpen && (
            <button
              onClick={() => onSetupOpen(!setupOpen)}
              aria-pressed={setupOpen}
              title="Automations: run a saved flow at a time you pick"
              className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md ${setupOpen ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'}`}
            >
              <Settings2 className="w-3.5 h-3.5" /> Set up
            </button>
          )}
          <button
            onClick={() => onStewardOpen(!stewardOpen)}
            aria-pressed={stewardOpen}
            aria-label={stewardOpen ? "Close Steward's card" : "Open Steward's card"}
            title="Steward, to build and change flows"
            className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md ${stewardOpen ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'}`}
          >
            <PanelRight className="w-3.5 h-3.5" /> Steward
          </button>
        </div>
        {open && (
          <div className="flex items-center gap-2 px-4 py-1 border-b border-neutral-900 text-[11px] text-neutral-500 min-w-0">
            <span className="truncate min-w-0" data-last-run title={open.lastResult || undefined}>
              {clicked ? `showing run: ${runLine(clicked)}` : `last run: ${lastResultLine(open)}`}
            </span>
            {editable(open) && graph === 'offline' && (
              <span data-graph-note className="shrink-0 text-amber-300/80" title="Steward's host did not answer, so the flow is drawn from its recipe here">
                offline: drawn locally
              </span>
            )}
            {hold && onRun && <span className="ml-auto shrink-0 text-neutral-400">{hold}</span>}
          </div>
        )}
        {open && !clicked && failedReason(open) && (
          <p data-failed={open.id} role="status" className="px-4 py-1 text-[11px] text-rose-300 break-words border-b border-neutral-900">
            Last run failed: {failedReason(open)}
          </p>
        )}
        {runError && <p role="alert" className="px-4 py-1 text-[11px] text-amber-300 break-words border-b border-neutral-900">{runError}</p>}
        {setupOpen && bridge && onFlowsChange && (
          <div className="border-b border-neutral-800 max-h-[50%] overflow-y-auto" aria-label="Set up">
            <AutomationsSection bridge={bridge} flows={flows} selected={open} onChange={onFlowsChange} />
          </div>
        )}
        <div className="flex-1 relative min-h-0" aria-label="Flow canvas">
          {open ? (
            <div className="absolute inset-0" data-graph={maf ? 'maf' : 'local'}>
              <FlowCanvas flow={open} maf={maf} run={shown} />
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-neutral-500 max-w-sm text-center">Pick a flow on the left to see its blocks.</p>
            </div>
          )}
        </div>
      </section>

      {stewardOpen && <StewardCard onClose={() => onStewardOpen(false)} />}
    </div>
  );
};

const store = () => (typeof localStorage !== 'undefined' ? localStorage : undefined);

/** How often the shelf reads the schedules again while a flow runs (and, five times slower, otherwise). */
const POLL_MS = 3000;

/**
 * The Flows tab: reads the schedules each time it is shown (and every few seconds while one runs), picks the first,
 * runs the open one on Run now, and keeps Steward's card folded as it was left.
 */
export const FlowsShelf: React.FC<{ active: boolean }> = ({ active }) => {
  const [flows, setFlows] = useState<ScheduleView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [editor, setEditor] = useState<EditorOpen | null>(null);
  const [stewardOpen, setStewardOpen] = useState(() => panelOpen(store(), FLOWS_STEWARD_OPEN_KEY, false));
  const schedules = window.secondbrainDesktop?.schedules;
  const take = (list: ScheduleView[]) => {
    setFlows(list);
    setError(null);
    setSelectedId((id) => (id && list.some((f) => f.id === id) ? id : list[0]?.id || null));
  };
  const anyRunning = flows.some((f) => f.running || f.pending);
  useEffect(() => {
    if (!active || !schedules) return;
    let live = true;
    const read = () => {
      schedules
        .list()
        .then((list) => live && take(list))
        .catch((e) => live && setError(cleanError(e)));
    };
    read();
    // while a flow runs its state is read again until it ends; otherwise now and then, for a scheduled run's result
    const timer = setInterval(read, anyRunning ? POLL_MS : POLL_MS * 5);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, schedules, anyRunning]);
  // piece 2 (ADR-0008): the open flow's graph from Steward's MAF workflow, its run history, and its run going now
  const open = flows.find((f) => f.id === selectedId) || null;
  const graphKey = open && editable(open) ? JSON.stringify([open.id, open.steps, open.summarize, open.deliver]) : null;
  const liveId = open?.pending?.run_id || null;
  const liveUntil = open?.pending?.until;
  const [graph, setGraph] = useState<{ workflow: MafWorkflowDict } | 'offline' | null>(null);
  const [runs, setRuns] = useState<FlowRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<FlowRun | null>(null);
  useEffect(() => {
    setGraph(null);
    if (!active || !graphKey || !selectedId || !schedules?.graph) return;
    let live = true;
    // his host down (or slow): the flow is drawn locally, and the shelf says so
    schedules
      .graph(selectedId)
      .then((g) => live && setGraph(g && g.workflow ? { workflow: g.workflow } : 'offline'))
      .catch(() => live && setGraph('offline'));
    return () => {
      live = false;
    };
  }, [active, graphKey, selectedId, schedules]);
  useEffect(() => {
    setRuns(null);
    setRunsError(null);
    setSelectedRun(null);
  }, [selectedId]);
  const liveState = liveRun?.state;
  const openLastRun = open?.lastRun;
  useEffect(() => {
    if (!active || !graphKey || !selectedId || !schedules?.runs) return;
    let live = true;
    schedules
      .runs(selectedId, 10)
      .then((list) => {
        if (!live) return;
        setRuns(Array.isArray(list) ? list : []);
        setRunsError(null);
      })
      .catch(() => live && setRunsError("Runs: Steward's host did not answer."));
    return () => {
      live = false;
    };
  }, [active, graphKey, selectedId, schedules, liveId, liveState, openLastRun]);
  useEffect(() => {
    setLiveRun(null);
    if (!active || !liveId || !schedules?.runStatus) return;
    let live = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // read while it runs, bounded (keepPolling): it stops when the run ends, at its deadline, or after LIVE_POLLS reads
    const tick = async () => {
      let r: FlowRun | null = null;
      try {
        r = await schedules.runStatus!(liveId);
        if (live) setLiveRun(r);
      } catch {
        /* his host did not answer this time: read again, within the bound */
      }
      polls += 1;
      if (live && keepPolling(r, polls, Date.now(), liveUntil)) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [active, liveId, liveUntil, schedules]);
  const onRun = async (id: string) => {
    if (!schedules) return;
    setRunError(null);
    // shown running at once; runSchedule marks it running on the schedule too, which the next read carries
    setFlows((list) => list.map((f) => (f.id === id ? { ...f, running: true } : f)));
    try {
      const r = await runFlow(schedules, id);
      take(r.schedules);
    } catch (e) {
      setRunError(cleanError(e));
      schedules.list().then(take).catch(() => {});
    }
  };
  const openEditor = (id: string | null, copy = false) => {
    const f = id ? flows.find((x) => x.id === id) : null;
    const key = `${id || 'new'}-${Date.now()}`;
    if (!f) return setEditor({ key, id: null, name: '', graph: { nodes: [], edges: [] } });
    setEditor({ key, id: copy ? null : f.id, name: copy ? `${f.name} (copy)` : f.name, graph: recipeToGraph(f) });
  };
  const onEditorSave = async (name: string, recipe: Recipe): Promise<string | null> => {
    if (!schedules || !editor) return 'The app is not connected.';
    try {
      const spec = saveSpec(name, recipe, !editor.id);
      let list: ScheduleView[];
      if (editor.id) {
        if (!schedules.edit) return 'This build of the app cannot change a flow; update it.';
        list = await schedules.edit(editor.id, spec);
      } else list = await schedules.add(spec as ScheduleSpec);
      const saved = editor.id ? list.find((f) => f.id === editor.id) : [...list].reverse().find((f) => f.name === spec.name);
      take(list);
      if (saved) setSelectedId(saved.id);
      setEditor(null);
      return null;
    } catch (e) {
      return cleanError(e);
    }
  };
  return (
    <FlowsShelfView
      flows={flows}
      selectedId={selectedId}
      onSelect={setSelectedId}
      error={error}
      stewardOpen={stewardOpen}
      onStewardOpen={(on) => {
        setStewardOpen(on);
        keepPanel(store(), FLOWS_STEWARD_OPEN_KEY, on);
      }}
      onRun={onRun}
      runError={runError}
      setupOpen={setupOpen}
      onSetupOpen={setSetupOpen}
      bridge={schedules}
      onFlowsChange={take}
      onNew={() => openEditor(null)}
      onEdit={(id) => openEditor(id)}
      onDuplicate={(id) => openEditor(id, true)}
      editor={editor}
      onEditorSave={onEditorSave}
      onEditorCancel={() => setEditor(null)}
      graph={graph}
      runs={runs}
      runsError={runsError}
      selectedRun={selectedRun}
      onSelectRun={setSelectedRun}
      liveRun={liveRun}
      onDelete={async (id) => {
        const f = flows.find((x) => x.id === id);
        if (!schedules || !f || (typeof window !== 'undefined' && !window.confirm(`Delete the flow "${f.name}"? Its automation goes with it.`))) return;
        try {
          take(await removeFlow(schedules, id));
        } catch (e) {
          setRunError(cleanError(e));
        }
      }}
    />
  );
};
