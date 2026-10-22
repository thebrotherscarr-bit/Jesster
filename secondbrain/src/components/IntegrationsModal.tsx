import React, { useEffect, useState } from 'react';
import { X, Plug, KeyRound, Check, Copy, RefreshCw, MonitorSmartphone } from 'lucide-react';
import { IntegrationsState, ProviderId } from '../types/desktop.ts';
import { VoiceSection } from './settings/VoiceSection.tsx';
import { VoiceSettings } from '../voice/useVoice.ts';

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
 * Integrations (next to Live): bring Claude, ChatGPT and Gemini into the app
 * with your API keys, connect their own apps to your notes, and voice.
 */
export const IntegrationsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  voice?: VoiceSettings;
  onVoiceChange?: (v: Partial<VoiceSettings>) => void;
  onChanged?: (s: IntegrationsState) => void;
}> = ({ isOpen, onClose, voice, onVoiceChange, onChanged }) => {
  const api = window.secondbrainDesktop?.integrations;
  const [s, setS] = useState<IntegrationsState | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const update = (x: IntegrationsState) => {
    setS(x);
    onChanged?.(x);
  };

  useEffect(() => {
    if (isOpen && api) api.get().then(update).catch((e) => setNote(clean(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, api]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div role="dialog" aria-label="Integrations" className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800 sticky top-0 bg-neutral-950 z-10">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2"><Plug className="w-4 h-4 text-sky-400" /> Integrations</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800" aria-label="Close integrations">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!api ? (
          <p className="px-5 py-4 text-xs text-neutral-400">Integrations run in the SecondBrain desktop app.</p>
        ) : (
          <>
            <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Models">
              <div className="flex items-center gap-2 text-white text-sm font-medium"><KeyRound className="w-4 h-4 text-amber-300" /> Claude, ChatGPT and Gemini in SecondBrain</div>
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

            <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Their apps">
              <div className="flex items-center gap-2 text-white text-sm font-medium"><MonitorSmartphone className="w-4 h-4 text-emerald-300" /> Their apps, using your notes</div>
              <p className="text-xs text-neutral-400">
                Adds your notes to their own apps as an MCP server named <code>secondbrain</code>: the notes kernel over
                this vault, the same one Manjuel and Claude Code use. They can then search, read and write your notes.
              </p>
              {!s?.kernel ? (
                <p className="text-xs text-amber-400">The notes kernel (notes/cli.py) was not found beside this vault. Set it in Settings → Archive digger.</p>
              ) : (
                <>
                  {s.apps.map((a) => (
                    <div key={a.id} className="flex items-center gap-2 text-xs">
                      <span className="w-28 text-neutral-200">{a.label}</span>
                      <span className="flex-1 text-neutral-500 break-all">{a.file}</span>
                      {a.connected ? (
                        <span className="text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> added</span>
                      ) : (
                        <button
                          onClick={async () => {
                            try {
                              const r = await api.connectApp(a.id);
                              update(r);
                              setNote(`Added to ${a.label}${r.wrote.backup ? `; the old config is kept as ${r.wrote.backup}` : ''}. Restart ${a.label} to load it.`);
                            } catch (e) {
                              setNote(clean(e));
                            }
                          }}
                          className="px-2.5 py-1 rounded-lg border border-neutral-700 text-neutral-200 hover:bg-neutral-800"
                        >
                          Add
                        </button>
                      )}
                    </div>
                  ))}
                  {s.claudeCode && (
                    <div className="space-y-1">
                      <div className="text-xs text-neutral-200">Claude Code: run this once in a terminal</div>
                      <div className="flex gap-2">
                        <pre className="flex-1 text-[11px] bg-black/50 border border-neutral-800 rounded-lg p-2 text-neutral-200 whitespace-pre-wrap break-all">{s.claudeCode}</pre>
                        <button
                          onClick={async () => {
                            await navigator.clipboard.writeText(s.claudeCode!);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          }}
                          aria-label="Copy the Claude Code command"
                          className="self-start p-2 rounded-lg border border-neutral-700 text-neutral-200 hover:bg-neutral-800"
                        >
                          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-neutral-500">
                    ChatGPT's own apps reach MCP servers on the internet, not programs on this PC, so ChatGPT comes in
                    through its API key above instead.
                  </p>
                </>
              )}
              {note && <p className="text-xs text-neutral-300">{note}</p>}
            </section>
          </>
        )}

        {voice && onVoiceChange && <VoiceSection voice={voice} onChange={onVoiceChange} />}
      </div>
    </div>
  );
};
