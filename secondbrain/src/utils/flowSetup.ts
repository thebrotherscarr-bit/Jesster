import type { ScheduleSpec, ScheduleView, SchedulesBridge } from '../types/desktop.ts';

/**
 * The Flows shelf's Set up panel and Run now (the operator, 2026-11-05: "need a way to actually run the things ... where
 * do i input the stuff that you asked me to set?"). The automations moved here from the Agent tab's console; the IPC
 * and the stored schedules are the same (electron/agent/schedules.cjs: add, edit, update, remove, run), so the checks
 * are schedules.cjs parseWhen and workflows.cjs validateSteps, and their messages are shown as they come back.
 */

/** The steps a recipe can pick: workflows.cjs STEPS less the two an eval workflow sets (flowSetup.test holds them equal). */
export const RECIPE_STEPS = ['repo_log', 'merged_prs', 'releases', 'eval_bars', 'plan_left', 'versions', 'pull_ff'] as const;

export const WHEN_KINDS = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Once a week' },
  { id: 'every', label: 'Every few hours or minutes' },
  { id: 'once', label: 'Once' },
] as const;
export type WhenKind = (typeof WHEN_KINDS)[number]['id'];
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/**
 * What the automation does: a prompt to Steward (or, kept for the old ones, the local agent), a recipe, an eval run,
 * or blocks made on the canvas that this form cannot show (Set up then changes only its name, when and Telegram).
 */
export type FlowType = 'steward' | 'local' | 'recipe' | 'evals' | 'canvas';

export interface FlowForm {
  name: string;
  type: FlowType;
  whenKind: WhenKind;
  time: string;
  day: string;
  every: number;
  everyUnit: 'h' | 'm';
  date: string;
  prompt: string;
  steps: string[];
  summarize: string;
  telegram: boolean;
  sets: string;
  runs: number;
}

export const blankForm = (): FlowForm => ({
  name: '',
  type: 'steward',
  whenKind: 'weekdays',
  time: '08:30',
  day: 'mon',
  every: 3,
  everyUnit: 'h',
  date: '',
  prompt: '',
  steps: [],
  summarize: '',
  telegram: false,
  sets: 'aider-py',
  runs: 1,
});

/** The plain choices as the "when" text schedules.cjs parseWhen reads. */
export function whenText(f: Pick<FlowForm, 'whenKind' | 'time' | 'day' | 'every' | 'everyUnit' | 'date'>): string {
  if (f.whenKind === 'weekly') return `weekly ${f.day} ${f.time}`;
  if (f.whenKind === 'every') return `every ${f.every}${f.everyUnit}`;
  if (f.whenKind === 'once') return `once ${f.date} ${f.time}`;
  return `${f.whenKind} ${f.time}`;
}

/** A schedule's "when" text read back into the plain choices (what parseWhen accepts; anything else starts at weekdays). */
export function whenChoices(text: string): Pick<FlowForm, 'whenKind' | 'time' | 'day' | 'every' | 'everyUnit' | 'date'> {
  const base = { whenKind: 'weekdays' as WhenKind, time: '08:30', day: 'mon', every: 3, everyUnit: 'h' as const, date: '' };
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const pad = (s: string) => s.replace(/^(\d):/, '0$1:');
  let m;
  if ((m = /^(daily|weekdays) (\d{1,2}:\d{2})$/.exec(t))) return { ...base, whenKind: m[1] as WhenKind, time: pad(m[2]) };
  if ((m = /^weekly (\w{3})\w* (\d{1,2}:\d{2})$/.exec(t))) return { ...base, whenKind: 'weekly', day: m[1], time: pad(m[2]) };
  if ((m = /^every (\d+) ?(m|min|minutes?|h|hours?)$/.exec(t))) return { ...base, whenKind: 'every', every: Number(m[1]), everyUnit: m[2].startsWith('h') ? 'h' : 'm' };
  if ((m = /^once (\d{4}-\d\d-\d\d)[ t](\d{1,2}:\d{2})$/.exec(t))) return { ...base, whenKind: 'once', date: m[1], time: pad(m[2]) };
  return base;
}

