import type { ToolPolicy } from '../types/desktop.ts';

/**
 * The Agent tab's console (components/AgentConsole.tsx): everything his operator watches and steers Steward by, in
 * one panel beside the conversation. The top bar keeps the app's own navigation only.
 */
export type ConsoleShelf = 'servers' | 'approvals' | 'evals' | 'runs' | 'tools' | 'skills';

export const CONSOLE_SHELVES: { id: ConsoleShelf; label: string }[] = [
  { id: 'servers', label: 'Servers' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'evals', label: 'Evals' },
  { id: 'runs', label: 'Runs' },
  { id: 'tools', label: 'Tools' },
  { id: 'skills', label: 'Skills & memory' },
];

/**
 * The top bar's buttons, each marked data-topbar in Header.tsx; nothing else stands there. Flows took Open Aurora's
 * place (the operator, 2026-11-05: swap it "for now"); AtlasButton.tsx is kept, unhooked.
 */
export const TOP_BAR = ['Notes', 'Agent', 'Phone', 'Flows', 'Settings', 'Update', 'Update notes kernel', 'Ollama (web only)'];

/**
 * The controls that left the top bar for the console, each marked data-console in AgentConsole.tsx (or the shelf
 * component it renders), with the shelf it now stands on.
 */
export const MOVED_TO_CONSOLE: { control: string; shelf: ConsoleShelf; file: string }[] = [
  { control: 'Steward', shelf: 'servers', file: 'AgentConsole.tsx' },
  { control: 'Services', shelf: 'servers', file: 'ServersShelf.tsx' },
  // Ollama and Integrations went on to Settings (2026-11-04: no window opened from a shelf; utils/settingsMap.ts)
  { control: 'Approvals', shelf: 'approvals', file: 'ApprovalsShelf.tsx' },
  { control: 'Tool policy', shelf: 'tools', file: 'AgentConsole.tsx' },
];

