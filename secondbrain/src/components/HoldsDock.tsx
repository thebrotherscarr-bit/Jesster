import React, { useCallback, useEffect, useState } from 'react';
import { Hourglass, Check, X } from 'lucide-react';

/**
 * SecondBrain's cards, on every page (Kyle, 2026-11-01: "make sure that secondbrains cards land in
 * secondbrain and atlas's cards land in atlas"). The door gives this window SecondBrain's own cards only
 * (the calls that came in through SecondBrain's MCP or its flows; electron/door/registry.cjs windowOf),
 * and the Atlas glass shows Atlas's. Before this, SecondBrain showed its cards on the GitHub page alone,
 * so he only ever saw cards in Atlas. Read and answered as the operator over IPC (door:call), as the
 * GitHub shelf's Waiting on you is.
 */

interface Held {
  id: string;
  tool: string;
  caller: string;
  project: string;
  when: string;
  args: Record<string, unknown>;
}

const EVERY_MS = 4000;

export const HoldsDock: React.FC = () => {
  const door = window.secondbrainDesktop?.door;
  const [holds, setHolds] = useState<Held[]>([]);
  const [said, setSaid] = useState('');

  const read = useCallback(async () => {
    if (!door) return;
    try {
      const r = await door.call('hold_list', {});
      setHolds((JSON.parse(r.text)?.held as Held[]) || []);
    } catch {
      /* the next read tries again */
    }
  }, [door]);

  useEffect(() => {
    read();
    const t = setInterval(read, EVERY_MS);
    return () => clearInterval(t);
  }, [read]);

  if (!door || (!holds.length && !said)) return null;

  const answer = async (id: string, decision: 'approve' | 'deny') => {
    const r = await door.call('hold_answer', { id, decision });
    setSaid(r.text.split('\n')[0]);
    read();
  };

  return (
    <aside aria-label="Waiting on you" className="fixed bottom-4 right-4 z-40 w-[28rem] max-w-[calc(100vw-2rem)] max-h-[60vh] overflow-y-auto rounded-xl border border-amber-700/60 bg-neutral-950/95 shadow-2xl p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
        <Hourglass className="w-4 h-4" /> Waiting on you ({holds.length})
        {said && (
          <button onClick={() => setSaid('')} className="ml-auto text-[11px] font-normal text-neutral-400 hover:text-white">
            dismiss
          </button>
        )}
      </div>
      {said && <div className="text-[11px] text-neutral-400 whitespace-pre-wrap break-words">{said}</div>}
      {holds.map((h) => (
        <div key={h.id} className="rounded-lg bg-neutral-900/80 p-2.5 text-xs space-y-1.5">
          <div className="font-mono text-neutral-200">
            {h.tool} <span className="text-neutral-500">on {h.project}</span>
          </div>
          <div className="text-neutral-500">
            asked by {h.caller} · {h.when}
          </div>
          <pre className="text-[11px] text-neutral-400 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{JSON.stringify(h.args, null, 1)}</pre>
          <div className="flex gap-2">
            <button onClick={() => answer(h.id, 'approve')} className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white">
              <Check className="w-3.5 h-3.5" /> Approve
            </button>
            <button onClick={() => answer(h.id, 'deny')} className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700">
              <X className="w-3.5 h-3.5" /> Deny
            </button>
          </div>
        </div>
      ))}
    </aside>
  );
};