const stepName = (x: string | { step: string }) => (typeof x === 'string' ? x : String(x.step));

/** A schedule as the form shows it, to edit. */
export function formOf(s: ScheduleView): FlowForm {
  const f: FlowForm = { ...blankForm(), ...whenChoices(s.whenText), name: s.name, prompt: s.prompt || '', telegram: (s.deliver || []).includes('telegram') };
  const steps = Array.isArray(s.steps) ? s.steps : [];
  const names = steps.map(stepName);
  const start = steps.find((x) => typeof x !== 'string' && x.step === 'eval_start') as { sets?: unknown; runs?: unknown } | undefined;
  // the form's eval workflow is exactly eval_start then eval_wait; anything more (a canvas flow) is kept whole
  if (start && names.join() === 'eval_start,eval_wait' && !s.summarize) return { ...f, type: 'evals', sets: Array.isArray(start.sets) ? start.sets.join(', ') : '', runs: Number(start.runs) || 1 };
  if (steps.length && !start && names.every((x) => (RECIPE_STEPS as readonly string[]).includes(x))) return { ...f, type: 'recipe', steps: names, summarize: s.summarize || '' };
  if (steps.length) return { ...f, type: 'canvas', steps: names, summarize: s.summarize || '' };
  return { ...f, type: s.backend === 'steward' ? 'steward' : 'local' };
}

/** The form as the spec schedules.cjs add (or edit) takes. An edit sends every field, so a type change clears the old one's. */
export function specOf(f: FlowForm): ScheduleSpec {
  const deliver = f.telegram ? ['note', 'telegram'] : ['note'];
  const base = { name: f.name.trim(), when: whenText(f), deliver };
  // its blocks are the canvas's: only the name, the when and where it goes change here
  if (f.type === 'canvas') return base as ScheduleSpec;
  if (f.type === 'evals') {
    const sets = f.sets.split(',').map((x) => x.trim()).filter(Boolean);
    return {
      ...base,
      prompt: `eval_start ${sets.join(', ')}, ${f.runs} run(s) each; wait for BAR DONE`,
      backend: 'local',
      steps: [{ step: 'eval_start', sets, runs: f.runs }, 'eval_wait'],
      summarize: '',
    };
  }
  if (f.type === 'recipe') return { ...base, prompt: f.prompt.trim(), backend: 'steward', steps: [...f.steps], summarize: f.summarize.trim() };
  return { ...base, prompt: f.prompt.trim(), backend: f.type, steps: [], summarize: '' };
}

/** An IPC error in plain words: the message parseWhen or validateSteps threw, without Electron's wrapper. */
export const cleanError = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/** Save the form: a new automation (add), or a change to the open one (edit). The schedules as they stand after. */
export async function saveFlow(bridge: SchedulesBridge, f: FlowForm, editingId: string | null): Promise<ScheduleView[]> {
  const spec = specOf(f);
  if (!editingId) {
    // add stores no empty steps or summarize
    const { steps, summarize, ...rest } = spec;
    return bridge.add({ ...rest, ...(steps && steps.length ? { steps } : {}), ...(summarize ? { summarize } : {}) });
  }
  if (!bridge.edit) throw new Error('this build of the app cannot change an automation; update it');
  return bridge.edit(editingId, spec);
}

export const removeFlow = (bridge: SchedulesBridge, id: string) => bridge.remove(id);
export const setFlowEnabled = (bridge: SchedulesBridge, id: string, enabled: boolean) => bridge.update(id, { enabled });

/** Run now: the same path the scheduler takes (schedules:run → runSchedule). */
export const runFlow = (bridge: SchedulesBridge, id: string) => bridge.run(id);

/** Why Run now is held, in plain words, or null when it can run. */
export function runBlocked(s: Pick<ScheduleView, 'running' | 'pending'> | null, busy: boolean): string | null {
  if (!s) return 'Pick a flow first';
  if (s.running) return 'It is running now';
  if (s.pending) return `It is waiting on ${s.pending.label || s.pending.tag || 'its run'}`;
  if (busy) return 'Steward is busy with a conversation; try when he is done';
  return null;
}
