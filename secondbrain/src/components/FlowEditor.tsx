import React, { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Boxes, Bot, FlaskConical, Send, Save, X, Trash2 } from 'lucide-react';
import { BLOCKS, BlockId, BlockKind, EdGraph, EdNode, KINDS, Recipe, blockOf, graphToRecipe, newNode } from '../utils/flowEditor.ts';
import { CARD } from '../utils/flowGraph.ts';

/**
 * The Flows shelf's editor (the operator, 2026-11-05): the palette on the left is also the legend (every block's name,
 * its colour by kind and one line of what it does), the canvas in the middle (drag a block in, or click it; wire a
 * block's right dot to the next one's left dot, as the old Flows tab did; Delete removes the selected), and the
 * clicked block's settings in a small card on the right. Save turns the canvas into a recipe (utils/flowEditor.ts
 * graphToRecipe) and says inline why it cannot when it cannot.
 */
export const KIND_STYLE: Record<BlockKind, { icon: React.ComponentType<{ className?: string }>; text: string; dot: string; border: string }> = {
  gather: { icon: Boxes, text: 'text-emerald-400', dot: 'bg-emerald-400', border: 'border-emerald-800' },
  eval: { icon: FlaskConical, text: 'text-violet-300', dot: 'bg-violet-300', border: 'border-violet-800' },
  steward: { icon: Bot, text: 'text-amber-300', dot: 'bg-amber-300', border: 'border-amber-800' },
  deliver: { icon: Send, text: 'text-rose-300', dot: 'bg-rose-300', border: 'border-rose-800' },
};

type EdData = { block: BlockId; set?: string; runs?: number; prompt?: string };
type EdRFNode = Node<EdData, 'block'>;

const DRAG_TYPE = 'application/x-secondbrain-block';
const handle = '!w-3 !h-3';

/** A block's one line on the canvas: its setting, or what it does. */
function blockLine(d: EdData): string {
  if (d.block === 'eval_start') return d.set ? `${d.set} · ${d.runs || 1} run${(d.runs || 1) > 1 ? 's' : ''}` : 'pick a set';
  if (d.block === 'summarize') return d.prompt ? d.prompt : 'write a prompt';
  return blockOf(d.block).what;
}

/** One block on the editable canvas: wires in on the left (and top), out on the right (and bottom). */
const EditBlock: React.FC<NodeProps<EdRFNode>> = ({ data, selected }) => {
  const b = blockOf(data.block);
  const k = KIND_STYLE[b.kind];
  const Icon = k.icon;
  return (
    <div data-edit-block={data.block} style={{ width: CARD.width, minHeight: CARD.height }}
      className={`rounded-xl border bg-neutral-900 shadow-lg ${selected ? 'border-sky-500' : k.border}`}>
      <Handle id="left" type="target" position={Position.Left} className={`${handle} !bg-sky-500`} />
      <Handle id="top" type="target" position={Position.Top} className={`${handle} !bg-sky-500`} />
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-neutral-800 text-xs font-semibold text-white">
        <Icon className={`w-3.5 h-3.5 ${k.text}`} /> <span className="flex-1">{b.label}</span>
        <span className={`text-[10px] font-normal ${k.text}`}>{KINDS[b.kind].title}</span>
      </div>
      <p className="p-2 text-[11px] text-neutral-300 break-words line-clamp-3">{blockLine(data)}</p>
      {b.kind !== 'deliver' && (
        <>
          <Handle id="right" type="source" position={Position.Right} className={`${handle} !bg-amber-400`} />
          <Handle id="bottom" type="source" position={Position.Bottom} className={`${handle} !bg-amber-400`} />
        </>
      )}
    </div>
  );
};
const nodeTypes = { block: EditBlock };

const toRF = (g: EdGraph): { nodes: EdRFNode[]; edges: Edge[] } => ({
  nodes: g.nodes.map((n) => ({
    id: n.id,
    type: 'block',
    position: n.position,
    width: CARD.width,
    height: CARD.height,
    data: { block: n.block, ...(n.set !== undefined ? { set: n.set } : {}), ...(n.runs !== undefined ? { runs: n.runs } : {}), ...(n.prompt !== undefined ? { prompt: n.prompt } : {}) },
  })),
  edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, type: 'smoothstep' })),
});

