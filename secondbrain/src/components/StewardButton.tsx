import React, { useCallback, useEffect, useState } from 'react';
import { Bot, X, Check, CircleAlert, RefreshCw } from 'lucide-react';
import { StewardStatus, StewardUses } from '../types/desktop.ts';

const EVERY_MS = 10000;

/**
 * Steward's button, beside Ollama (Kyle, 2026-11-02: "i want the steward button to have all of his info ... what
 * steward uses can be a tab under his button, same as the current integrations thing does it"). Green when his
 * service and the door answer; a click opens his panel: Status (every piece he runs on, by its port) and What he
 * uses (the tools SecondBrain's MCP serves him, his skills and his workspace). Integrations keeps the outside services.
 */
export const StewardButton: React.FC = () => {
  const api = window.secondbrainDesktop?.steward;
  const [status, setStatus] = useState<StewardStatus | null>(null);
  const [uses, setUses] = useState<StewardUses | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'status' | 'uses'>('status');

  const read = useCallback(async () => {
    if (!api) return;
    try {
      setStatus(await api.status());
    } catch {
      /* the next read tries again */
    }
  }, [api]);

  useEffect(() => {
    read();
    const t = setInterval(read, EVERY_MS);
    return () => clearInterval(t);
  }, [read]);

  useEffect(() => {
    if (open && tab === 'uses' && api) api.uses().then(setUses).catch(() => setUses(null));
  }, [open, tab, api]);

  if (!api) return null;
  const down = (status?.pieces || []).filter((p) => !p.up).map((p) => p.label);

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          read();
        }}
        aria-label="Steward: his service, the door and what he uses"
        title={status ? (status.ready ? 'Steward: his service and the door answer' : `Steward: not ready (${down.join(', ') || 'checking'})`) : 'Steward: checking'}
        className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-xs transition-colors shrink-0"
      >
        <Bot className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
        <span className={`text-[11px] font-medium whitespace-nowrap ${status?.ready ? 'text-emerald-400' : 'text-amber-400'}`}>Steward</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div role="dialog" aria-label="Steward" className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800 sticky top-0 bg-neutral-950 z-10">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <Bot className="w-4 h-4 text-emerald-400" /> Steward
              </h2>
              <div className="flex items-center gap-1">
                {(['status', 'uses'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-2.5 py-1 rounded-md text-xs ${tab === t ? 'bg-neutral-800 text-white font-semibold' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'}`}
                  >
                    {t === 'status' ? 'Status' : 'What he uses'}
                  </button>
                ))}
                <button onClick={read} className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800" aria-label="Check again">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800" aria-label="Close Steward">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {tab === 'status' ? (
              <section className="px-5 py-4 space-y-2" aria-label="Status">
                {(status?.pieces || []).map((p) => (
                  <div key={p.id} className="flex items-start gap-2 text-xs">
                    {p.up ? <Check className="w-3.5 h-3.5 mt-0.5 text-emerald-400 shrink-0" /> : <CircleAlert className="w-3.5 h-3.5 mt-0.5 text-amber-400 shrink-0" />}
                    <div className="flex-1">
                      <div className="text-neutral-100">
                        {p.label} <code className="text-neutral-500">127.0.0.1:{p.port}</code> <span className={p.up ? 'text-emerald-400' : 'text-amber-400'}>{p.up ? 'connected' : 'not answering'}</span>
                      </div>
                      <div className="text-neutral-500">{p.what}</div>
                    </div>
                  </div>
                ))}
                <div className="text-xs text-neutral-300 pt-2 border-t border-neutral-900">
                  Model loaded in Ollama: {status?.models.length ? status.models.join(', ') : <span className="text-neutral-500">none right now</span>}
                </div>
              </section>
            ) : (
              <section className="px-5 py-4 space-y-3 text-xs" aria-label="What he uses">
                {!uses ? (
                  <p className="text-neutral-500">Reading…</p>
                ) : (
                  <>
                    {!uses.shareOn && <p className="text-amber-400">SecondBrain's MCP is off (Settings → Share), so Steward cannot reach these.</p>}
                    <div>
                      <div className="text-neutral-100 mb-1">Tools SecondBrain's MCP serves him ({uses.tools.length})</div>
                      <div className="flex flex-wrap gap-1">
                        {uses.tools.map((t) => (
                          <code key={t} className="px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-300">{t}</code>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="text-neutral-100 mb-1">His file skills ({uses.fileSkills.length})</div>
                      <div className="text-neutral-400">{uses.fileSkills.join(', ') || 'none found'}</div>
                    </div>
                    <div>
                      <div className="text-neutral-100 mb-1">Skill notes from SecondBrain ({uses.skillNotes.length})</div>
                      <div className="text-neutral-400">{uses.skillNotes.join(', ') || 'none'}</div>
                    </div>
                    <div>
                      <div className="text-neutral-100 mb-1">His workspace</div>
                      <code className="text-neutral-400 break-all">{uses.workspace || 'not found'}</code>
                    </div>
                  </>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
};
