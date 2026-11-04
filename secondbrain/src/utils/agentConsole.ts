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

/** The top bar's buttons, each marked data-topbar in Header.tsx (and AtlasButton.tsx); nothing else stands there. */
export const TOP_BAR = ['Menu', 'Notes', 'Agent', 'Open Aurora', 'Settings', 'Update', 'Update notes kernel', 'Ollama (web only)'];

/**
 * The controls that left the top bar for the console, each marked data-console in AgentConsole.tsx (or the shelf
 * component it renders), with the shelf it now stands on.
 */
export const MOVED_TO_CONSOLE: { control: string; shelf: ConsoleShelf; file: string }[] = [
  { control: 'Steward', shelf: 'servers', file: 'AgentConsole.tsx' },
  { control: 'Services', shelf: 'servers', file: 'ServersShelf.tsx' },
  { control: 'Ollama', shelf: 'servers', file: 'AgentConsole.tsx' },
  { control: 'Integrations', shelf: 'servers', file: 'AgentConsole.tsx' },
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

/** A time from a record, short. */
export const shortTime = (t: string | number) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(t || '') : d.toLocaleString();
};
