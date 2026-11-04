import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ScrollText } from 'lucide-react';
import { ServiceInfo } from '../types/desktop.ts';
import { LOG_LINES, kindWord, lastLines, ollamaSwitch, ollamaToggle, statusTone, statusWord } from '../utils/services.ts';

const EVERY_MS = 3000;

const clean = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/**
 * The Servers shelf (was the Services window's, now in the Agent tab's console): one row per server SecondBrain runs
 * or watches, with its port, status, who runs it, Start, Stop, Restart and its log; read every EVERY_MS while shown.
 */
export const ServersShelf: React.FC = () => {
  const api = window.secondbrainDesktop?.services;
  const [servers, setServers] = useState<ServiceInfo[] | null>(null);
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [openLogs, setOpenLogs] = useState<string[]>([]);

  const readLog = useCallback(
    async (id: string) => {
      if (!api) return;
      try {
        const r = await api.log(id, LOG_LINES);
        const text = r.ok ? r.text || (r.file ? '' : 'This server keeps no log here.') : `Could not read the log: ${r.error}`;
        setLogs((l) => ({ ...l, [id]: lastLines(text, LOG_LINES) }));
      } catch (e) {
        setLogs((l) => ({ ...l, [id]: `Could not read the log: ${clean(e)}` }));
      }
    },
    [api]
  );

  const read = useCallback(async () => {
    if (!api) return;
    try {
      setServers(await api.list());
      setListError('');
    } catch (e) {
      setListError(clean(e));
    }
  }, [api]);

  useEffect(() => {
    read();
    const t = setInterval(read, EVERY_MS);
    return () => clearInterval(t);
  }, [read]);

  // an open log reads again with each check of the list
  useEffect(() => {
    if (!openLogs.length) return;
    const t = setInterval(() => openLogs.forEach(readLog), EVERY_MS);
    return () => clearInterval(t);
  }, [openLogs, readLog]);

  const control = async (id: string, action: 'start' | 'stop' | 'restart') => {
    if (!api) return;
    setBusy(`${id}:${action}`);
    setErrors((e) => ({ ...e, [id]: '' }));
    try {
      const r = await api.control(id, action);
      if (!r.ok) setErrors((e) => ({ ...e, [id]: r.error || `Could not ${action} it.` }));
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: clean(err) }));
    } finally {
      setBusy(null);
      read();
      if (openLogs.includes(id)) readLog(id);
    }
  };

  // 'SecondBrain runs Ollama': services.ollama.enabled through settings:set; turned on while the Ollama app still has
  // 11434, the row's refusal (quit the app first) is said at once. Nothing is started or stopped by the switch itself.
  const runsOllama = async (on: boolean) => {
    const settings = window.secondbrainDesktop?.settings;
    if (!api || !settings) return;
    setBusy('ollama:switch');
    setErrors((e) => ({ ...e, ollama: '' }));
    try {
      await settings.set(...ollamaSwitch(on));
      const list = await api.list();
      setServers(list);
      const row = list.find((x) => x.id === 'ollama');
      if (on && row && row.why) setErrors((e) => ({ ...e, ollama: row.why || '' }));
    } catch (err) {
      setErrors((e) => ({ ...e, ollama: clean(err) }));
    } finally {
      setBusy(null);
    }
  };

  const toggleLog = (id: string) => {
    if (openLogs.includes(id)) {
      setOpenLogs((o) => o.filter((x) => x !== id));
    } else {
      setOpenLogs((o) => [...o, id]);
      readLog(id);
    }
  };

  if (!api) return <p className="text-xs text-neutral-400">Servers run in the desktop app.</p>;

  return (
    <section className="space-y-2" aria-label="Servers" data-console="Services">
      <div className="flex items-center gap-2 text-xs font-semibold text-neutral-200">
        Servers
        <button onClick={read} className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md border border-neutral-700 text-[11px] font-normal text-neutral-300 hover:bg-neutral-800" aria-label="Check again">
          <RefreshCw className="w-3 h-3" /> Check again
        </button>
      </div>
      {listError && <p className="text-xs text-amber-400">{listError}</p>}
      <div className="rounded-xl border border-neutral-800 p-3 space-y-3">
        {(servers || []).map((s) => {
          const tone = statusTone(s.status);
          const logOpen = openLogs.includes(s.id);
          return (
            <div key={s.id} className="space-y-1.5">
              <div className="flex items-start gap-2 text-xs">
                <span className={`w-2 h-2 mt-1 rounded-full shrink-0 ${tone.dot}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-neutral-100 [overflow-wrap:anywhere]">
                    {s.label} <code className="text-neutral-500">{s.port ? `:${s.port}` : 'no port'}</code> <span className={tone.text}>{statusWord(s.status)}</span>
                  </div>
                  <div className="text-neutral-500">{kindWord(s.kind)}</div>
                  {s.id === 'ollama' && s.settings && (() => {
                    const t = ollamaToggle(s.settings);
                    return (
                      <label className="flex items-center gap-2 mt-1 text-xs text-neutral-200">
                        <input type="checkbox" checked={t.on} disabled={Boolean(t.locked) || busy !== null} aria-label="SecondBrain runs Ollama" onChange={(e) => runsOllama(e.target.checked)} />
                        SecondBrain runs Ollama{t.locked && <span className="text-neutral-500">({t.locked})</span>}
                      </label>
                    );
                  })()}
                </div>
              </div>
              <div className="flex flex-wrap gap-1 pl-4">
                {(['start', 'stop', 'restart'] as const).map((action) => (
                  <button
                    key={action}
                    onClick={() => control(s.id, action)}
                    disabled={!s.canControl || busy !== null}
                    aria-label={`${action} ${s.label}`}
                    className="px-2 py-0.5 rounded-md border border-neutral-700 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                  >
                    {busy === `${s.id}:${action}` ? '…' : action[0].toUpperCase() + action.slice(1)}
                  </button>
                ))}
                <button
                  onClick={() => toggleLog(s.id)}
                  aria-label={`${logOpen ? 'Hide' : 'Show'} the log of ${s.label}`}
                  aria-pressed={logOpen}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-md border border-neutral-700 text-[11px] hover:bg-neutral-800 ${logOpen ? 'bg-neutral-800 text-white' : 'text-neutral-300'}`}
                >
                  <ScrollText className="w-3 h-3" /> Log
                </button>
              </div>
              {errors[s.id] && <p className="pl-4 text-xs text-amber-400 [overflow-wrap:anywhere]">{errors[s.id]}</p>}
              {s.error && <p className="pl-4 text-xs text-amber-400 [overflow-wrap:anywhere]">{s.error}</p>}
              {logOpen && (
                <pre className="ml-4 max-h-64 overflow-auto rounded-lg bg-neutral-900 border border-neutral-800 p-2 text-[11px] leading-snug font-mono text-neutral-300 whitespace-pre">
                  {logs[s.id] === undefined ? 'Reading…' : logs[s.id] || 'The log is empty.'}
                </pre>
              )}
            </div>
          );
        })}
        {!servers && !listError && <p className="text-xs text-neutral-500">Checking…</p>}
        {servers && !servers.length && <p className="text-xs text-neutral-500">No servers listed.</p>}
      </div>
    </section>
  );
};
