import React, { useEffect, useMemo, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Workflow, Bot, Send, Boxes, PanelRight, X, Play, Settings2 } from 'lucide-react';
import type { ScheduleView, SchedulesBridge } from '../types/desktop.ts';
import { CARD, FlowNodeKind, FlowRunState, flowGraph, flowRunState, lastResultLine } from '../utils/flowGraph.ts';
import { cleanError, runBlocked, runFlow } from '../utils/flowSetup.ts';
import { FLOWS_STEWARD_OPEN_KEY, keepPanel, panelOpen } from '../utils/agentConsole.ts';
import { AutomationsSection } from './settings/AutomationsSection.tsx';

/**
 * The Flows shelf (the operator, 2026-11-05; plan-the-flows-shelf-ide-for-steward-s-f-04a93a, piece 1): the flows on
 * the left, the open one in the middle drawn as block cards wired output to input (the old Flows tab's look, read-only
 * here), and Steward's card folding out on the right as the Agent tab's console does. The flows are the app's
 * schedules for now; utils/flowGraph.ts turns one into its blocks and wires. Run now runs the open flow the way the
 * scheduler does, and Set up (the Phone view's Setup pattern) holds the automations, moved from the Agent console.
 */
type BlockData = { label: string; detail?: string; first: boolean; last: boolean; state: FlowRunState };
type RFNode = Node<BlockData, FlowNodeKind>;

const KIND: Record<FlowNodeKind, { title: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
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
        {st.word && <span className={`text-[10px] font-normal ${st.color} ${data.state === 'running' ? 'animate-pulse' : ''}`}>{st.word}</span>}
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
const nodeTypes = { step: BlockCard, summarize: BlockCard, turn: BlockCard, deliver: BlockCard };

/** A flow's blocks and wires as the canvas takes them, from flowGraph (the seam). */
function canvasOf(flow: ScheduleView): { nodes: RFNode[]; edges: Edge[] } {
  const g = flowGraph(flow);
  const state = flowRunState(flow);
  const targets = new Set(g.edges.map((e) => e.target));
  const sources = new Set(g.edges.map((e) => e.source));
  const nodes: RFNode[] = g.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position,
    // the size is given so the canvas can draw before it measures (and on the server, in the test)
    width: CARD.width,
    height: CARD.height,
    data: { label: n.label, detail: n.detail, first: !targets.has(n.id), last: !sources.has(n.id), state },
  }));
  const edges: Edge[] = g.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    type: 'smoothstep',
    animated: state === 'running',
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
const FlowCanvas: React.FC<{ flow: ScheduleView }> = ({ flow }) => {
  const { nodes, edges } = useMemo(() => canvasOf(flow), [flow]);
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
  /** Run now on the open flow; held, with the reason shown, while it runs or Steward is busy */
  onRun?: (id: string) => void;
  stewardBusy?: boolean;
  runError?: string | null;
  /** the Set up panel (the automations), folded under the bar as the Phone view's Setup is */
  setupOpen?: boolean;
  onSetupOpen?: (on: boolean) => void;
  bridge?: SchedulesBridge;
  onFlowsChange?: (list: ScheduleView[]) => void;
}

/** The shelf as drawn from its data (the test renders this). */
export const FlowsShelfView: React.FC<FlowsShelfViewProps> = ({
  flows,
  selectedId,
  onSelect,
  error,
  stewardOpen,
  onStewardOpen,
  onRun,
  stewardBusy = false,
  runError,
  setupOpen = false,
  onSetupOpen,
  bridge,
  onFlowsChange,
}) => {
  const open = flows.find((f) => f.id === selectedId) || null;
  const hold = runBlocked(open, stewardBusy);
  return (
    <div className="sb-flows flex flex-1 min-w-0 min-h-0">
      {/* our blocks draw their own card: drop React Flow's default node box */}
      <style>{'.sb-flows .react-flow__node{padding:0;border:none;background:transparent;width:auto;box-shadow:none;border-radius:0.75rem;text-align:left}'}</style>
      <aside aria-label="Flows" className="flex w-64 max-w-[30%] shrink-0 min-w-0 min-h-0 flex-col border-r border-neutral-800">
        <div className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">Flows ({flows.length})</div>
        <ul className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-0.5" aria-label="Flow list">
          {flows.map((f) => (
            <li key={f.id} className="min-w-0">
              <button
                data-flow={f.id}
                onClick={() => onSelect(f.id)}
                className={`block w-full min-w-0 text-left px-2 py-1.5 rounded-md ${f.id === selectedId ? 'bg-neutral-800 text-white' : 'text-neutral-300 hover:bg-neutral-900'}`}
              >
                <span className="block text-xs truncate">{f.name}</span>
                <span className="block text-[11px] text-neutral-500 truncate">
                  {f.whenLabel}
                  {f.enabled ? '' : ' · off'}
                </span>
                <span className="block text-[11px] text-neutral-500 truncate" title={f.lastResult || undefined}>
                  {lastResultLine(f)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {flows.length === 0 && !error && <p className="px-3 pb-3 text-[11px] text-neutral-500">No flows yet. Make one under Set up.</p>}
        {error && <p className="px-3 pb-3 text-[11px] text-amber-300 break-words">{error}</p>}
      </aside>

      <section className="flex flex-1 min-w-0 min-h-0 flex-col">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800 text-xs min-w-0">
          <Workflow className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span className="text-neutral-200 font-semibold truncate min-w-0">{open ? open.name : 'Flows'}</span>
          {open && <span className="text-neutral-500 truncate min-w-0">{open.whenLabel}</span>}
          <span className="ml-auto" />
          {open && onRun && (
            <button
              data-run={open.id}
              onClick={() => onRun(open.id)}
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
              title="Make, change or delete automations"
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
              last run: {lastResultLine(open)}
            </span>
            {hold && onRun && <span className="ml-auto shrink-0 text-neutral-400">{hold}</span>}
          </div>
        )}
        {runError && <p role="alert" className="px-4 py-1 text-[11px] text-amber-300 break-words border-b border-neutral-900">{runError}</p>}
        {setupOpen && bridge && onFlowsChange && (
          <div className="border-b border-neutral-800 max-h-[50%] overflow-y-auto" aria-label="Set up">
            <AutomationsSection bridge={bridge} selected={open} onChange={onFlowsChange} />
          </div>
        )}
        <div className="flex-1 relative min-h-0" aria-label="Flow canvas">
          {open ? (
            <FlowCanvas flow={open} />
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
  const [stewardBusy, setStewardBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
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
      schedules.busy?.().then((b) => live && setStewardBusy(Boolean(b))).catch(() => {});
    };
    read();
    // while a flow runs its state is read again until it ends; otherwise now and then, for Steward's busy
    const timer = setInterval(read, anyRunning ? POLL_MS : POLL_MS * 5);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, schedules, anyRunning]);
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
      stewardBusy={stewardBusy}
      runError={runError}
      setupOpen={setupOpen}
      onSetupOpen={setSetupOpen}
      bridge={schedules}
      onFlowsChange={take}
    />
  );
};
