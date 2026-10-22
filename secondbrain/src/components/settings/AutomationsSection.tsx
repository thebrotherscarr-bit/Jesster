import React, { useEffect, useState } from 'react';
import { CalendarClock, Play, Trash2, Plus } from 'lucide-react';
import { ScheduleView } from '../../types/desktop.ts';

/** Scheduled automations: the agent runs a prompt on a schedule and files the answer as a note. */
export const AutomationsSection: React.FC = () => {
  const bridge = window.secondbrainDesktop?.schedules;
  const [list, setList] = useState<ScheduleView[]>([]);
  const [form, setForm] = useState({ name: '', prompt: '', when: 'weekdays 08:30', telegram: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    bridge?.list().then(setList);
  }, [bridge]);

  if (!bridge) return null;

  const act = async (key: string, fn: () => Promise<ScheduleView[]>) => {
    setBusy(key);
    setError(null);
    try {
      setList(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Automations">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <CalendarClock className="w-4 h-4 text-sky-400" /> Automations
      </div>
      <p className="text-xs text-neutral-400">
        The agent runs a prompt on a schedule and files the answer as a note (tag <code>automation</code>). Runs missed
        while the app was closed happen when it opens. Risky tools are refused when nobody is watching. You can also ask
        the agent: “every weekday at 8:30, summarize my todo list”.
      </p>
      {list.length > 0 && (
        <ul className="space-y-2">
          {list.map((s) => (
            <li key={s.id} className="rounded-lg border border-neutral-800 p-2.5 text-xs">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  aria-label={`Enable ${s.name}`}
                  onChange={(e) => act(s.id, () => bridge.update(s.id, { enabled: e.target.checked }))}
                />
                <span className="font-medium text-neutral-100">{s.name}</span>
                <span className="text-neutral-500">· {s.whenLabel}{s.deliver.includes('telegram') ? ' · → Telegram' : ''}</span>
                <span className="flex-1" />
                <button
                  title="Run now"
                  disabled={busy === s.id}
                  onClick={() => act(s.id, async () => (await bridge.run(s.id)).schedules)}
                  className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 disabled:opacity-40"
                >
                  <Play className={`w-3.5 h-3.5 ${busy === s.id ? 'animate-pulse' : ''}`} />
                </button>
                <button title="Delete" onClick={() => act(s.id, () => bridge.remove(s.id))} className="p-1 rounded text-neutral-500 hover:text-rose-400 hover:bg-neutral-800">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="mt-1 text-neutral-400 line-clamp-2">{s.prompt}</div>
              <div className="mt-1 text-[11px] text-neutral-500">
                {s.next ? `next ${new Date(s.next).toLocaleString()}` : 'not scheduled'}
                {s.lastRun ? ` · last ${new Date(s.lastRun).toLocaleString()} (${s.lastResult === 'ok' ? 'ok' : s.lastResult})` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          act('new', async () => {
            const r = await bridge.add({ name: form.name, prompt: form.prompt, when: form.when, deliver: form.telegram ? ['note', 'telegram'] : ['note'] });
            setForm({ ...form, name: '', prompt: '' });
            return r;
          });
        }}
      >
        <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name (e.g. Morning digest)"
          className="rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white" />
        <input required value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} placeholder="daily 08:30 · weekdays 08:30 · weekly mon 09:00 · every 3h"
          aria-label="When" className="rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white" />
        <textarea required value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={2}
          placeholder="What the agent should do each time" className="sm:col-span-2 rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white" />
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input type="checkbox" checked={form.telegram} onChange={(e) => setForm({ ...form, telegram: e.target.checked })} /> also send to Telegram
        </label>
        <button type="submit" disabled={busy === 'new'} className="justify-self-end flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs text-white disabled:opacity-50">
          <Plus className="w-3.5 h-3.5" /> Add automation
        </button>
      </form>
      {error && <p role="alert" className="text-xs text-amber-400">{error}</p>}
    </section>
  );
};