/** The MCP servers Steward is connected to, as his tool policy names them (a source "mcp:<server>"), with their tool counts. */
export function mcpServers(policy: ToolPolicy | null): { name: string; tools: number }[] {
  if (!policy || policy.state !== 'ok') return [];
  const counts = new Map<string, number>();
  for (const t of policy.tools) {
    const m = /^mcp:(.+)$/.exec(t.source);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return [...counts.entries()].map(([name, tools]) => ({ name, tools })).sort((a, b) => a.name.localeCompare(b.name));
}

/** A run's checks against the set's baseline (eval_baselines.json: { set: { checks, of } }): 'above', 'at', 'below' or ''. */
export function versusBaseline(run: { set: string; checksPassed: number; checksTotal: number }, baseline: unknown): '' | 'above' | 'at' | 'below' {
  const b = baseline && typeof baseline === 'object' ? (baseline as Record<string, { checks?: unknown; of?: unknown }>)[run.set] : undefined;
  if (!b || typeof b.checks !== 'number') return '';
  if (typeof b.of === 'number' && b.of !== run.checksTotal) return '';
  return run.checksPassed > b.checks ? 'above' : run.checksPassed === b.checks ? 'at' : 'below';
}

/**
 * Steward's bar (the overnight plan, 2026-11-04): the small set 3/3 (every case) on its two newest runs in a row, and
 * the newest steps run passing. History is newest first, as the Evals shelf reads it.
 */
export interface BarStatus {
  small: { passed: number; total: number; ts: string }[];
  steps: { passed: number; total: number; ts: string } | null;
  met: boolean;
}

export function barStatus(history: { set: string; passed: number; total: number; ts: string }[]): BarStatus {
  const pick = (r: { passed: number; total: number; ts: string }) => ({ passed: r.passed, total: r.total, ts: r.ts });
  const whole = (r: { passed: number; total: number }) => r.total > 0 && r.passed === r.total;
  const small = history.filter((r) => r.set === 'small').slice(0, 2).map(pick);
  const last = history.find((r) => r.set === 'steps');
  const steps = last ? pick(last) : null;
  return { small, steps, met: small.length === 2 && small.every(whole) && !!steps && whole(steps) };
}

/** One answered card from approvals.history(), whatever its plane, as the shelf shows it. */
export interface HistoryRow {
  key: string;
  tool: string;
  decision: string;
  at: number;
  detail: string;
}

export function historyRow(x: unknown, i: number): HistoryRow {
  const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const when = r.time ?? r.when;
  const at = Number(r.answeredAt ?? r.at ?? (typeof when === 'number' ? when : NaN)) || Date.parse(String(when || '')) || 0;
  const decision =
    typeof r.decision === 'string'
      ? r.decision
      : typeof r.allow === 'boolean'
        ? r.allow
          ? r.always
            ? 'always allowed'
            : 'allowed'
          : 'denied'
        : typeof r.outcome === 'string'
          ? r.outcome
          : typeof r.answer === 'string'
            ? r.where
              ? `${r.answer} (${r.where})`
              : r.answer
            : '';
  return {
    key: String(r.id ?? i),
    tool: String(r.tool ?? r.name ?? ''),
    decision,
    at,
    detail: typeof r.summary === 'string' ? r.summary : r.args ? JSON.stringify(r.args) : '',
  };
}

/**
 * The Agent tab's two folding panels, each remembered under its own key: the console on the right and the chats bar on
 * the left (the operator, 2026-11-04: "this entire left bar of old chats, that can be folded just like the console").
 */
export const CONSOLE_OPEN_KEY = 'secondbrain_console_open_v1';
export const CHATS_OPEN_KEY = 'secondbrain_chats_open_v1';
/** Steward's card on the Flows shelf (components/FlowsShelf.tsx), folded the same way; closed until opened. */
export const FLOWS_STEWARD_OPEN_KEY = 'secondbrain_flows_steward_open_v1';

type PanelStore = Pick<Storage, 'getItem' | 'setItem'> | undefined;

/**
 * A panel opens unless it was last closed ('0'). The first time, and when nothing can be read, it takes `first`: open
 * for the console and the chats, closed for the Flows shelf's Steward card.
 */
export function panelOpen(store: PanelStore, key: string, first = true): boolean {
  try {
    const v = store?.getItem(key);
    return v === null || v === undefined ? first : v !== '0';
  } catch {
    return first;
  }
}

/** Keeps a panel's state; when it cannot be kept, the panel still opens and closes. */
export function keepPanel(store: PanelStore, key: string, on: boolean): void {
  try {
    store?.setItem(key, on ? '1' : '0');
  } catch {
    /* the choice is not kept */
  }
}

/**
 * The step line (AG-UI step 3, Steward's ExecPlan 0003): Steward's workflow steps for the turn in progress, drawn from
 * the 'workflow_step' events his AG-UI host's STEP_STARTED / STEP_FINISHED become (electron/agent/agui.cjs). Each
 * entry of STEP_LINE is one step as the operator reads it, with the executor ids that make it up (MAF names each step
 * by its executor's id; ask_approval is the plan's card).
 */
export const STEP_LINE: { id: string; label: string; names: string[] }[] = [
  { id: 'plan', label: 'plan', names: ['explore', 'plan', 'read_plan'] },
  { id: 'approve', label: 'approve', names: ['ask_approval'] },
  { id: 'execute', label: 'execute', names: ['execute'] },
  { id: 'check', label: 'check', names: ['check'] },
  { id: 'repair', label: 'repair', names: ['repair'] },
  { id: 'commit', label: 'commit', names: ['commit'] },
  { id: 'report', label: 'report', names: ['report'] },
];

/** 'card': the step raised a card that waits on the operator (its executor has finished; the answer resumes it). */
export type StepState = 'waiting' | 'running' | 'done' | 'failed' | 'card';
export interface StepCell {
  id: string;
  label: string;
  state: StepState;
  /** how many times it ran: shown for check and repair, the steps that run again on a red check */
  attempts: number;
}
export interface WorkflowStepEvent {
  name: string;
  state: 'started' | 'finished' | 'failed';
}

const RETRIED = new Set(['check', 'repair']);

/**
 * A turn's step events, in the order they came, as its line. No events (an older host, the Responses fallback): no
 * line. A turn that ran none of the workflow's steps (a plain question: route, then answer) is one 'answer' step. Each
 * step takes the state of its last event; a step not yet reached is waiting; one passed over (repair after a green
 * check, commit when nothing changed) is left out. `cardWaits`: a card waits in this conversation, so the step that
 * raised it (the last one to move) is shown waiting on its card.
 */
export function stepLine(events: WorkflowStepEvent[], cardWaits = false): StepCell[] {
  const cells = new Map<string, StepCell>();
  let last: string | null = null;
  let answer: StepCell | null = null;
  const stateOf = (e: WorkflowStepEvent): StepState => (e.state === 'started' ? 'running' : e.state === 'finished' ? 'done' : 'failed');
  for (const e of events) {
    if (e.name === 'answer') {
      const before: number = (answer as StepCell | null)?.attempts || 0;
      answer = { id: 'answer', label: 'answer', state: stateOf(e), attempts: before + (e.state === 'started' ? 1 : 0) };
      continue;
    }
    const step = STEP_LINE.find((s) => s.names.includes(e.name));
    if (!step) continue; // route, MAF's own, or a step this line does not know: ignored
    const cell = cells.get(step.id) || { id: step.id, label: step.label, state: 'waiting' as StepState, attempts: 0 };
    // a card's step runs again on the resume: that is the same attempt, so only check and repair count their runs
    if (e.state === 'started' && (RETRIED.has(step.id) ? true : cell.attempts === 0)) cell.attempts += 1;
    cell.state = stateOf(e);
    cells.set(step.id, cell);
    last = step.id;
  }
  if (!cells.size) {
    if (!answer) return [];
    return [cardWaits && answer.state === 'done' ? { ...answer, state: 'card' } : answer];
  }
  const reached = Math.max(...[...cells.keys()].map((id) => STEP_LINE.findIndex((s) => s.id === id)));
  const line = STEP_LINE.flatMap((s, i) => {
    const cell = cells.get(s.id);
    if (cell) return [cell.id === last && cardWaits && cell.state === 'done' ? { ...cell, state: 'card' as StepState } : cell];
    return i > reached ? [{ id: s.id, label: s.label, state: 'waiting' as StepState, attempts: 0 }] : [];
  });
  // a failed step ends the run: what was still to come will not run
  const failed = line.findIndex((c) => c.state === 'failed');
  return failed >= 0 ? line.slice(0, failed + 1) : line;
}

/**
 * The step events a view keeps for the one conversation it shows (the Phone view's chat, by its Steward session): that
 * session's 'workflow_step' events, in order; its new message ('user') starts them again; another session's events
 * are not its own.
 */
export function keepSteps(
  kept: WorkflowStepEvent[],
  e: { sessionId: string; type: string; name?: string; state?: string },
  sessionId: string | null | undefined,
): WorkflowStepEvent[] {
  if (!sessionId || e.sessionId !== sessionId) return kept;
  if (e.type === 'user') return [];
  if (e.type === 'workflow_step' && e.name && (e.state === 'started' || e.state === 'finished' || e.state === 'failed'))
    return [...kept, { name: e.name, state: e.state }];
  return kept;
}

/** The Steward session a phone chat continues: the latest entry that names one (each phone line carries it). */
export function phoneSession(entries: { sessionId?: string | null }[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].sessionId) return entries[i].sessionId as string;
  return null;
}

/** A time from a record, short. */
export const shortTime = (t: string | number) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(t || '') : d.toLocaleString();
};
