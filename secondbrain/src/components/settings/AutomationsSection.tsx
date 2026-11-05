import React, { useEffect, useState } from 'react';
import { CalendarClock, Trash2, Plus, Save } from 'lucide-react';
import type { ScheduleView, SchedulesBridge } from '../../types/desktop.ts';
import { DAYS, FlowForm, RECIPE_STEPS, WHEN_KINDS, blankForm, cleanError, formOf, removeFlow, saveFlow, setFlowEnabled } from '../../utils/flowSetup.ts';

const input = 'rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white';

export interface AutomationsSectionProps {
  bridge: SchedulesBridge;
  /** the flow open on the shelf: the one Set up changes, enables or deletes */
  selected: ScheduleView | null;
  /** the schedules as they stand after a save, a change or a delete */
  onChange: (list: ScheduleView[]) => void;
  /** start on a new automation rather than the open one (the test renders both) */
  startNew?: boolean;
  /** an error to show from the start (the test renders it) */
  initialError?: string | null;
}

/**
 * The automations, set up on the Flows shelf (moved here from the Agent tab's console, 2026-11-05): a new one, or the
 * open flow changed, turned on or off, or deleted. The when is plain choices; what it does is a prompt to Steward, a
 * recipe (steps from the fixed list, a summarize prompt, where it goes) or an eval workflow. What schedules.cjs and
 * workflows.cjs refuse is shown under the form as they say it.
 */
