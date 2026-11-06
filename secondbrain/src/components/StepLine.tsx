import React from 'react';
import { Check, X, Loader2, ShieldAlert } from 'lucide-react';
import { StepCell } from '../utils/agentConsole.ts';

/**
 * The step line (AG-UI step 3, Steward's ExecPlan 0003): which of Steward's workflow steps the turn is in, each lit as
 * it starts and marked done or failed as it ends, from his AG-UI host's step events (utils/agentConsole.ts stepLine).
 * Drawn above the turn's output in the Agent tab and the Phone view; nothing is drawn when there are no step events.
 */
export const StepLine: React.FC<{ cells: StepCell[] }> = ({ cells }) => {
  if (!cells.length) return null;
  return (
    <ol aria-label="Steward's steps" data-step-line className="flex flex-wrap items-center gap-1 text-[11px] min-w-0">
      {cells.map((c, i) => (
        <li
          key={c.id}
          data-step={c.id}
          data-state={c.state}
          title={c.state === 'card' ? `${c.label}: waiting on its card` : `${c.label}: ${c.state}`}
          className={`flex items-center gap-1 px-2 py-0.5 rounded-md border ${
            c.state === 'running'
              ? 'border-emerald-700 text-emerald-300'
              : c.state === 'done'
                ? 'border-neutral-800 text-neutral-400'
                : c.state === 'failed'
                  ? 'border-rose-800 text-rose-300'
                  : c.state === 'card'
                    ? 'border-amber-800 text-amber-200'
                    : 'border-neutral-900 text-neutral-600'
          }`}
        >
          {c.state === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
          {c.state === 'done' && <Check className="w-3 h-3" />}
          {c.state === 'failed' && <X className="w-3 h-3" />}
          {c.state === 'card' && <ShieldAlert className="w-3 h-3" />}
          <span>
            {c.label}
            {c.attempts > 1 ? `, attempt ${c.attempts}` : ''}
          </span>
          {i < cells.length - 1 && <span className="sr-only">, then</span>}
        </li>
      ))}
    </ol>
  );
};
