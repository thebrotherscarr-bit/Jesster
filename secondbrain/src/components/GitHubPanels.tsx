import React, { useState } from 'react';

/**
 * The GitHub shelf's lines of work and version marks (plan-github-shelf; Kyle, 2026-10-23: "make me a
 * GitHub thing that has every bit of the functionality of the inspector tab"). The same acts as the
 * glass's GitHub tab, each a door tool pressed as the operator: lines are opened, switched, landed and
 * closed; marks are cut, sent and removed. Every refusal is the door's own, shown as it said it.
 */

type Door = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
type Act = (what: string, steps: [string, Record<string, unknown>][]) => Promise<void>;

interface Line {
  name: string;
  current: boolean;
  main: boolean;
  upstream: string;
  sent: boolean;
  when: string;
  subject: string;
}

interface Mark {
  name: string;
  at: string;
  when: string;
  subject: string;
  sent: boolean;
  sendable: boolean;
  why_not?: string;
  removable: boolean;
  why_not_remove?: string;
}

const btn = 'px-2 py-0.5 rounded-md bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40';
const field = 'flex-1 min-w-0 rounded-md bg-neutral-950 border border-neutral-800 px-2 py-1 font-mono focus:outline-none focus:border-violet-600';

export const LinesPanel: React.FC<{ project: string; door: Door; act: Act; busy: boolean }> = ({ project, door, act, busy }) => {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [whyNotLand, setWhyNotLand] = useState('');
  const [said, setSaid] = useState('');
  const [name, setName] = useState('');
  const read = async () => {
    const r = await door('git_branch', { project, action: 'list' });
    try {
      const d = JSON.parse(r.text) as { branches: Line[] | null; why_not_land?: string };
      setLines(d.branches || []);
      setWhyNotLand(d.why_not_land || '');
      setSaid('');
    } catch {
      setSaid(r.text);
    }
  };
  const doIt = async (what: string, args: Record<string, unknown>) => {
    await act(what, [['git_branch', args]]);
    await read();
  };
  return (
    <details className="text-xs" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && read()}>
      <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">Lines of work</summary>
      <div className="mt-2 space-y-1">
        {said && <pre className="text-[11px] text-red-200 whitespace-pre-wrap">{said}</pre>}
        {lines?.map((l) => (
          <div key={l.name} className="flex items-center gap-1.5">
            <span className={`font-mono truncate ${l.current ? 'text-white font-semibold' : 'text-neutral-300'}`} title={l.subject}>
              {l.current ? '● ' : ''}
              {l.name}
            </span>
            <span className="text-neutral-600 truncate">{l.sent ? l.upstream : 'not sent'} · {l.when}</span>
            <span className="ml-auto flex gap-1 shrink-0">
              {!l.current && <button disabled={busy} className={btn} onClick={() => doIt('switching line', { action: 'switch', name: l.name })}>Switch</button>}
              {!l.main && <button disabled={busy || !!whyNotLand} title={whyNotLand || 'Land it onto main, fast-forward'} className={btn} onClick={() => doIt('landing', { action: 'land', name: l.name })}>Land</button>}
              {!l.current && !l.main && <button disabled={busy} className={btn} onClick={() => doIt('closing line', { action: 'close', name: l.name })}>Close</button>}
            </span>
          </div>
        ))}
        {lines && lines.length === 0 && <p className="text-neutral-500">No lines yet.</p>}
        <div className="flex gap-1.5 pt-1">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new line of work" className={field} />
          <button disabled={busy || !name.trim()} className={btn} onClick={() => doIt('opening a line', { action: 'new', name: name.trim() }).then(() => setName(''))}>
            Open it
          </button>
        </div>
      </div>
    </details>
  );
};

export const MarksPanel: React.FC<{ project: string; door: Door; act: Act; busy: boolean }> = ({ project, door, act, busy }) => {
  const [marks, setMarks] = useState<Mark[] | null>(null);
  const [said, setSaid] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const read = async () => {
    const r = await door('git_tag', { project, action: 'list' });
    try {
      const d = JSON.parse(r.text) as { tags: Mark[]; next: string };
      setMarks(d.tags || []);
      if (!name && d.next) setName(d.next);
      setSaid('');
    } catch {
      setSaid(r.text);
    }
  };
  const doIt = async (what: string, args: Record<string, unknown>) => {
    await act(what, [['git_tag', args]]);
    await read();
  };
  return (
    <details className="text-xs" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && read()}>
      <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">Version marks</summary>
      <div className="mt-2 space-y-1">
        {said && <pre className="text-[11px] text-red-200 whitespace-pre-wrap">{said}</pre>}
        {marks?.map((m) => (
          <div key={m.name} className="flex items-center gap-1.5">
            <span className="font-mono text-neutral-200">{m.name}</span>
            <span className="text-neutral-600 truncate" title={m.subject}>
              {m.at} · {m.when} · {m.sent ? 'on GitHub' : 'here only'}
            </span>
            <span className="ml-auto flex gap-1 shrink-0">
              {!m.sent && <button disabled={busy || !m.sendable} title={m.why_not || 'Send this mark to GitHub'} className={btn} onClick={() => doIt('sending the mark', { action: 'send', name: m.name })}>Send</button>}
              <button disabled={busy || !m.removable} title={m.why_not_remove || 'Remove this mark (it never left this machine)'} className={btn} onClick={() => doIt('removing the mark', { action: 'remove', name: m.name })}>
                Remove
              </button>
            </span>
          </div>
        ))}
        {marks && marks.length === 0 && <p className="text-neutral-500">No marks yet.</p>}
        <div className="flex gap-1.5 pt-1">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="v1.2.3" className={field} style={{ maxWidth: '7rem' }} />
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="what this version is" className={field} />
          <button disabled={busy || !name.trim() || !message.trim()} className={btn} onClick={() => doIt('cutting the mark', { action: 'cut', name: name.trim(), message: message.trim() }).then(() => setMessage(''))}>
            Cut
          </button>
        </div>
      </div>
    </details>
  );
};
