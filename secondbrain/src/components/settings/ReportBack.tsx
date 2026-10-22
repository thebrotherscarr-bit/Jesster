import React, { useEffect, useState } from 'react';
import { Send } from 'lucide-react';

/** Report back: push a status note (no keys) to the bridge's outbox for Claude to read. */
export const ReportBack: React.FC = () => {
  const desk = window.secondbrainDesktop;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    desk?.settings?.get().then((s) => setAuto(Boolean((s.inbox as { reportOnUpdate?: boolean }).reportOnUpdate)));
  }, [desk]);

  if (!desk?.inbox?.report) return null;

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await desk.inbox!.report!(note);
      setResult({ ok: true, text: `Sent at ${new Date(r.at).toLocaleTimeString()} to ${r.file}. Claude can read it now.` });
      setNote('');
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 pt-2 border-t border-neutral-900">
      <div className="text-xs text-neutral-200 font-medium">Report back to Claude</div>
      <p className="text-xs text-neutral-400">
        Pushes a short status note to the bridge's <code>outbox/status.md</code> with your git login: build, Ollama and its
        models, what's switched on, MCP servers (Atlas) and their errors. Never keys or tokens.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Anything to tell Claude (optional)"
        aria-label="Note for Claude"
        className="w-full rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={send}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs text-white disabled:opacity-50"
        >
          <Send className="w-3.5 h-3.5" /> {busy ? 'Sending…' : 'Report back'}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              desk.settings!.set('inbox', { reportOnUpdate: e.target.checked });
            }}
          />
          also after each update
        </label>
      </div>
      {result && <p className={`text-xs ${result.ok ? 'text-emerald-300' : 'text-amber-300'}`}>{result.text}</p>}
    </div>
  );
};