const fromRF = (nodes: EdRFNode[], edges: Edge[]): EdGraph => ({
  nodes: nodes.map((n) => ({ id: n.id, position: n.position, ...n.data })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
});

/** The palette, which is also the legend: every block with its kind's colour and what it does, always shown. */
export const Palette: React.FC<{ onAdd: (b: BlockId) => void }> = ({ onAdd }) => (
  <aside aria-label="Blocks" className="flex w-60 shrink-0 min-h-0 flex-col border-r border-neutral-800">
    <div className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">Blocks</div>
    <p className="px-3 pb-2 text-[11px] text-neutral-500">Drag one onto the canvas, or click it. Wire a right dot to the next block's left dot.</p>
    <ul className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1" aria-label="Palette">
      {BLOCKS.map((b) => {
        const k = KIND_STYLE[b.kind];
        const Icon = k.icon;
        return (
          <li key={b.id}>
            <button
              type="button"
              data-palette={b.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, b.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onAdd(b.id)}
              className={`block w-full text-left rounded-lg border ${k.border} bg-neutral-900 px-2 py-1.5 hover:bg-neutral-800 cursor-grab`}
            >
              <span className="flex items-center gap-1.5 text-xs text-white font-medium">
                <Icon className={`w-3.5 h-3.5 ${k.text}`} /> {b.label}
              </span>
              <span className="block text-[11px] text-neutral-400 leading-snug">{b.what}</span>
            </button>
          </li>
        );
      })}
    </ul>
    <div aria-label="Legend" className="border-t border-neutral-800 px-3 py-2 space-y-0.5">
      {(Object.keys(KINDS) as BlockKind[]).map((kind) => (
        <p key={kind} className="flex items-start gap-1.5 text-[11px] text-neutral-400">
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${KIND_STYLE[kind].dot}`} />
          <span>
            <b className={`font-semibold ${KIND_STYLE[kind].text}`}>{KINDS[kind].title}</b> {KINDS[kind].what}
          </span>
        </p>
      ))}
      <p className="text-[11px] text-neutral-500 pt-1">A flow is one line: gather and eval blocks, then Summarize, then Note or Telegram.</p>
    </div>
  </aside>
);

const field = 'w-full rounded-lg bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs text-neutral-100';

/** The clicked block's settings: an eval set's set and runs, Summarize's prompt; every block can be deleted. */
const BlockSettings: React.FC<{ node: EdRFNode; sets: string[]; onChange: (patch: Partial<EdData>) => void; onDelete: () => void; onClose: () => void }> = ({ node, sets, onChange, onDelete, onClose }) => {
  const b = blockOf(node.data.block);
  const k = KIND_STYLE[b.kind];
  return (
    <aside aria-label="Block settings" className="absolute right-3 top-3 z-10 w-64 rounded-xl border border-neutral-700 bg-neutral-900 shadow-xl">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-neutral-800 text-xs font-semibold text-white">
        <k.icon className={`w-3.5 h-3.5 ${k.text}`} /> <span className="flex-1">{b.label}</span>
        <button type="button" onClick={onClose} aria-label="Close the block's settings" className="p-0.5 rounded text-neutral-400 hover:text-white"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="p-3 space-y-2">
        <p className="text-[11px] text-neutral-400">{b.what}</p>
        {node.data.block === 'eval_start' && (
          <>
            <label className="block text-[11px] text-neutral-400">
              Set
              <input list="flow-eval-sets" className={field} value={node.data.set || ''} onChange={(e) => onChange({ set: e.target.value })} placeholder="e.g. small" aria-label="Eval set" />
            </label>
            <datalist id="flow-eval-sets">{sets.map((s) => <option key={s} value={s} />)}</datalist>
            <label className="block text-[11px] text-neutral-400">
              Runs
              <select className={field} value={node.data.runs || 1} onChange={(e) => onChange({ runs: Number(e.target.value) })} aria-label="Runs">
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </>
        )}
        {node.data.block === 'summarize' && (
          <label className="block text-[11px] text-neutral-400">
            Prompt
            <textarea rows={4} className={field} value={node.data.prompt || ''} onChange={(e) => onChange({ prompt: e.target.value })} placeholder="What Steward writes from what was gathered" aria-label="Summarize prompt" />
          </label>
        )}
        <button type="button" onClick={onDelete} className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-rose-400">
          <Trash2 className="w-3.5 h-3.5" /> Delete this block
        </button>
      </div>
    </aside>
  );
};

export interface FlowEditorProps {
  initial: EdGraph;
  name: string;
  /** a new flow (or a copy): saved without a when */
  isNew: boolean;
  /** the eval set names offered in Eval set's box */
  sets: string[];
  /** save the recipe; resolves to an error to show, or null when it saved */
  onSave: (name: string, recipe: Recipe) => Promise<string | null>;
  onCancel: () => void;
  /** an error to show from the start (the test renders it) */
  initialError?: string | null;
}

const EditorInner: React.FC<FlowEditorProps> = ({ initial, name: name0, isNew, sets, onSave, onCancel, initialError = null }) => {
  const start = useMemo(() => toRF(initial), [initial]);
  const [nodes, setNodes, onNodesChange] = useNodesState<EdRFNode>(start.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(start.edges);
  const [name, setName] = useState(name0);
  const [error, setError] = useState<string | null>(initialError);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const add = useCallback(
    (block: BlockId, position?: { x: number; y: number }) => {
      setNodes((ns) => {
        // clicked, not dropped: under the lowest block, so it is seen
        const at = position || { x: 0, y: ns.length ? Math.max(...ns.map((n) => n.position.y)) + CARD.height + 60 : 0 };
        const n: EdNode = newNode(block, at, ns);
        return [...ns, ...toRF({ nodes: [n], edges: [] }).nodes];
      });
      setError(null);
    },
    [setNodes],
  );
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, type: 'smoothstep' }, es)), [setEdges]);
  const node = nodes.find((n) => n.id === picked) || null;
  const patch = (p: Partial<EdData>) => setNodes((ns) => ns.map((n) => (n.id === picked ? { ...n, data: { ...n.data, ...p } } : n)));
  const remove = () => {
    setNodes((ns) => ns.filter((n) => n.id !== picked));
    setEdges((es) => es.filter((e) => e.source !== picked && e.target !== picked));
    setPicked(null);
  };
  const save = async () => {
    if (!name.trim()) return setError('Give the flow a name.');
    const r = graphToRecipe(fromRF(nodes, edges));
    if (!r.ok) return setError(r.error);
    setSaving(true);
    setError(await onSave(name, r.recipe));
    setSaving(false);
  };

  return (
    <div className="flex flex-1 min-w-0 min-h-0">
      <Palette onAdd={(b) => add(b)} />
      <section className="flex flex-1 min-w-0 min-h-0 flex-col">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800 text-xs min-w-0">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this flow" aria-label="Flow name"
            className="min-w-0 flex-1 max-w-xs rounded-lg bg-neutral-900 border border-neutral-800 px-2 py-1 text-xs text-white" />
          <span className="text-neutral-500 truncate">{isNew ? 'new: runs on Run now until you schedule it in Set up' : 'editing its blocks; its schedule stays as it is'}</span>
          <span className="ml-auto" />
          <button type="button" onClick={onCancel} className="shrink-0 px-2 py-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-900">Cancel</button>
          <button type="button" data-save-flow onClick={save} disabled={saving}
            className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50">
            <Save className="w-3.5 h-3.5" /> Save
          </button>
        </div>
        {error && <p role="alert" className="px-4 py-1 text-[11px] text-amber-300 break-words border-b border-neutral-900">{error}</p>}
        <div
          className="flex-1 relative min-h-0"
          aria-label="Flow canvas"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            const b = e.dataTransfer.getData(DRAG_TYPE) as BlockId;
            if (!b || !BLOCKS.some((x) => x.id === b)) return;
            e.preventDefault();
            add(b, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
        >
          {!nodes.length && (
            <p className="absolute inset-x-0 top-1/3 z-[1] pointer-events-none text-center text-sm text-neutral-500">Drag blocks here from the left, then wire them in a line.</p>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setPicked(n.id)}
            onPaneClick={() => setPicked(null)}
            onNodesDelete={(ds) => ds.some((d) => d.id === picked) && setPicked(null)}
            deleteKeyCode={['Backspace', 'Delete']}
            colorMode="dark"
            defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
            defaultViewport={{ x: 32, y: 32, zoom: 1 }}
            minZoom={0.3}
            maxZoom={1.5}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {node && <BlockSettings node={node} sets={sets} onChange={patch} onDelete={remove} onClose={() => setPicked(null)} />}
        </div>
      </section>
    </div>
  );
};

/** The editor in its own React Flow provider (the shelf keys it by the flow, so opening another starts fresh). */
export const FlowEditor: React.FC<FlowEditorProps> = (props) => {
  const rf = useMemo(() => toRF(props.initial), [props.initial]);
  return (
    <ReactFlowProvider initialNodes={rf.nodes} initialEdges={rf.edges} initialWidth={800} initialHeight={400}>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
};
