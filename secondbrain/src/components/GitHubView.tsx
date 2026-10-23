import React, { useCallback, useEffect, useState } from 'react';
import { GitBranch, RefreshCw, Loader2, Check, X, ArrowUpFromLine, ArrowDownToLine, GitPullRequest, GitMerge, Save, FileDiff, ExternalLink, Hourglass } from 'lucide-react';
import { nextStep, isMain, type RepoState, type PullRequest, type Step } from '../utils/githubStep.ts';

/**
 * The GitHub shelf (plan-github-shelf, G2; Kyle, 2026-10-23: "github flows goes into a shelf in
 * secondbrain, where i can handle all the repos ... it should essentially be the way the tab in the
 * inspector works now"). One card per repository with its one big next step, and the git writes that
 * are waiting on him. Every act is a door tool, called as the operator over IPC (door:call): the press
 * is his hand, as a button on the glass is.
 */

const REPOS = [
  { project: 'secondbrain', label: 'SecondBrain', where: 'worlds\\jesster' },
  { project: 'research', label: 'Manjuel', where: 'Research' },
  { project: 'atlas', label: 'Atlas', where: 'Research\\atlas' },
];

interface Held {
  id: string;
  tool: string;
  caller: string;
  project: string;
  when: string;
  args: Record<string, unknown>;
}

interface Card {
  st: RepoState | null;
  prs: PullRequest[];
  busy: string;
  said: string;
  failed: boolean;
  msg: string;
  lineName: string;
  diff: { file: string; text: string } | null;
}

const empty = (): Card => ({ st: null, prs: [], busy: 'reading', said: '', failed: false, msg: '', lineName: '', diff: null });

