import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import '@xyflow/react/dist/style.css';
import { Workflow, Play, Square, Save, Plus, Type, FileText, Search, Bot, Braces, NotebookPen, Eye, Loader2, Check, AlertTriangle, MinusCircle, Trash2 } from 'lucide-react';
import { Note, OllamaConfig } from '../types/index.ts';
import { IntegrationsState } from '../types/desktop.ts';
import { BlockData, BlockState, BlockType, Flow, describe, flowFromNoteBody, flowToNoteBody, runFlow } from '../flows/engine.ts';
import { makeRunners } from '../flows/runners.ts';
import { STARTERS } from '../flows/starters.ts';
import { SHELVES } from '../utils/shelves.ts';
import { queryOllama } from '../utils/ollama.ts';

type RFNode = Node<BlockData, BlockType>;

const BLOCKS: { type: BlockType; label: string; icon: React.ComponentType<{ className?: string }>; hint: string; color: string }[] = [
  { type: 'input', label: 'Input', icon: Type, hint: 'Text you type', color: 'text-sky-400' },
  { type: 'note', label: 'Note', icon: FileText, hint: "A note's text, by title", color: 'text-emerald-400' },
  { type: 'search', label: 'Search notes', icon: Search, hint: 'The notes that match', color: 'text-emerald-300' },
  { type: 'model', label: 'Ask a model', icon: Bot, hint: 'Local, Claude, ChatGPT or Gemini', color: 'text-amber-300' },
  { type: 'template', label: 'Template', icon: Braces, hint: 'Reshape text: {{input}}, {{date}}', color: 'text-violet-300' },
  { type: 'save', label: 'Save note', icon: NotebookPen, hint: 'Write the result to a note', color: 'text-rose-300' },
  { type: 'output', label: 'Output', icon: Eye, hint: 'Show the result', color: 'text-neutral-200' },
];
const BLOCK = Object.fromEntries(BLOCKS.map((b) => [b.type, b])) as Record<BlockType, (typeof BLOCKS)[number]>;

/** What the blocks read while a flow runs: their state, and who can answer. */
const RunContext = createContext<{ states: Record<string, BlockState>; cloud: IntegrationsState['providers']; localModel: string }>({ states: {}, cloud: [], localModel: '' });

const field = 'w-full rounded bg-neutral-950 border border-neutral-800 px-1.5 py-1 text-[11px] text-neutral-100 nodrag';

const StateBadge: React.FC<{ s?: BlockState }> = ({ s }) => {
  if (!s || s.status === 'waiting') return null;
  if (s.status === 'running') return <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />;
  if (s.status === 'done') return <span title={`${s.ms} ms`}><Check className="w-3.5 h-3.5 text-emerald-400" /></span>;
  if (s.status === 'skipped') return <span title={s.reason}><MinusCircle className="w-3.5 h-3.5 text-neutral-500" /></span>;
  return <span title={s.error}><AlertTriangle className="w-3.5 h-3.5 text-red-400" /></span>;
};

