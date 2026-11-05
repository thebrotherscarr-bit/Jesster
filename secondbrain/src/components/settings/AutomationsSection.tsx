import React, { useState } from 'react';
import { CalendarClock, Trash2, Plus, Save, PenLine } from 'lucide-react';
import type { ScheduleView, SchedulesBridge } from '../../types/desktop.ts';
import {
  AutomationForm,
  DAYS,
  LEGACY_LABEL,
  WHEN_KINDS,
  automationFormOf,
  automationsOf,
  blankAutomation,
  cleanError,
  flowsOf,
  isLegacy,
  removeAutomation,
  saveAutomation,
  setFlowEnabled,
} from '../../utils/flowSetup.ts';

const input = 'rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white';

export interface AutomationsSectionProps {
  bridge: SchedulesBridge;
  /** every schedule: the saved flows to pick from, and the automations (flows with a when, and legacy prompts) */
  flows: ScheduleView[];
  /** the flow open on the shelf: a new automation starts on it */
  selected: ScheduleView | null;
  /** the schedules as they stand after a save, a change or a delete */
  onChange: (list: ScheduleView[]) => void;
  /** start with the new-automation form open (the test renders it) */
  startNew?: boolean;
  /** an error to show from the start (the test renders it) */
  initialError?: string | null;
}

/**
 * The automations (ADR-0009, 2026-11-05; the operator: "set up the flows and then the automations are like where i set
 * up my different nightly jobs"): each is a saved flow, when it runs (plain choices) and whether it is on. Nothing else:
 * no flow is built here (that is + New flow), and there is no prompt type. A prompt-only schedule from before keeps
 * running and is listed as legacy, to turn off, delete, or make again as a flow. What schedules.cjs refuses is shown
 * under the form as it says it.
 */
export const AutomationsSection: React.FC<AutomationsSectionProps> = ({ bridge, flows, selected, onChange, startNew = false, initialError = null }) => {
  const saved = flowsOf(flows);
  const firstFlow = () => (selected && saved.some((f) => f.id === selected.id) ? selected.id : saved[0]?.id || '');
  const [form, setForm] = useState<AutomationForm | null>(() => (startNew ? blankAutomation(firstFlow()) : null));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const autos = automationsOf(flows);

  const act = async (fn: () => Promise<ScheduleView[]>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      after?.();
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<AutomationForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const close = () => (setForm(null), setEditingId(null));

  return (
    <section className="px-4 py-3 space-y-3" aria-label="Automations">
      <div className="flex items-center gap-2 text-white text-sm font-medium min-w-0">
        <CalendarClock className="w-4 h-4 text-sky-400 shrink-0" /> Automations
        <span className="flex-1" />
        <button type="button" data-new-automation onClick={() => (setEditingId(null), setForm(blankAutomation(firstFlow())), setError(null))}
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs font-normal text-sky-300 hover:text-white hover:bg-neutral-800">
          <Plus className="w-3.5 h-3.5" /> New automation
        </button>
      </div>
      <p className="text-[11px] text-neutral-400">
        An automation runs a saved flow at its time, with no cards: the flow you saved is the plan. Its result is filed as a
        note (tag <code>automation</code>), and on Telegram if the flow delivers there. Runs missed while the app was closed
        happen when it opens. Make or change a flow with + New flow or Edit blocks.
      </p>

      <ul className="space-y-1" aria-label="Automation list">
        {autos.map((a) => (
          <li key={a.id} data-automation={a.id} className="flex items-center gap-2 min-w-0 rounded-lg border border-neutral-800 px-2.5 py-1.5 text-xs">
            <span className="truncate text-neutral-100">{a.name}</span>
            {isLegacy(a) && (
              <span data-legacy title="A prompt-only automation from before flows: make it again as a flow with + New flow"
                className="shrink-0 rounded px-1 text-[10px] bg-amber-950 text-amber-300">{LEGACY_LABEL}</span>
            )}
            <span className="truncate text-neutral-500">{a.whenLabel}</span>
            <span className="flex-1" />
            <label className="flex items-center gap-1.5 text-neutral-400">
              <input type="checkbox" checked={a.enabled} aria-label={`Enable ${a.name}`} disabled={busy}
                onChange={(e) => act(() => setFlowEnabled(bridge, a.id, e.target.checked))} /> on
            </label>
            {!isLegacy(a) && (
              <button type="button" title="Change" aria-label={`Change ${a.name}`} disabled={busy}
                onClick={() => (setEditingId(a.id), setForm(automationFormOf(a)), setError(null))}
                className="p-1 rounded text-neutral-500 hover:text-white hover:bg-neutral-800 disabled:opacity-40">
                <PenLine className="w-3.5 h-3.5" />
              </button>
            )}
            <button type="button" title="Delete the automation (a flow stays)" aria-label={`Delete ${a.name}`} disabled={busy}
              onClick={() => act(() => removeAutomation(bridge, a), () => editingId === a.id && close())}
              className="p-1 rounded text-neutral-500 hover:text-rose-400 hover:bg-neutral-800 disabled:opacity-40">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
        {autos.length === 0 && <li className="text-[11px] text-neutral-500">No automations yet. Pick a saved flow with New automation.</li>}
      </ul>

      {form && (
        <form
          aria-label={editingId ? 'Change automation' : 'New automation'}
          className="grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            act(() => saveAutomation(bridge, form, editingId), close);
          }}
        >
          <select required value={form.flowId} onChange={(e) => set({ flowId: e.target.value })} aria-label="Flow" className={`sm:col-span-2 ${input}`}>
            <option value="" disabled>{saved.length ? 'Pick a saved flow' : 'No saved flows: make one with + New flow'}</option>
            {saved.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>

          <div className="sm:col-span-2 flex flex-wrap gap-2" role="group" aria-label="When">
            <select value={form.whenKind} onChange={(e) => set({ whenKind: e.target.value as AutomationForm['whenKind'] })} aria-label="How often" className={input}>
              {WHEN_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            {form.whenKind === 'weekly' && (
              <select value={form.day} onChange={(e) => set({ day: e.target.value })} aria-label="Day" className={input}>
                {DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
            {form.whenKind === 'once' && <input type="date" required value={form.date} onChange={(e) => set({ date: e.target.value })} aria-label="Date" className={input} />}
            {form.whenKind === 'every' ? (
              <>
                <input type="number" min={1} value={form.every} onChange={(e) => set({ every: Number(e.target.value) })} aria-label="Every" className={`${input} w-20`} />
                <select value={form.everyUnit} onChange={(e) => set({ everyUnit: e.target.value as 'h' | 'm' })} aria-label="Unit" className={input}>
                  <option value="h">hours</option>
                  <option value="m">minutes</option>
                </select>
              </>
            ) : (
              <input type="time" required value={form.time} onChange={(e) => set({ time: e.target.value })} aria-label="Time" className={input} />
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-label="On" /> on
          </label>
          <div className="justify-self-end flex gap-2">
            <button type="button" onClick={close} className="px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800">
              Cancel
            </button>
            <button type="submit" disabled={busy || !saved.length} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs text-white disabled:opacity-50">
              {editingId ? <Save className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {editingId ? 'Save changes' : 'Add automation'}
            </button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="text-xs text-amber-400 break-words">{error}</p>}
    </section>
  );
};
