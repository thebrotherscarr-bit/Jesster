import React, { useEffect, useState } from 'react';
import { KeyRound, Check, RefreshCw } from 'lucide-react';
import { IntegrationsState, ProviderId } from '../../types/desktop.ts';

const clean = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

const WHERE: Record<ProviderId, string> = {
  anthropic: 'console.anthropic.com → API keys',
  openai: 'platform.openai.com → API keys',
  google: 'aistudio.google.com → Get API key',
};

/** One model provider: key, model, test. */
const ProviderRow: React.FC<{
  p: IntegrationsState['providers'][number];
  onChange: (s: IntegrationsState) => void;
}> = ({ p, onChange }) => {
  const api = window.secondbrainDesktop!.integrations!;
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const m = await api.models(p.id);
      setModels(m);
      setMsg(`Key works: ${m.length} models.`);
    } catch (e) {
      setMsg(clean(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-neutral-800 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm text-white font-medium">
        {p.label}
        {p.hasKey ? <span className="text-[11px] text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> key {p.key}</span> : <span className="text-[11px] text-neutral-500">no key</span>}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={p.hasKey ? 'Replace the API key…' : `API key (${WHERE[p.id]})`}
          aria-label={`${p.label} API key`}
          className="flex-1 rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white"
        />
        <button
          disabled={!key.trim()}
          onClick={async () => {
            onChange(await api.set(p.id, { key }));
            setKey('');
            setMsg('Key saved.');
          }}
          className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs text-white disabled:opacity-40"
        >
          Save key
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-300">
        <span>Model</span>
        {models ? (
          <select value={p.model} onChange={async (e) => onChange(await api.set(p.id, { model: e.target.value }))} aria-label={`${p.label} model`} className="rounded bg-neutral-900 border border-neutral-800 px-1.5 py-1 text-xs text-white max-w-[16rem]">
            {!models.includes(p.model) && <option value={p.model}>{p.model || 'choose…'}</option>}
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : (
          <code className="text-neutral-400">{p.model || 'not chosen yet'}</code>
        )}
        <button disabled={!p.hasKey || busy} onClick={load} className="flex items-center gap-1 px-2 py-1 rounded-lg border border-neutral-700 hover:bg-neutral-800 disabled:opacity-40">
          <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} /> {models ? 'Reload' : 'Test key & list models'}
        </button>
      </div>
      {msg && <p className="text-xs text-neutral-400">{msg}</p>}
    </div>
  );
};

/**
 * Integrations: bring Claude, ChatGPT and Gemini into the app with your API keys. Sections of Settings (they were a window of their own, opened from the console); key values are never shown.
 */
export const IntegrationsSection: React.FC = () => {
  const api = window.secondbrainDesktop?.integrations;
  const [s, setS] = useState<IntegrationsState | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const update = (x: IntegrationsState) => setS(x);

  useEffect(() => {
    if (api) api.get().then(update).catch((e) => setNote(clean(e)));
  }, [api]);

  if (!api) return null;

  return (
    <>
            <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Models">
              <div className="flex items-center gap-2 text-white text-sm font-medium"><KeyRound className="w-4 h-4 text-amber-300" /> Claude, ChatGPT and Gemini in Jesster</div>
              <p className="text-xs text-neutral-400">
                Add an API key and pick the model in <b>Ask Brain</b>. It is briefed from your notes like the local model:
                the passages that answer the question are sent to that company with it. Keys stay in this PC's app
                settings, never in your notes.
              </p>
              {s?.providers.map((p) => <ProviderRow key={p.id} p={p} onChange={update} />)}
              <label className="flex items-center gap-2 text-xs text-neutral-200">
                <input type="checkbox" checked={Boolean(s?.capture)} onChange={async (e) => update(await api.set('capture', e.target.checked))} />
                Keep every exchange in today's capture note for that model (searchable later, like Manjuel's sittings)
              </label>
            </section>

            {/* "Their apps, using your notes" (the whole notes kernel written into Claude Desktop's and Gemini
                CLI's configs) was retired 2026-11-05 by ADR-0010: notes are central in Jesster. */}
            {note && <p className="px-5 py-2 text-xs text-neutral-300">{note}</p>}
    </>
  );
};