/** One block on the canvas: its settings, its wires, and what it produced. */
const BlockNode: React.FC<NodeProps<RFNode>> = ({ id, type, data, selected }) => {
  const { updateNodeData } = useReactFlow();
  const { states, cloud, localModel } = useContext(RunContext);
  const b = BLOCK[type];
  const s = states[id];
  const set = (patch: Partial<BlockData>) => updateNodeData(id, patch);
  const Icon = b.icon;
  return (
    <div className={`w-64 rounded-xl border bg-neutral-900 shadow-lg ${selected ? 'border-sky-500' : s?.status === 'error' ? 'border-red-700' : 'border-neutral-700'}`}>
      {type !== 'input' && <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-sky-500" />}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-neutral-800 text-xs font-semibold text-white">
        <Icon className={`w-3.5 h-3.5 ${b.color}`} /> <span className="flex-1">{b.label}</span> <StateBadge s={s} />
      </div>
      <div className="p-2 space-y-1.5">
        {type === 'input' && <textarea rows={3} className={field} value={String(data.text || '')} onChange={(e) => set({ text: e.target.value })} placeholder="Type the text this flow starts with" />}
        {type === 'note' && <input className={field} value={String(data.note || '')} onChange={(e) => set({ note: e.target.value })} placeholder="Note title (or wire a title in)" />}
        {type === 'search' && (
          <>
            <input className={field} value={String(data.text || '')} onChange={(e) => set({ text: e.target.value })} placeholder="Words (used when nothing is wired in)" />
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">Notes <input type="number" min={1} max={20} className={`${field} !w-14`} value={Number(data.limit) || 4} onChange={(e) => set({ limit: Number(e.target.value) })} /></label>
          </>
        )}
        {type === 'model' && (
          <>
            <select className={field} value={String(data.model || 'local')} onChange={(e) => set({ model: e.target.value })}>
              <option value="local">Local: {localModel}</option>
              {cloud.map((p) => <option key={p.id} value={p.id}>{p.label}: {p.model}</option>)}
            </select>
            <textarea rows={4} className={field} value={String(data.text || '')} onChange={(e) => set({ text: e.target.value })} placeholder={'Prompt. {{input}} = what is wired in, {{input1}} = the top wire…'} />
          </>
        )}
        {type === 'template' && <textarea rows={3} className={field} value={String(data.text || '')} onChange={(e) => set({ text: e.target.value })} placeholder={'{{input}}, {{input1}}, {{date}}'} />}
        {type === 'save' && (
          <>
            <input className={field} value={String(data.note || '')} onChange={(e) => set({ note: e.target.value })} placeholder="Note title, e.g. Digest {{date}}" />
            <div className="flex gap-1.5">
              <select className={field} value={String(data.mode || 'create')} onChange={(e) => set({ mode: e.target.value as 'create' | 'append' })}>
                <option value="create">New note each run</option>
                <option value="append">Add to that note</option>
              </select>
              <select className={field} value={String(data.shelf || 'inbox')} onChange={(e) => set({ shelf: e.target.value })}>
                {SHELVES.map((sh) => <option key={sh.id} value={sh.id}>{sh.label}</option>)}
              </select>
            </div>
            <input className={field} value={String(data.tags || '')} onChange={(e) => set({ tags: e.target.value })} placeholder="tags" />
          </>
        )}
        {type === 'output' && !(s && s.status === 'done') && <p className="text-[11px] text-neutral-500">Run the flow to see what arrives here.</p>}
        {s?.status === 'done' && type !== 'input' && (
          <pre className={`nodrag nowheel text-[10.5px] leading-snug text-neutral-300 bg-black/40 rounded p-1.5 overflow-auto whitespace-pre-wrap ${type === 'output' ? 'max-h-64' : 'max-h-24'}`}>{s.output || '(empty)'}</pre>
        )}
        {s?.status === 'error' && <p className="text-[11px] text-red-300">{s.error}</p>}
        {s?.status === 'skipped' && <p className="text-[11px] text-neutral-500">Skipped: {s.reason}</p>}
      </div>
      {type !== 'output' && <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-amber-400" />}
    </div>
  );
};
const nodeTypes = Object.fromEntries(BLOCKS.map((b) => [b.type, BlockNode]));

const toFlow = (nodes: RFNode[], edges: Edge[]): Flow => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.type as BlockType, position: n.position, data: n.data })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
});

interface FlowsViewProps {
  notes: Note[];
  ollamaConfig: OllamaConfig;
  onUpsertNote: (n: Note) => void;
  newNoteId: (prefix?: string) => string;
  integrationsVersion?: number;
}

