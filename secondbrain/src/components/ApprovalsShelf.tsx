import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, Hourglass, Check, CheckCheck, X, Send, RotateCcw } from 'lucide-react';
import { AlwaysEntry, ApprovalItem } from '../types/desktop.ts';
import { ALWAYS_SCOPE, canAlways, whereWord } from '../utils/approvals.ts';
import { HistoryRow, historyRow } from '../utils/agentConsole.ts';

// the door's holds are read as often as HoldsDock reads them
const EVERY_MS = 4000;

const clean = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/**
 * The console's Approvals shelf (the Agent tab): every open card of both planes in one queue, newest first, answered
 * with the same calls their own places use (the Agent tab's agent.approve and agent.send, HoldsDock's door.call
 * hold_answer); the cards already answered (approvals.history, where the app has it); and the standing Always allow
 * entries with Reset. Which of Steward's tools ask is on the console's Tools shelf.
 */
export const ApprovalsShelf: React.FC = () => {
  const desk = window.secondbrainDesktop;
  const api = desk?.approvals;
  const agent = desk?.agent;
  const door = desk?.door;
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [doorError, setDoorError] = useState('');
  const [always, setAlways] = useState<AlwaysEntry[]>([]);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [historyOn, setHistoryOn] = useState(true);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const read = useCallback(async () => {
    if (!api) return;
    try {
      const [q, a] = await Promise.all([api.list(), api.always()]);
      setItems(q.items);
      setDoorError(q.doorError || '');
      setAlways(a);
      setError('');
      // answered cards, newest first: called only where this build of the app has it
      const h = (api as typeof api & { history?: () => Promise<unknown> }).history;
      if (typeof h !== 'function') setHistoryOn(false);
      else {
        const got = await h();
        const list = Array.isArray(got) ? got : got && typeof got === 'object' && Array.isArray((got as { items?: unknown[] }).items) ? (got as { items: unknown[] }).items : [];
        setHistory(list.map(historyRow));
      }
    } catch (e) {
      setError(clean(e));
    }
  }, [api]);

  useEffect(() => {
    read();
    const t = setInterval(read, EVERY_MS);
    return () => clearInterval(t);
  }, [read]);

  // the conversations' titles are read once, when the shelf opens
  useEffect(() => {
    agent
      ?.sessions()
      .then((s) => setTitles(Object.fromEntries(s.map((x) => [x.id, x.title]))))
      .catch(() => {});
  }, [api, agent]);

  const act = async (id: string, run: () => Promise<void>) => {
    setBusy(id);
    setError('');
    try {
      await run();
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(null);
      read();
    }
  };

  // the Agent tab's card: the same agent.approve its own Allow once, Always allow and Deny press
  const answerAgent = (item: ApprovalItem, allow: boolean, alwaysToo = false) =>
    act(item.id, async () => {
      if (!agent) return;
      await agent.approve(item.id, allow, alwaysToo);
    });

  // the Agent tab's "Reply on this card": sent as a message to the card's conversation, as the tab sends it
  const replyOn = (item: ApprovalItem) => {
    const text = (replies[item.id] || '').trim();
    if (!text || item.plane !== 'agent') return;
    setReplies((r) => ({ ...r, [item.id]: '' }));
    act(item.id, async () => {
      if (!agent) return;
      await agent.send(text, item.sessionId);
    });
  };

  // the door's hold: the same door.call hold_answer HoldsDock and the GitHub shelf press
  const answerDoor = (item: ApprovalItem, decision: 'approve' | 'deny') =>
    act(item.id, async () => {
      if (!door) return;
      const r = await door.call('hold_answer', { id: item.id, decision });
      setSaid(r.text.split('\n')[0]);
    });

  const reset = (key?: string) =>
    act(key || 'always:all', async () => {
      if (!api) return;
      setAlways(await api.reset(key));
    });

  if (!api) return <p className="text-xs text-neutral-400">Approvals run in the desktop app.</p>;

  return (
    <section className="space-y-4" aria-label="Approvals" data-console="Approvals">
      {error && <p className="text-xs text-amber-400">{error}</p>}

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-neutral-200">
          Waiting on you ({items ? items.length : '…'})
          {said && (
            <button onClick={() => setSaid('')} className="ml-auto text-[11px] font-normal text-neutral-400 hover:text-white">
              dismiss
            </button>
          )}
        </div>
        {said && <p className="text-[11px] text-neutral-400 whitespace-pre-wrap break-words">{said}</p>}
        {doorError && <p className="text-xs text-amber-400">{doorError}</p>}
        <div className="rounded-xl border border-neutral-800 p-3 space-y-3">
          {!items && <p className="text-xs text-neutral-500">Checking…</p>}
          {items && !items.length && <p className="text-xs text-neutral-500">No card is waiting.</p>}
          {(items || []).map((item) => (
            <div key={`${item.plane}:${item.id}`} className="space-y-1.5 text-xs">
              <div className="flex items-center gap-2 text-neutral-100">
                {item.plane === 'agent' ? <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" /> : <Hourglass className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                <code>{item.tool}</code>
                <span className="text-neutral-500 truncate">{whereWord(item, titles)}</span>
                <span className="ml-auto text-neutral-500 shrink-0">{item.at ? new Date(item.at).toLocaleTimeString() : ''}</span>
              </div>
              <pre className="ml-5 max-h-32 overflow-auto rounded-lg bg-neutral-900 border border-neutral-800 p-2 text-[11px] leading-snug font-mono text-neutral-300 whitespace-pre-wrap break-words">
                {item.plane === 'agent' ? item.summary : JSON.stringify(item.args, null, 1)}
              </pre>
              {item.plane === 'agent' ? (
                <div className="ml-5 space-y-1.5">
                  <div className="flex gap-1">
                    <button onClick={() => answerAgent(item, true)} disabled={busy !== null} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-600 text-[11px] text-white hover:bg-emerald-500 disabled:opacity-40">
                      <Check className="w-3 h-3" /> Allow once
                    </button>
                    {canAlways(item) && (
                      <button onClick={() => answerAgent(item, true, true)} disabled={busy !== null} title={ALWAYS_SCOPE} className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-emerald-700 text-[11px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40">
                        <CheckCheck className="w-3 h-3" /> Always allow
                      </button>
                    )}
                    <button onClick={() => answerAgent(item, false)} disabled={busy !== null} className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-neutral-700 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">
                      <X className="w-3 h-3" /> Deny
                    </button>
                  </div>
                  <div className="flex gap-1">
                    <input
                      value={replies[item.id] || ''}
                      onChange={(e) => setReplies((x) => ({ ...x, [item.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && replyOn(item)}
                      placeholder="Reply on this card…"
                      aria-label="Reply on this card"
                      className="flex-1 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-xs text-neutral-100"
                    />
                    <button
                      onClick={() => replyOn(item)}
                      disabled={!(replies[item.id] || '').trim() || busy !== null}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-neutral-700 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
                    >
                      <Send className="w-3 h-3" /> Reply
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ml-5 flex gap-1">
                  <button onClick={() => answerDoor(item, 'approve')} disabled={busy !== null} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-700 text-[11px] text-white hover:bg-emerald-600 disabled:opacity-40">
                    <Check className="w-3 h-3" /> Approve
                  </button>
                  <button onClick={() => answerDoor(item, 'deny')} disabled={busy !== null} className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-neutral-700 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">
                    <X className="w-3 h-3" /> Deny
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-neutral-200">
          Always allow ({always.length})
          {always.length > 0 && (
            <button onClick={() => reset()} disabled={busy !== null} className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md border border-neutral-700 text-[11px] font-normal text-neutral-300 hover:bg-neutral-800 disabled:opacity-40">
              <RotateCcw className="w-3 h-3" /> Reset all
            </button>
          )}
        </div>
        <p className="text-[11px] text-neutral-500">{ALWAYS_SCOPE} The door's cards never take Always: each is your word for that one act.</p>
        <div className="rounded-xl border border-neutral-800 p-3 space-y-3">
          {!always.length && <p className="text-xs text-neutral-500">Nothing is always allowed.</p>}
          {always.map((a) => (
            <div key={a.key} className="flex items-start gap-2 text-xs">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="text-neutral-100">
                  <code>{a.name}</code> <span className="text-neutral-500">since {new Date(a.at).toLocaleTimeString()}</span>
                </div>
                <pre className="max-h-24 overflow-auto rounded-lg bg-neutral-900 border border-neutral-800 p-2 text-[11px] leading-snug font-mono text-neutral-300 whitespace-pre-wrap break-words">{a.summary}</pre>
              </div>
              <button onClick={() => reset(a.key)} disabled={busy !== null} aria-label={`Reset Always allow for ${a.name}`} className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-neutral-700 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40 shrink-0">
                <RotateCcw className="w-3 h-3" /> Reset
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold text-neutral-200">Answered ({history ? history.length : historyOn ? '…' : '–'})</div>
        <div className="rounded-xl border border-neutral-800 p-3 space-y-1.5">
          {!historyOn && <p className="text-xs text-neutral-500">History not available in this build.</p>}
          {historyOn && !history && <p className="text-xs text-neutral-500">Reading…</p>}
          {history && !history.length && <p className="text-xs text-neutral-500">No card has been answered yet.</p>}
          {(history || []).map((h) => (
            <div key={h.key} className="text-xs border-b border-neutral-900 last:border-b-0 pb-1">
              <div className="flex items-center gap-2 text-neutral-100">
                <code className="truncate">{h.tool || 'card'}</code>
                <span className={/deny|denied|no/i.test(h.decision) ? 'text-amber-400' : 'text-emerald-400'}>{h.decision}</span>
                <span className="ml-auto text-neutral-500 shrink-0 tabular-nums">{h.at ? new Date(h.at).toLocaleString() : ''}</span>
              </div>
              {h.detail && <p className="text-[11px] text-neutral-500 truncate" title={h.detail}>{h.detail}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
