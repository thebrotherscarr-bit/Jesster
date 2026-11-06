import React from 'react';
import { Check, X, Loader2, ShieldAlert } from 'lucide-react';
import { StepCell } from '../utils/agentConsole.ts';

/**
 * The step line (AG-UI step 3, Steward's ExecPlan 0003): which of Steward's workflow steps the turn is in, each lit as
 * it starts and marked done or failed as it ends, from his AG-UI host's step events (utils/agentConsole.ts stepLine).
 * Drawn at the bottom of the conversation in the Agent tab and the Phone view (StepLinePane, below); nothing is drawn
 * when there are no step events.
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

/**
 * Whether a scrolled pane is at (or near) its bottom: the conversation follows new text, and the step line with it,
 * only while it is, so a pane the operator has scrolled up stays where he put it.
 */
export const following = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

/**
 * A conversation pane whose step line is pinned at its bottom, after the latest message and just above the input
 * (the operator, 2026-11-06: "should be pinned to the bottom as he works, so you can see progress"; Steward's ExecPlan
 * 0003). It had been drawn under the turn's own message, at the top of the turn's output, and scrolled away as the
 * turn went on. The line comes after every child, so it follows each message as it arrives and settles after the
 * final reply when the run ends. The views scroll it into view while they are following (see `following`).
 */
export const StepLinePane = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { cells: StepCell[] }>(
  ({ cells, children, ...pane }, ref) => (
    <div ref={ref} {...pane}>
      {children}
      <StepLine cells={cells} />
    </div>
  )
);
StepLinePane.displayName = 'StepLinePane';