export const AutomationsSection: React.FC<AutomationsSectionProps> = ({ bridge, selected, onChange, startNew = false, initialError = null }) => {
  const [isNew, setIsNew] = useState(startNew || !selected);
  const [form, setForm] = useState<FlowForm>(() => (!startNew && selected ? formOf(selected) : blankForm()));
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const editing = !isNew && selected ? selected : null;

  // the open flow changed on the shelf: show it, unless a new one is being written
  useEffect(() => {
    if (isNew) return;
    setForm(selected ? formOf(selected) : blankForm());
    setError(null);
    if (!selected) setIsNew(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

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
  const set = (patch: Partial<FlowForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <section className="px-4 py-3 space-y-3" aria-label="Automations">
      {/* which one the form is for, side by side (the operator, 2026-11-05: "its just change the current startup, no
          create a new one"): the open flow, or a new automation */}
      <div className="flex items-center gap-2 text-white text-sm font-medium min-w-0">
        <CalendarClock className="w-4 h-4 text-sky-400 shrink-0" />
        <div role="tablist" aria-label="Which automation" className="flex min-w-0 rounded-lg border border-neutral-800 p-0.5 text-xs font-normal">
          {selected && (
            <button type="button" role="tab" aria-selected={!isNew} onClick={() => (setIsNew(false), setForm(formOf(selected)), setError(null))}
              className={`truncate max-w-[16rem] px-2 py-1 rounded-md ${!isNew ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white'}`}>
              Change “{selected.name}”
            </button>
          )}
          <button type="button" role="tab" aria-selected={isNew} data-new-automation onClick={() => (setIsNew(true), setForm(blankForm()), setError(null))}
            className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-md ${isNew ? 'bg-sky-600 text-white' : 'text-sky-300 hover:text-white'}`}>
            <Plus className="w-3.5 h-3.5" /> New automation
          </button>
        </div>
        <span className="flex-1" />
        {editing && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-neutral-400 font-normal">
              <input type="checkbox" checked={editing.enabled} aria-label={`Enable ${editing.name}`} disabled={busy}
                onChange={(e) => act(() => setFlowEnabled(bridge, editing.id, e.target.checked))} /> on
            </label>
            <button type="button" title="Delete" aria-label={`Delete ${editing.name}`} disabled={busy}
              onClick={() => act(() => removeFlow(bridge, editing.id), () => (setIsNew(true), setForm(blankForm())))}
              className="p-1 rounded text-neutral-500 hover:text-rose-400 hover:bg-neutral-800 disabled:opacity-40">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
      <p className="text-[11px] text-neutral-400">
        Each automation runs at its time and files its result as a note (tag <code>automation</code>), and on Telegram if
        you tick it. Runs missed while the app was closed happen when it opens. A prompt goes to Steward as an
        automation's turn: his cards wait on you, and are answered No after 10 minutes. An eval workflow waits until
        Steward is not working on a request.
      </p>
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          act(() => saveFlow(bridge, form, editing ? editing.id : null), () => {
            if (!editing) setForm(blankForm());
          });
        }}
      >
        <input required value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Name (e.g. Morning digest)" aria-label="Name" className={input} />
        <select value={form.type} onChange={(e) => set({ type: e.target.value as FlowForm['type'] })} aria-label="What it does" className={input}>
          <option value="steward">Steward prompt</option>
          <option value="recipe">Recipe (steps, then a summary)</option>
          <option value="evals">Eval workflow</option>
          {form.type === 'local' && <option value="local">Local agent prompt</option>}
          {form.type === 'canvas' && <option value="canvas">Blocks made on the canvas</option>}
        </select>

        <div className="sm:col-span-2 flex flex-wrap gap-2" role="group" aria-label="When">
          <select value={form.whenKind} onChange={(e) => set({ whenKind: e.target.value as FlowForm['whenKind'] })} aria-label="How often" className={input}>
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

        {form.type === 'evals' && (
          <div className="sm:col-span-2 flex gap-2">
            <input required value={form.sets} onChange={(e) => set({ sets: e.target.value })} placeholder="Eval sets, e.g. aider-py or small, steps" aria-label="Eval sets" className={`flex-1 ${input}`} />
            <select value={form.runs} onChange={(e) => set({ runs: Number(e.target.value) })} aria-label="Runs of each set" className={input}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n} run{n > 1 ? 's' : ''}</option>)}
            </select>
          </div>
        )}
        {form.type === 'recipe' && (
          <>
            <fieldset className="sm:col-span-2 flex flex-wrap gap-x-3 gap-y-1" aria-label="Steps">
              <legend className="text-[11px] text-neutral-500 mb-1">Steps, in this order</legend>
              {RECIPE_STEPS.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-xs text-neutral-300">
                  <input type="checkbox" checked={form.steps.includes(s)}
                    onChange={(e) => set({ steps: e.target.checked ? RECIPE_STEPS.filter((x) => x === s || form.steps.includes(x)) : form.steps.filter((x) => x !== s) })} />
                  {s}
                </label>
              ))}
            </fieldset>
            <textarea value={form.summarize} onChange={(e) => set({ summarize: e.target.value })} rows={2} aria-label="Summarize prompt"
              placeholder="What Steward writes from what the steps gathered (optional)" className={`sm:col-span-2 ${input}`} />
          </>
        )}
        {form.type === 'canvas' && (
          <p className="sm:col-span-2 text-[11px] text-neutral-400">
            Its blocks ({form.steps.join(' → ')}{form.summarize ? ' → summarize' : ''}) are changed on the canvas with Edit blocks; here you set its
            name, when it runs and Telegram.
          </p>
        )}
        {(form.type === 'steward' || form.type === 'local') && (
          <textarea required value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={2} aria-label="Prompt"
            placeholder="What Steward should do each time" className={`sm:col-span-2 ${input}`} />
        )}

        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input type="checkbox" checked={form.telegram} onChange={(e) => set({ telegram: e.target.checked })} /> also send to Telegram
        </label>
        <div className="justify-self-end flex gap-2">
          {isNew && selected && (
            <button type="button" onClick={() => (setIsNew(false), setForm(formOf(selected)), setError(null))}
              className="px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800">
              Cancel
            </button>
          )}
          <button type="submit" disabled={busy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs text-white disabled:opacity-50">
            {editing ? <Save className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {editing ? 'Save changes' : 'Add automation'}
          </button>
        </div>
      </form>
      {error && <p role="alert" className="text-xs text-amber-400 break-words">{error}</p>}
    </section>
  );
};