async function door(name: string, args: Record<string, unknown> = {}) {
  const d = window.secondbrainDesktop?.door;
  if (!d) return { text: 'The GitHub shelf runs in the SecondBrain desktop app.', isError: true };
  try {
    return await d.call(name, args);
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const ACT_ICON: Record<Step['act'], React.ComponentType<{ className?: string }>> = {
  save: Save,
  send: ArrowUpFromLine,
  pull: ArrowDownToLine,
  pr: GitPullRequest,
  merge: GitMerge,
  main: GitBranch,
  line: GitBranch,
  none: Check,
};

export const GitHubView: React.FC = () => {
  const [cards, setCards] = useState<Record<string, Card>>(() => Object.fromEntries(REPOS.map((r) => [r.project, empty()])));
  const [holds, setHolds] = useState<Held[]>([]);
  const [holdsSaid, setHoldsSaid] = useState('');

  const patch = useCallback((project: string, p: Partial<Card>) => setCards((c) => ({ ...c, [project]: { ...c[project], ...p } })), []);

  const read = useCallback(
    async (project: string) => {
      patch(project, { busy: 'reading' });
      const [g, p] = await Promise.all([door('git', { project, fetch: 'yes' }), door('git_pr', { project, action: 'list' })]);
      const st = parse<RepoState>(g.text);
      const prs = parse<{ pull_requests: PullRequest[] }>(p.text)?.pull_requests || [];
      patch(project, { st, prs, busy: '', ...(st ? {} : { said: g.text, failed: true }) });
    },
    [patch],
  );

  const readHolds = useCallback(async () => {
    const r = await door('hold_list');
    const d = parse<{ armed: boolean; held: Held[] }>(r.text);
    setHolds(d?.held || []);
    setHoldsSaid(d ? '' : r.text);
  }, []);

  const readAll = useCallback(() => {
    for (const r of REPOS) read(r.project);
    readHolds();
  }, [read, readHolds]);

  useEffect(() => {
    readAll();
  }, [readAll]);

  /** One act, said in the card, then the repository read again. */
  const act = async (project: string, what: string, steps: [string, Record<string, unknown>][]) => {
    patch(project, { busy: what, said: '', failed: false });
    const out: string[] = [];
    let failed = false;
    for (const [name, args] of steps) {
      const r = await door(name, { project, ...args });
      out.push(r.text);
      if (r.isError || /^Refused|^Sending refused|^Fetching refused|^HELD/.test(r.text)) {
        failed = true;
        break;
      }
    }
    patch(project, { said: out.join('\n\n'), failed, busy: '', ...(failed ? {} : { msg: '', lineName: '' }) });
    await read(project);
    readHolds();
  };

  const run = (project: string, step: Step) => {
    const c = cards[project];
    switch (step.act) {
      case 'save':
        if (!c.msg.trim()) return patch(project, { said: 'Say what this save is in the box first.', failed: true });
        return act(project, 'saving', [['git_commit', { message: c.msg.trim() }]]);
      case 'send':
        return act(project, 'sending', [['git_push', {}]]);
      case 'pull':
        return act(project, 'bringing level', [['git_pull', {}]]);
      case 'pr':
        return act(project, 'opening a pull request', [['git_pr', { action: 'open' }]]);
      case 'merge':
        return act(project, 'merging', [
          ['git_pr', { action: 'merge', number: step.pr!.number }],
          ['git_branch', { action: 'switch', name: 'main' }],
        ]);
      case 'line':
        if (!c.lineName.trim()) return patch(project, { said: 'Name the line of work first (under More).', failed: true });
        return act(project, 'starting a line', [['git_branch', { action: 'new', name: c.lineName.trim() }]]);
      default:
        return undefined;
    }
  };

  const answer = async (id: string, decision: 'approve' | 'deny') => {
    const r = await door('hold_answer', { id, decision });
    setHoldsSaid(r.text);
    readAll();
  };

  const showDiff = async (project: string, line: string) => {
    const file = line.slice(3).trim().replace(/^"|"$/g, '');
    const r = await door('git_diff', { project, file });
    patch(project, { diff: { file, text: r.text } });
  };

  return (
    <div className="flex-1 h-[calc(100vh-3.5rem)] overflow-y-auto bg-neutral-950 text-neutral-200">
      <div className="max-w-7xl mx-auto p-5 space-y-5">
        <div className="flex items-center gap-3">
          <GitBranch className="w-5 h-5 text-violet-400" />
          <h1 className="text-lg font-semibold">GitHub</h1>
          <span className="text-xs text-neutral-500">every repository on this PC, level with GitHub</span>
          <button onClick={readAll} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-neutral-900 hover:bg-neutral-800 border border-neutral-800">
            <RefreshCw className="w-3.5 h-3.5" /> Ask GitHub again
          </button>
        </div>

        {holds.length > 0 && (
          <section className="rounded-xl border border-amber-700/60 bg-amber-950/20 p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
              <Hourglass className="w-4 h-4" /> Waiting on you ({holds.length})
            </div>
            {holds.map((h) => (
              <div key={h.id} className="flex items-start gap-3 rounded-lg bg-neutral-900/70 p-2.5 text-xs">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-neutral-200">
                    {h.tool} <span className="text-neutral-500">on {h.project}</span>
                  </div>
                  <div className="text-neutral-500">
                    asked by {h.caller} · {h.when}
                  </div>
                  <pre className="mt-1 text-[11px] text-neutral-400 whitespace-pre-wrap break-all">{JSON.stringify(h.args)}</pre>
                </div>
                <button onClick={() => answer(h.id, 'approve')} className="px-2.5 py-1 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white">
                  Approve
                </button>
                <button onClick={() => answer(h.id, 'deny')} className="px-2.5 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700">
                  Deny
                </button>
              </div>
            ))}
          </section>
        )}
        {holdsSaid && <pre className="text-[11px] text-neutral-400 whitespace-pre-wrap">{holdsSaid}</pre>}

        <div className="grid gap-4 lg:grid-cols-3">
          {REPOS.map((r) => {
            const c = cards[r.project];
            const st = c.st;
            const step = nextStep(st, c.prs);
            const Icon = ACT_ICON[step.act];
            const line = st?.branch || '';
            return (
              <section key={r.project} className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 flex flex-col gap-3 min-w-0">
                <header className="flex items-baseline gap-2">
                  <h2 className="text-base font-semibold">{r.label}</h2>
                  <span className="text-[11px] text-neutral-500 truncate">{r.where}</span>
                  {c.busy && <Loader2 className="ml-auto w-4 h-4 animate-spin text-neutral-400" />}
                </header>

                {st?.is_repo && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className={`px-2 py-0.5 rounded-full font-mono ${isMain(line) ? 'bg-violet-900/60 text-violet-200' : 'bg-sky-900/60 text-sky-200'}`}>{line}</span>
                    {st.upstream ? <span className="text-neutral-500">follows {st.upstream}</span> : <span className="text-amber-400">never sent</span>}
                    <span className="px-1.5 py-0.5 rounded bg-neutral-800">↑ {st.ahead || 0}</span>
                    <span className="px-1.5 py-0.5 rounded bg-neutral-800">↓ {st.behind || 0}</span>
                    {st.fetched === false && <span className="text-amber-400" title={st.fetch_note}>GitHub not asked</span>}
                  </div>
                )}
                {st?.subject && (
                  <div className="text-xs text-neutral-400 truncate" title={st.subject}>
                    <span className="font-mono text-neutral-500">{st.head}</span> {st.subject} <span className="text-neutral-600">· {st.when}</span>
                  </div>
                )}

                <button
                  disabled={!!c.busy || step.act === 'none'}
                  onClick={() => run(r.project, step)}
                  title={step.why}
                  className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                    step.act === 'none' ? 'bg-neutral-800/60 text-neutral-400' : 'bg-violet-600 hover:bg-violet-500 text-white'
                  } disabled:cursor-default`}
                >
                  {c.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
                  {c.busy ? c.busy + '...' : step.label}
                </button>
                <p className="text-[11px] text-neutral-500 -mt-1">{step.why}</p>

                {(step.act === 'save' || (st?.files?.length || 0) > 0) && (
                  <textarea
                    value={c.msg}
                    onChange={(e) => patch(r.project, { msg: e.target.value })}
                    placeholder="What is this save? (the message)"
                    rows={2}
                    className="w-full rounded-lg bg-neutral-950 border border-neutral-800 p-2 text-xs focus:outline-none focus:border-violet-600"
                  />
                )}

                {(st?.files?.length || 0) > 0 && (
                  <div className="space-y-0.5">
                    <div className="text-[11px] uppercase tracking-wider text-neutral-500">Unsaved</div>
                    {st!.files!.map((f) => (
                      <button key={f} onClick={() => showDiff(r.project, f)} className="w-full flex items-center gap-1.5 text-left text-[11px] font-mono text-neutral-300 hover:text-white truncate">
                        <FileDiff className="w-3 h-3 shrink-0 text-neutral-500" /> {f}
                      </button>
                    ))}
                  </div>
                )}
                {c.diff && (
                  <div className="rounded-lg bg-black/50 border border-neutral-800">
                    <div className="flex items-center px-2 py-1 text-[11px] text-neutral-400 border-b border-neutral-800">
                      <span className="font-mono truncate">{c.diff.file}</span>
                      <button onClick={() => patch(r.project, { diff: null })} className="ml-auto">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <pre className="max-h-72 overflow-auto p-2 text-[10.5px] leading-snug whitespace-pre">{c.diff.text}</pre>
                  </div>
                )}

                {c.prs.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] uppercase tracking-wider text-neutral-500">Pull requests</div>
                    {c.prs.map((p) => (
                      <div key={p.number} className="flex items-center gap-2 text-xs">
                        <span className={`w-2 h-2 rounded-full ${p.checks === 'passed' ? 'bg-emerald-500' : p.checks === 'failed' ? 'bg-red-500' : p.checks === 'pending' ? 'bg-amber-400' : 'bg-neutral-600'}`} title={'checks ' + p.checks} />
                        <a href={p.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                          #{p.number} {p.title}
                        </a>
                        <span className="text-neutral-500 font-mono shrink-0">{p.line}</span>
                        <ExternalLink className="w-3 h-3 text-neutral-600 shrink-0" />
                      </div>
                    ))}
                  </div>
                )}

                <details className="text-xs">
                  <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">More</summary>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button disabled={!!c.busy} onClick={() => run(r.project, { act: 'send', label: '', why: '' })} className="px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700">Send</button>
                    <button disabled={!!c.busy} onClick={() => run(r.project, { act: 'pull', label: '', why: '' })} className="px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700">Take from GitHub</button>
                    <button disabled={!!c.busy} onClick={() => run(r.project, { act: 'pr', label: '', why: '' })} className="px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700">Open a PR</button>
                    {!isMain(line) && (
                      <button disabled={!!c.busy} onClick={() => act(r.project, 'going back to main', [['git_branch', { action: 'switch', name: 'main' }], ['git_pull', {}]])} className="px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700">
                        Back to main
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <input
                      value={c.lineName}
                      onChange={(e) => patch(r.project, { lineName: e.target.value })}
                      placeholder="new line of work, e.g. github-shelf-g3"
                      className="flex-1 rounded-md bg-neutral-950 border border-neutral-800 px-2 py-1 font-mono focus:outline-none focus:border-violet-600"
                    />
                    <button disabled={!!c.busy} onClick={() => run(r.project, { act: 'line', label: '', why: '' })} className="px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700">
                      Start it
                    </button>
                  </div>
                </details>

                {c.said && <pre className={`text-[11px] whitespace-pre-wrap break-words rounded-lg p-2 ${c.failed ? 'bg-red-950/40 text-red-200' : 'bg-emerald-950/30 text-emerald-200'}`}>{c.said}</pre>}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
};
