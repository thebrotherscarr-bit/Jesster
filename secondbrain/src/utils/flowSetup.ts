import type { ScheduleView, SchedulesBridge } from '../types/desktop.ts';

/**
 * The Flows shelf's Set up panel and Run now. ADR-0009 (Steward docs/decisions, 2026-11-05; the operator: "open ended
 * prompt, nah. a flow thats gonna just work that doesnt need gates, yea."): a flow is an ordered chain of steps, made
 * with + New flow and saved by itself; an automation is {flow, when, on/off} and nothing else. There is no prompt type.
 * An automation is kept on its flow (the flow's when and enabled in schedules.json), so the IPC and the checks are the
 * same (electron/agent/schedules.cjs: edit, update, remove, run; parseWhen), and their messages are shown as they come
 * back. A prompt-only schedule saved before ADR-0009 is legacy: it keeps running, and is shown as one to convert.
 */

export const WHEN_KINDS = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Once a week' },
  { id: 'every', label: 'Every few hours or minutes' },
  { id: 'once', label: 'Once' },
] as const;
export type WhenKind = (typeof WHEN_KINDS)[number]['id'];
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** What a legacy prompt-only schedule is called wherever it is shown. */
export const LEGACY_LABEL = 'legacy: convert to a flow';

/** A flow: a saved chain of steps (what + New flow makes). */
export const isFlow = (s: Pick<ScheduleView, 'steps'>) => Array.isArray(s.steps) && s.steps.length > 0;
/** A prompt-only schedule from before ADR-0009: it keeps running, shown as legacy. */
export const isLegacy = (s: Pick<ScheduleView, 'steps'>) => !isFlow(s);
/** An automation: a flow with a when (a flow without one runs only on Run now), or a legacy schedule. */
export const isAutomation = (s: Pick<ScheduleView, 'steps' | 'whenText'>) => isLegacy(s) || Boolean(String(s.whenText || '').trim());

export const flowsOf = (list: ScheduleView[]) => list.filter(isFlow);
export const automationsOf = (list: ScheduleView[]) => list.filter(isAutomation);

/** An automation as Set up edits it: which saved flow, when (plain choices), and on or off. Nothing else. */
export interface AutomationForm {
  flowId: string;
  whenKind: WhenKind;
  time: string;
  day: string;
  every: number;
  everyUnit: 'h' | 'm';
  date: string;
  enabled: boolean;
}

export const blankAutomation = (flowId = ''): AutomationForm => ({
  flowId,
  whenKind: 'weekdays',
  time: '08:30',
  day: 'mon',
  every: 3,
  everyUnit: 'h',
  date: '',
  enabled: true,
});

/** The plain choices as the "when" text schedules.cjs parseWhen reads. */
export function whenText(f: Pick<AutomationForm, 'whenKind' | 'time' | 'day' | 'every' | 'everyUnit' | 'date'>): string {
  if (f.whenKind === 'weekly') return `weekly ${f.day} ${f.time}`;
  if (f.whenKind === 'every') return `every ${f.every}${f.everyUnit}`;
  if (f.whenKind === 'once') return `once ${f.date} ${f.time}`;
  return `${f.whenKind} ${f.time}`;
}

/** A schedule's "when" text read back into the plain choices (what parseWhen accepts; anything else starts at weekdays). */
export function whenChoices(text: string): Pick<AutomationForm, 'whenKind' | 'time' | 'day' | 'every' | 'everyUnit' | 'date'> {
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

/** An automation as the form shows it, to change. */
export const automationFormOf = (s: ScheduleView): AutomationForm => ({ ...blankAutomation(s.id), ...whenChoices(s.whenText), enabled: s.enabled });

/** An IPC error in plain words: the message parseWhen threw, without Electron's wrapper. */
export const cleanError = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/**
 * Save an automation: the picked flow gets the when and on/off. A change that moves it to another flow takes the when
 * off the one it was on first (that flow stays, on Run now only). The schedules as they stand after.
 */
export async function saveAutomation(bridge: SchedulesBridge, f: AutomationForm, editingId: string | null): Promise<ScheduleView[]> {
  if (!f.flowId) throw new Error('Pick a saved flow (make one with + New flow)');
  if (!bridge.edit) throw new Error('this build of the app cannot change an automation; update it');
  if (editingId && editingId !== f.flowId) await bridge.edit(editingId, { when: '' });
  await bridge.edit(f.flowId, { when: whenText(f) });
  return bridge.update(f.flowId, { enabled: f.enabled });
}

/** Delete an automation: a flow's when is taken off (the flow stays); a legacy schedule is removed. */
export async function removeAutomation(bridge: SchedulesBridge, s: ScheduleView): Promise<ScheduleView[]> {
  if (isLegacy(s)) return bridge.remove(s.id);
  if (!bridge.edit) throw new Error('this build of the app cannot change an automation; update it');
  return bridge.edit(s.id, { when: '' });
}

/** Delete a flow itself (the shelf's Delete, not Set up's). */
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
