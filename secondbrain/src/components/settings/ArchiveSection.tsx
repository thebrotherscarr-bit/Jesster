import React, { useEffect, useState } from 'react';
import { Archive, FolderPlus, FilePlus, X, Pause, Square, Play, RotateCcw, PenLine } from 'lucide-react';
import { ArchiveSettings, ArchiveState } from '../../types/desktop.ts';

const clean = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/**
 * The archive digger: everything from the start of the work (chat exports,
 * notes, docs, code, git history, voice memos) dug into raw notes, distilled by
 * the local model, and written up as topic notes, a timeline, decisions, ideas
 * and open threads. The notes kernel does the work; this panel drives it.
 */
export const ArchiveSection: React.FC = () => {
  const desk = window.secondbrainDesktop;
  const [cfg, setCfg] = useState<ArchiveSettings | null>(null);
  const [state, setState] = useState<ArchiveState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desk?.archive) return;
    desk.archive.get().then((c) => {
      setCfg(c);
      setState(c.state);
      if (c.found) desk.archive!.status().catch((e) => setError(clean(e)));
    });
    return desk.archive.onState(setState);
  }, [desk]);

  if (!desk?.archive || !desk.pick) return null;
  const a = desk.archive;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      const m = clean(e);
      if (m !== 'stopped') setError(m);
    }
  };
  const save = async (patch: { python?: string; cli?: string; model?: string }) => act(async () => setCfg(await a.set(patch)));
  const addSource = async (kind: 'folder' | 'file') => {
    const p = await desk.pick!(kind, kind === 'folder' ? 'Add a folder to the archive' : 'Add an export zip or file');
    if (p) await act(() => a.sources({ add: p }));
  };

  const status = state?.status;
  const d = status?.distill;
  const busy = Boolean(state?.job);
  const pct = d && d.notes_total ? Math.round(((d.notes_done || 0) / d.notes_total) * 100) : 0;
  const btn = 'flex items-center gap-1 px-2.5 py-1 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40';

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-4" aria-label="Archive">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <Archive className="w-4 h-4 text-emerald-300" /> Archive digger
      </div>
      <p className="text-xs text-neutral-400">
        Digs through everything from the start: chat exports (ChatGPT, Claude, Gemini, Claude Code), notes, docs, code,
        git history and voice memos. Then the local model distills it into topic notes, a timeline, decisions, ideas and
        open threads. Nothing leaves this PC. Each stage can be stopped and run again.
      </p>

      <div className="space-y-2">
        <div className="text-xs text-neutral-200 font-medium">Notes kernel</div>
        <p className="text-xs text-neutral-400">
          {cfg?.found ? (
            <>Using <code className="break-all">{cfg.found}</code></>
          ) : (
            <>Not found beside this vault. Choose <code>notes/cli.py</code> in your Jesster checkout.</>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-300">
          <button onClick={async () => { const p = await desk.pick!('file', 'Choose notes/cli.py'); if (p) await save({ cli: p }); }} className={btn}>Choose cli.py…</button>
          {cfg?.cli && <button onClick={() => save({ cli: '' })} className={btn}>Find it beside the vault</button>}
          <label className="flex items-center gap-1.5">Python
            <input defaultValue={cfg?.python || 'python'} onBlur={(e) => save({ python: e.target.value })} aria-label="Python command" className="w-24 rounded bg-neutral-900 border border-neutral-800 px-1.5 text-xs text-white" />
          </label>
          <label className="flex items-center gap-1.5">Model
            <input defaultValue={cfg?.model || ''} placeholder="gpt-oss:20b" onBlur={(e) => save({ model: e.target.value })} aria-label="Distilling model" className="w-32 rounded bg-neutral-900 border border-neutral-800 px-1.5 text-xs text-white" />
          </label>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-neutral-200 font-medium">1. Sources</div>
        {status?.sources?.length ? (
          <ul className="space-y-1">
            {status.sources.map((s) => (
              <li key={s} className="flex items-center gap-2 text-xs text-neutral-300">
                <span className="break-all flex-1">{s}</span>
                <button onClick={() => act(() => a.sources({ remove: s }))} disabled={busy} aria-label={`Remove ${s}`} className="text-neutral-500 hover:text-white disabled:opacity-40"><X className="w-3 h-3" /></button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-neutral-500">No sources yet. Add the archive folder, export zips, or <code>%USERPROFILE%\.claude\projects</code>.</p>
        )}
        <div className="flex gap-2">
          <button onClick={() => addSource('folder')} disabled={busy || !cfg?.found} className={btn}><FolderPlus className="w-3 h-3" /> Add folder</button>
          <button onClick={() => addSource('file')} disabled={busy || !cfg?.found} className={btn}><FilePlus className="w-3 h-3" /> Add zip or file</button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-neutral-200 font-medium">2. Dig</div>
        <p className="text-xs text-neutral-400">
          Reads every source into raw notes tagged <code>archive</code>. Running it again reads only what changed. Audio
          needs <code>transcribe_cmd</code> in the kernel's config.
        </p>
        <div className="flex items-center gap-2">
          <button onClick={() => act(a.dig)} disabled={busy || !status?.sources?.length} className={btn}><Play className="w-3 h-3" /> Dig</button>
          <span className="text-xs text-neutral-400">{status ? `${status.raw_notes} raw notes` : ''}{state?.job === 'digging' ? ' · digging…' : ''}</span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-neutral-200 font-medium">3. Distill</div>
        <p className="text-xs text-neutral-400">
          The model reads the raw notes oldest first, a chunk at a time. Pause finishes the chunk in hand; Stop ends it at
          once. Either way, Distill carries on from there.
        </p>
        {d?.started && (
          <div className="space-y-1">
            <div className="h-1.5 rounded bg-neutral-800 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-xs text-neutral-400">
              {d.notes_done} of {d.notes_total} notes · {d.topics} topics · {d.decisions} decisions · {d.ideas} ideas ·{' '}
              {d.threads_open} open threads · {d.events} events{d.failed_chunks ? ` · ${d.failed_chunks} chunks skipped` : ''}
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {state?.job === 'distilling' ? (
            <>
              <button onClick={() => a.pause()} disabled={state.pausing} className={btn}><Pause className="w-3 h-3" /> {state.pausing ? 'Pausing…' : 'Pause'}</button>
              <button onClick={() => a.stop()} className={btn}><Square className="w-3 h-3" /> Stop</button>
            </>
          ) : (
            <>
              <button onClick={() => act(() => a.distill())} disabled={busy || !status?.raw_notes} className={btn}><Play className="w-3 h-3" /> {d?.started && !d.finished ? 'Resume' : 'Distill'}</button>
              {d?.started && <button onClick={() => { if (window.confirm('Start distilling again from the first note? What was distilled so far is set aside.')) act(() => a.distill({ restart: true })); }} disabled={busy} className={btn}><RotateCcw className="w-3 h-3" /> Start over</button>}
            </>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-neutral-200 font-medium">4. Write the notes</div>
        <p className="text-xs text-neutral-400">
          Writes <code>Archive: overview</code>, one note per topic, the timeline, decisions, ideas and open threads, each
          linking to its sources. Writing again replaces them, so keep your own words in other notes.
        </p>
        <div className="flex items-center gap-2">
          <button onClick={() => act(a.write)} disabled={busy || !d?.chunks} className={btn}><PenLine className="w-3 h-3" /> Write notes</button>
          {d?.written && <span className="text-xs text-neutral-400">last written {new Date(d.written).toLocaleString()}</span>}
        </div>
      </div>

      {(error || state?.error) && <p className="text-xs text-red-300">{error || state?.error}</p>}
    </section>
  );
};
