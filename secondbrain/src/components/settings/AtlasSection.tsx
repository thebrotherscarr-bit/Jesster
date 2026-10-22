import React, { useEffect, useState } from 'react';
import { Landmark, Copy, Check, RefreshCw } from 'lucide-react';
import { ShareState, McpState } from '../../types/desktop.ts';

/**
 * The Atlas bridge, both ways: SecondBrain's agent uses Atlas's door
 * (atlas-mcp), and Atlas/Manjuel read (and, if allowed, write) these notes.
 */
export const AtlasSection: React.FC<{ onConnected?: (s: McpState) => void }> = ({ onConnected }) => {
  const desk = window.secondbrainDesktop;
  const [share, setShare] = useState<ShareState | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ exe: '', ground: '', python: 'python', engine: true, trusted: false, all: false });
  const [status, setStatus] = useState<string | null>(null);
  const [saved, setSaved] = useState<typeof form | null>(null);

  useEffect(() => {
    desk?.share?.get(false).then(setShare);
    desk?.settings?.get().then((s) => {
      const a = { ...form, ...((s.atlas || {}) as Partial<typeof form>) };
      setForm(a);
      setSaved(a);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk]);

  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(form);
  const save = async () => {
    await desk?.settings?.set('atlas', form);
    setSaved(form);
  };

  if (!desk?.share || !desk.atlas || !desk.pick) return null;

  const envLines = share ? `MANJUEL_MCP_SECONDBRAIN=${share.url}\nMANJUEL_MCP_SECONDBRAIN_KEY=${share.key}` : '';

  const connect = async () => {
    await save();
    setStatus('Starting atlas-mcp…');
    try {
      const s = await desk.atlas!.connect(form);
      const a = s.status.find((x) => x.name === 'atlas');
      setStatus(a?.status === 'connected' ? `Connected: the agent has ${a.offered ?? a.tools.length} of Atlas's ${a.tools.length} tools.` : `Not connected: ${a?.error || 'unknown error'}`);
      onConnected?.(s);
    } catch (e) {
      setStatus(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
  };

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-4" aria-label="Atlas">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <Landmark className="w-4 h-4 text-amber-300" /> Atlas &amp; Manjuel
      </div>

      <div className="space-y-2">
        <div className="text-xs text-neutral-200 font-medium">Use Atlas from SecondBrain</div>
        <p className="text-xs text-neutral-400">
          Starts Atlas's door (<code>atlas-mcp</code>) for the agent, carrying your Manjuel ground. Atlas keeps its own law: its
          writing calls are still held for your card.
        </p>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <input readOnly value={form.exe} placeholder="atlas-mcp.exe" aria-label="atlas-mcp path" className="rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white" />
          <button onClick={async () => { const p = await desk.pick!('exe', 'Choose atlas-mcp.exe'); if (p) setForm({ ...form, exe: p }); }} className="px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800">Choose…</button>
          <input readOnly value={form.ground} placeholder="Manjuel ground (the folder with manjuel.py)" aria-label="Manjuel ground" className="rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white" />
          <button onClick={async () => { const p = await desk.pick!('folder', 'Choose the Manjuel ground'); if (p) setForm({ ...form, ground: p }); }} className="px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800">Choose…</button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-300">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.engine} onChange={(e) => setForm({ ...form, engine: e.target.checked })} /> run Manjuel as the engine, with</label>
          <input value={form.python} onChange={(e) => setForm({ ...form, python: e.target.value })} aria-label="Python command" className="w-24 rounded bg-neutral-900 border border-neutral-800 px-1.5 text-xs text-white" />
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.all} onChange={(e) => setForm({ ...form, all: e.target.checked })} /> offer all of Atlas's tools (default: the core 27)</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.trusted} onChange={(e) => setForm({ ...form, trusted: e.target.checked })} /> don't ask me before each Atlas call</label>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={save} disabled={!dirty} className="px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40">{dirty ? 'Save' : 'Saved'}</button>
          <button onClick={connect} disabled={!form.exe || !form.ground} className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-xs text-white disabled:opacity-40">Save &amp; connect Atlas</button>
        </div>
        {status && <p className="text-xs text-neutral-300">{status}</p>}
      </div>

      <div className="space-y-2">
        <div className="text-xs text-neutral-200 font-medium">Share these notes with Atlas &amp; Manjuel</div>
        <p className="text-xs text-neutral-400">
          Serves your notes over MCP on this PC only (loopback, with a key) while SecondBrain is open. Manjuel reaches it
          with its own <code>mcp_call</code>: put the two lines below in Manjuel's <code>.env</code>.
        </p>
        <label className="flex items-center gap-2 text-xs text-neutral-200">
          <input type="checkbox" checked={Boolean(share?.enabled)} aria-label="Share notes with Atlas" onChange={async (e) => setShare(await desk.share!.set({ enabled: e.target.checked }))} />
          Share (read: search, read, list notes, sessions, skills)
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <input type="checkbox" checked={Boolean(share?.writes)} disabled={!share?.enabled} onChange={async (e) => setShare(await desk.share!.set({ writes: e.target.checked }))} />
          Also allow writing notes and the todo list
        </label>
        {share?.enabled && (
          <>
            <pre className="text-[11px] bg-black/50 border border-neutral-800 rounded-lg p-2 text-neutral-200 whitespace-pre-wrap break-all">{envLines}</pre>
            <div className="flex gap-2">
              <button onClick={async () => { const s = await desk.share!.get(true); setShare(s); setRevealed(true); }} className="px-2.5 py-1 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800">
                {revealed ? 'Key shown' : 'Show key'}
              </button>
              <button
                onClick={async () => {
                  const s = await desk.share!.get(true);
                  await navigator.clipboard.writeText(`MANJUEL_MCP_SECONDBRAIN=${s.url}\nMANJUEL_MCP_SECONDBRAIN_KEY=${s.key}`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800"
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} Copy .env lines
              </button>
              <button onClick={async () => { setShare(await desk.share!.set({ rotate: true })); setRevealed(true); }} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-neutral-800 text-xs text-neutral-400 hover:text-white hover:bg-neutral-800">
                <RefreshCw className="w-3 h-3" /> New key
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
