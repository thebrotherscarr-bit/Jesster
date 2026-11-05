import React, { useEffect, useMemo, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Workflow, Bot, Send, Boxes, PanelRight, X } from 'lucide-react';
import type { ScheduleView } from '../types/desktop.ts';
import { FlowNodeKind, flowGraph, lastResultLine } from '../utils/flowGraph.ts';
import { FLOWS_STEWARD_OPEN_KEY, keepPanel, panelOpen } from '../utils/agentConsole.ts';

/**
 * The Flows shelf (the operator, 2026-11-05; plan-the-flows-shelf-ide-for-steward-s-f-04a93a, piece 1): the flows on
 * the left, the open one in the middle drawn as block cards wired output to input (the old Flows tab's look, read-only
 * here), and Steward's card folding out on the right as the Agent tab's console does. The flows are the app's
 * schedules for now; utils/flowGraph.ts turns one into its blocks and wires. Run now and Schedule come in piece 3.
 */
type BlockData = { label: string; detail?: string; first: boolean; last: boolean };
type RFNode = Node<BlockData, FlowNodeKind>;

const KIND: Record<FlowNodeKind, { title: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  step: { title: 'Gather', icon: Boxes, color: 'text-emerald-400' },
  summarize: { title: 'Summarize', icon: Bot, color: 'text-amber-300' },
  turn: { title: 'Turn', icon: Bot, color: 'text-amber-300' },
  deliver: { title: 'Deliver', icon: Send, color: 'text-rose-300' },
};

/** One block card: what kind it is, its name, one line of detail, and its wires' dots. */
const BlockCard: React.FC<NodeProps<RFNode>> = ({ type, data }) => {
  const k = KIND[type];
  const Icon = k.icon;
  return (
    <div data-block={type} className="w-60 rounded-xl border border-neutral-700 bg-neutral-900 shadow-lg">
      {!data.first && <Handle type="target" position={Position.Left} isConnectable={false} className="!w-3 !h-3 !bg-sky-500" />}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-neutral-800 text-xs font-semibold text-white">
        <Icon className={`w-3.5 h-3.5 ${k.color}`} /> <span className="flex-1">{k.title}</span>
      </div>
      <div className="p-2 space-y-1">
        <p className="text-xs text-neutral-100 break-words">{data.label}</p>
        {data.detail && <p className="text-[11px] text-neutral-400 break-words line-clamp-3">{data.detail}</p>}
      </div>
      {!data.last && <Handle type="source" position={Position.Right} isConnectable={false} className="!w-3 !h-3 !bg-amber-400" />}
    </div>
  );
};
const nodeTypes = { step: BlockCard, summarize: BlockCard, turn: BlockCard, deliver: BlockCard };

/** A flow's blocks and wires as the canvas takes them, from flowGraph (the seam). */
function canvasOf(flow: ScheduleView): { nodes: RFNode[]; edges: Edge[] } {
  const g = flowGraph(flow);
  const targets = new Set(g.edges.map((e) => e.target));
  const sources = new Set(g.edges.map((e) => e.source));
  const nodes: RFNode[] = g.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: n.position,
    // the size is given so the canvas can draw before it measures (and on the server, in the test)
    width: 240,
    height: 96,
    data: { label: n.label, detail: n.detail, first: !targets.has(n.id), last: !sources.has(n.id) },
  }));
  const edges: Edge[] = g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }));
  return { nodes, edges };
}

/** The open flow on the canvas, read-only: nothing is dragged, wired or deleted here. */
const FlowCanvas: React.FC<{ flow: ScheduleView }> = ({ flow }) => {
  const { nodes, edges } = useMemo(() => canvasOf(flow), [flow]);
  return (
    <ReactFlowProvider key={flow.id} initialNodes={nodes} initialEdges={edges} initialWidth={800} initialHeight={400} fitView>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        colorMode="dark"
        defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
        fitView
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
}

/** The shelf as drawn from its data (the test renders this). */
export const FlowsShelfView: React.FC<FlowsShelfViewProps> = ({ flows, selectedId, onSelect, error, stewardOpen, onStewardOpen }) => {
  const open = flows.find((f) => f.id === selectedId) || null;
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
        {flows.length === 0 && !error && <p className="px-3 pb-3 text-[11px] text-neutral-500">No flows yet. Steward's automations show here.</p>}
        {error && <p className="px-3 pb-3 text-[11px] text-amber-300 break-words">{error}</p>}
      </aside>

      <section className="flex flex-1 min-w-0 min-h-0 flex-col">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800 text-xs min-w-0">
          <Workflow className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span className="text-neutral-200 font-semibold truncate min-w-0">{open ? open.name : 'Flows'}</span>
          {open && <span className="text-neutral-500 truncate min-w-0">{open.whenLabel}</span>}
          <span className="ml-auto" />
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

/** The Flows tab: reads the schedules once each time it is shown, picks the first, and keeps Steward's card folded. */
export const FlowsShelf: React.FC<{ active: boolean }> = ({ active }) => {
  const [flows, setFlows] = useState<ScheduleView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stewardOpen, setStewardOpen] = useState(() => panelOpen(store(), FLOWS_STEWARD_OPEN_KEY, false));
  const schedules = window.secondbrainDesktop?.schedules;
  useEffect(() => {
    if (!active || !schedules) return;
    let live = true;
    schedules
      .list()
      .then((list) => {
        if (!live) return;
        setFlows(list);
        setError(null);
        setSelectedId((id) => (id && list.some((f) => f.id === id) ? id : list[0]?.id || null));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [active, schedules]);
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
    />
  );
};