const Canvas: React.FC<FlowsViewProps> = ({ notes, ollamaConfig, onUpsertNote, newNoteId, integrationsVersion = 0 }) => {
  const flows = useMemo(() => notes.filter((n) => n.tags.includes('flow')).sort((a, b) => b.updatedAt - a.updatedAt), [notes]);
  const [current, setCurrent] = useState<Note | null>(null);
  const [title, setTitle] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [states, setStates] = useState<Record<string, BlockState>>({});
  const [running, setRunning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cloud, setCloud] = useState<IntegrationsState['providers']>([]);
  const stop = useRef<AbortController | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const { screenToFlowPosition, fitView } = useReactFlow();
  const integrations = window.secondbrainDesktop?.integrations;

  useEffect(() => {
    integrations?.get().then((s) => setCloud(s.providers.filter((p) => p.hasKey && p.model))).catch(() => {});
  }, [integrations, integrationsVersion]);

  const load = (flow: Flow, note: Note | null, name: string) => {
    setNodes(flow.nodes.map((n) => ({ ...n, data: { ...n.data } })) as RFNode[]);
    setEdges(flow.edges.map((e) => ({ ...e })));
    setCurrent(note);
    setTitle(name);
    setStates({});
    setDirty(false);
    setMessage(null);
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  };

  const open = (n: Note) => {
    const f = flowFromNoteBody(n.content);
    if (!f) return setMessage(`"${n.title}" has no flow in it (a \`\`\`flow block).`);
    load(f, n, n.title);
  };

  const save = () => {
    const flow = toFlow(nodes, edges);
    const t = Date.now();
    const name = title.trim() || 'Untitled flow';
    const note: Note = current
      ? { ...current, title: name, content: flowToNoteBody(flow, `A flow: ${describe(flow)}.`), updatedAt: t }
      : { id: newNoteId('flow'), title: name, content: flowToNoteBody(flow, `A flow: ${describe(flow)}.`), category: 'scratchpads', tags: ['flow'], isPinned: false, createdAt: t, updatedAt: t };
    onUpsertNote(note);
    setCurrent(note);
    setTitle(name);
    setDirty(false);
    setMessage(`Saved as the note "${name}" (Scratchpads, tagged flow).`);
  };

  const add = (type: BlockType) => {
    const id = `${type}-${Math.random().toString(36).slice(2, 7)}`;
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const data: BlockData = type === 'model' ? { model: 'local', text: '{{input}}' } : type === 'save' ? { note: 'Flow output {{date}}', mode: 'create', shelf: 'inbox', tags: 'flow-output' } : {};
    setNodes((ns) => [...ns, { id, type, position: { x: center.x - 128 + ns.length * 12, y: center.y - 60 + ns.length * 12 }, data }]);
    setDirty(true);
  };

  const run = async () => {
    const flow = toFlow(nodes, edges);
    if (!flow.nodes.length) return setMessage('Add some blocks first.');
    const ctl = new AbortController();
    stop.current = ctl;
    setRunning(true);
    setMessage(null);
    setStates({});
    const runners = makeRunners({
      notes: () => notesRef.current,
      upsertNote: (n) => {
        notesRef.current = notesRef.current.some((x) => x.id === n.id) ? notesRef.current.map((x) => (x.id === n.id ? n : x)) : [n, ...notesRef.current];
        onUpsertNote(n);
      },
      newId: () => newNoteId('flow-out'),
      askLocal: (prompt) => {
        if (!ollamaConfig.isConnected || ollamaConfig.isSimulatedMode) throw new Error(`the local model is not connected (Ollama at ${ollamaConfig.hostUrl})`);
        return queryOllama(ollamaConfig.hostUrl, ollamaConfig.model, prompt, '');
      },
      askCloud: integrations
        ? async (provider, prompt, signal) => {
            const id = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const off = () => integrations.stop(id);
            signal?.addEventListener('abort', off);
            try {
              return (await integrations.chat(id, { provider: provider as 'anthropic', messages: [{ role: 'user', content: prompt }], question: `(flow "${title || 'untitled'}") ${prompt.slice(0, 200)}` })).text;
            } finally {
              signal?.removeEventListener('abort', off);
            }
          }
        : undefined,
    });
    try {
      const out = await runFlow(flow, runners, (id, s) => setStates((x) => ({ ...x, [id]: s })), { signal: ctl.signal });
      const failed = Object.values(out).filter((s) => s.status === 'error').length;
      setMessage(ctl.signal.aborted ? 'Stopped.' : failed ? `Finished with ${failed} block${failed > 1 ? 's' : ''} failed.` : 'Finished.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      stop.current = null;
    }
  };

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge({ ...c, animated: false }, es));
    setDirty(true);
  }, [setEdges]);

  const ctx = useMemo(() => ({ states, cloud, localModel: ollamaConfig.model }), [states, cloud, ollamaConfig.model]);
  const empty = !nodes.length;

  return (
    <div className="sb-flows flex-1 flex h-[calc(100vh-3.5rem)] bg-neutral-950 overflow-hidden">
      {/* our blocks draw their own card: drop React Flow's default box (its built-in input/output types share our names) */}
      <style>{'.sb-flows .react-flow__node{padding:0;border:none;background:transparent;width:auto;box-shadow:none;border-radius:0.75rem;text-align:left}'}</style>
      <aside className="w-60 shrink-0 border-r border-neutral-800 flex flex-col">
        <div className="p-3 space-y-1.5 border-b border-neutral-800">
          <div className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">New flow</div>
          {STARTERS.map((s) => (
            <button key={s.name} onClick={() => load(s.flow, null, s.name === 'Empty' ? '' : s.name)} title={s.about} className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-neutral-300 hover:bg-neutral-900 hover:text-white">
              <Plus className="inline w-3 h-3 mr-1" /> {s.name}
            </button>
          ))}
        </div>
        <div className="p-3 space-y-1 border-b border-neutral-800">
          <div className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">Blocks</div>
          {BLOCKS.map((b) => (
            <button key={b.type} onClick={() => add(b.type)} title={b.hint} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-neutral-300 hover:bg-neutral-900 hover:text-white">
              <b.icon className={`w-3.5 h-3.5 ${b.color}`} /> {b.label}
            </button>
          ))}
        </div>
        <div className="p-3 flex-1 overflow-y-auto space-y-1">
          <div className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">Your flows ({flows.length})</div>
          {flows.length === 0 && <p className="text-[11px] text-neutral-500">Saved flows are notes tagged <code>flow</code>.</p>}
          {flows.map((f) => (
            <button key={f.id} onClick={() => open(f)} className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs ${current?.id === f.id ? 'bg-neutral-800 text-white' : 'text-neutral-300 hover:bg-neutral-900'}`}>
              {f.title}
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-2.5 border-b border-neutral-800 flex items-center gap-2">
          <Workflow className="w-4 h-4 text-sky-400 shrink-0" />
          <input value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} placeholder="Name this flow" aria-label="Flow name" className="flex-1 min-w-0 bg-transparent text-sm font-semibold text-white placeholder-neutral-600 focus:outline-none" />
          {message && <span className="text-xs text-neutral-400 truncate max-w-[40%]" title={message}>{message}</span>}
          <button onClick={save} disabled={empty} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40">
            <Save className="w-3.5 h-3.5" /> {dirty || !current ? 'Save' : 'Saved'}
          </button>
          {running ? (
            <button onClick={() => stop.current?.abort()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-xs text-white">
              <Square className="w-3.5 h-3.5" /> Stop
            </button>
          ) : (
            <button onClick={run} disabled={empty} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white disabled:opacity-40">
              <Play className="w-3.5 h-3.5" /> Run
            </button>
          )}
        </div>
        <div className="flex-1 relative">
          <RunContext.Provider value={ctx}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={(c) => { onNodesChange(c); if (c.some((x) => x.type !== 'select' && x.type !== 'dimensions')) setDirty(true); }}
              onEdgesChange={(c) => { onEdgesChange(c); if (c.some((x) => x.type !== 'select')) setDirty(true); }}
              onConnect={onConnect}
              colorMode="dark"
              deleteKeyCode={['Backspace', 'Delete']}
              defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
              fitView
            >
              <Background gap={20} />
              <Controls />
            </ReactFlow>
          </RunContext.Provider>
          {empty && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center text-sm text-neutral-500 max-w-sm">
                Pick a starter on the left, or add blocks and drag a wire from a block's right dot to the next block's left dot. Run sends the text through them in order.
              </div>
            </div>
          )}
        </div>
        {current && (
          <div className="px-4 py-1.5 border-t border-neutral-800 text-[11px] text-neutral-500 flex items-center gap-2">
            Kept in the note "{current.title}". Select a block or wire and press Delete to remove it.
            <Trash2 className="w-3 h-3" />
          </div>
        )}
      </div>
    </div>
  );
};

/** Flows: blocks wired output to input, run in order. */
export const FlowsView: React.FC<FlowsViewProps> = (props) => (
  <ReactFlowProvider>
    <Canvas {...props} />
  </ReactFlowProvider>
);
