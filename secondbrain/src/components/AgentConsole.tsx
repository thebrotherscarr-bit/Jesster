import React, { useCallback, useEffect, useState } from 'react';
import { X, Check, CircleAlert, RefreshCw } from 'lucide-react';
import { EvalsView, MemoryFile, RunsView, SkillInfo, StewardStatus, StewardUses, ToolPolicy } from '../types/desktop.ts';
import { CONSOLE_SHELVES, ConsoleShelf, barStatus, mcpServers, shortTime, versusBaseline } from '../utils/agentConsole.ts';
import { approvalWord } from '../utils/approvals.ts';
import { ServersShelf } from './ServersShelf.tsx';
import { ApprovalsShelf } from './ApprovalsShelf.tsx';
import { AtlasSection } from './settings/AtlasSection.tsx';
import { AutomationsSection } from './settings/AutomationsSection.tsx';
import { McpSection } from './settings/McpSection.tsx';
import { TerminalSection } from './settings/TerminalSection.tsx';
import { CheckSection } from './settings/CheckSection.tsx';
import { BrowserSection } from './settings/BrowserSection.tsx';
import { ComputerSection } from './settings/ComputerSection.tsx';

const clean = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/** A card: a title, one line of help, its body (Aurora's .ag-card: h4, .ag-hint). */
const Card: React.FC<{ title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode }> = ({ title, hint, action, children }) => (
  <div className="rounded-xl border border-neutral-800 p-3 space-y-2 min-w-0">
    <div className="flex items-center gap-2">
      <h4 className="text-xs font-semibold text-neutral-100 min-w-0 truncate">{title}</h4>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
    {hint && <p className="text-[11px] text-neutral-400">{hint}</p>}
    {children}
  </div>
);

/** Nothing to show (Aurora's .ag-empty). */
const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="rounded-lg border border-dashed border-neutral-800 p-3 text-center text-[11px] text-neutral-500">{children}</p>
);

const BTN = 'flex items-center gap-1 px-2 py-0.5 rounded-md border border-neutral-700 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40';

/** A read, once on show and again on Refresh: its value, its error and the refresh. */
function useRead<T>(fn: (() => Promise<T>) | undefined) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  const read = useCallback(async () => {
    if (!fn) return;
    try {
      setValue(await fn());
      setError('');
    } catch (e) {
      setError(clean(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    read();
  }, [read]);
  return { value, error, read };
}

const Refresh: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button onClick={onClick} className={BTN} aria-label="Refresh">
    <RefreshCw className="w-3 h-3" /> Refresh
  </button>
);

// ---- Servers ------------------------------------------------------------------------------------------------------

const STATUS_EVERY_MS = 10000;

/** Steward himself: ready or not, Restart Steward (his one primary action), the pieces the Servers list does not carry, the model loaded. */
const StewardCard: React.FC = () => {
  const api = window.secondbrainDesktop?.steward;
  const [status, setStatus] = useState<StewardStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const read = useCallback(async () => {
    if (!api) return;
    try {
      setStatus(await api.status());
    } catch {
      /* the next read tries again */
    }
  }, [api]);
  useEffect(() => {
    read();
    const t = setInterval(read, STATUS_EVERY_MS);
    return () => clearInterval(t);
  }, [read]);
  if (!api) return null;
  const restart = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.control('all', 'restart');
      setError(r.errors.join(' '));
      setStatus(r.status);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  };
  // the Servers list below carries his service, his MCP, the door, the glass and Ollama with their controls
  const extra = (status?.pieces || []).filter((p) => !['steward', 'steward-mcp', 'door', 'glass', 'ollama'].includes(p.id));
  return (
    <Card
      title={
        <span className={status?.ready ? 'text-emerald-400' : 'text-amber-400'}>{status ? (status.ready ? 'Steward is ready' : 'Steward is not ready') : 'Steward: checking…'}</span>
      }
      hint="His service and the door both answer when he is ready."
      action={
        <button onClick={restart} disabled={busy} data-console="Steward" className="px-2.5 py-1 rounded-lg bg-white text-black text-[11px] font-semibold hover:bg-neutral-200 disabled:opacity-50">
          {busy ? 'Restarting…' : 'Restart Steward'}
        </button>
      }
    >
      {error && <p className="text-xs text-amber-400 [overflow-wrap:anywhere]">{error}</p>}
      {extra.map((p) => (
        <div key={p.id} className="flex items-start gap-2 text-xs">
          {p.up ? <Check className="w-3.5 h-3.5 mt-0.5 text-emerald-400 shrink-0" /> : <CircleAlert className="w-3.5 h-3.5 mt-0.5 text-amber-400 shrink-0" />}
          <div className="min-w-0">
            <div className="text-neutral-100">
              {p.label} <code className="text-neutral-500">:{p.port}</code> <span className={p.up ? 'text-emerald-400' : 'text-amber-400'}>{p.up ? 'connected' : 'not answering'}</span>
            </div>
            <div className="text-neutral-500">{p.what}</div>
          </div>
        </div>
      ))}
      <p className="text-xs text-neutral-300">
        Model loaded: {status?.models.length ? status.models.join(', ') : <span className="text-neutral-500">none right now</span>}
      </p>
    </Card>
  );
};

/** How the estate fits together, in the record's words (was the Steward window's third tab). */
const ESTATE: { name: string; is: string }[] = [
  { name: 'Steward', is: 'The agent that runs the system: a MAF harness on Ollama. His service (43120) is what this tab talks to; his MCP (43121) offers him to other clients.' },
  { name: 'Jesster', is: "The console. It runs Steward's service, shows his cards, and serves him notes, the web, skills and the door's tools at /mcp (43110)." },
  { name: 'The door', is: "Aurora's tools, served by Jesster on 43111. A write from anyone but your own window waits as a card." },
  { name: 'Aurora', is: 'The glass: the web app on 8091, opened by Open Aurora.' },
  { name: 'Manjuel', is: 'The REPL and semantic microkernel: the record, the law, the seats and the rack of models.' },
  { name: 'Ollama', is: 'The local models, on 11434. One model at a time on this PC.' },
];

// Ollama, integrations and voice are sections of Settings, and Telegram is on the Phone view (utils/settingsMap.ts):
// nothing here opens a window of its own
const ServersPane: React.FC = () => (
  <>
    <StewardCard />
    <ServersShelf />
    <div className="rounded-xl border border-neutral-800 overflow-hidden [&>section]:px-3 [&>section:last-child]:border-b-0">
      <AtlasSection />
    </div>
    <details className="rounded-xl border border-neutral-800 p-3 text-xs">
      <summary className="cursor-pointer text-neutral-300">How it fits together</summary>
      <dl className="mt-2 space-y-1.5">
        {ESTATE.map((e) => (
          <div key={e.name}>
            <dt className="text-neutral-100">{e.name}</dt>
            <dd className="text-neutral-500">{e.is}</dd>
          </div>
        ))}
      </dl>
    </details>
  </>
);

// ---- Evals --------------------------------------------------------------------------------------------------------

/** The bar: the small set whole on its two newest runs, and the newest steps run passing (barStatus). */
const BarLine: React.FC<{ history: EvalsView['history'] }> = ({ history }) => {
  const bar = barStatus(history);
  const run = (r: { passed: number; total: number } | null) =>
    r ? <span className={r.total > 0 && r.passed === r.total ? 'text-emerald-400' : 'text-amber-400'}>{r.passed}/{r.total}</span> : <span>none yet</span>;
  return (
    <div data-eval-bar className="text-[11px] text-neutral-400 tabular-nums">
      Bar: <span className={bar.met ? 'text-emerald-400 font-semibold' : 'text-amber-400'}>{bar.met ? 'met' : 'not met'}</span> · small{' '}
      {bar.small.length ? bar.small.map((r, i) => <React.Fragment key={r.ts}>{i ? ', ' : ''}{run(r)}</React.Fragment>) : <span>none yet</span>} · steps {run(bar.steps)}
    </div>
  );
};

const EvalsPane: React.FC = () => {
  const api = window.secondbrainDesktop?.stewardConsole;
  const { value, error, read } = useRead<EvalsView>(api?.evals);
  const tone = { above: 'text-emerald-400', at: 'text-neutral-300', below: 'text-amber-400', '': 'text-neutral-300' } as const;
  return (
    <Card title="Eval runs" hint="Each run of his eval sets, newest first, against the baseline." action={<Refresh onClick={read} />}>
      {error && <p className="text-xs text-amber-400">{error}</p>}
      {value?.baseline != null && (
        <div className="text-[11px] text-neutral-400">
          Baseline:{' '}
          {Object.entries(value.baseline as Record<string, { checks?: number; of?: number }>).map(([set, b]) => (
            <span key={set} className="mr-2">
              <code className="text-neutral-200">{set}</code> {b?.checks}/{b?.of} checks
            </span>
          ))}
        </div>
      )}
      {value?.baselineError && <p className="text-xs text-amber-400">The baseline could not be read: {value.baselineError}</p>}
      {value && value.history.length > 0 && <BarLine history={value.history} />}
      {value && !value.history.length && <Empty>No eval has run yet.</Empty>}
      {!value && !error && <Empty>Reading…</Empty>}
      {value?.history.map((r) => {
        const vs = versusBaseline(r, value.baseline);
        return (
          <details key={r.ts} className="border-t border-neutral-900 pt-1.5 text-xs">
            <summary className="cursor-pointer flex flex-wrap items-baseline gap-x-2 tabular-nums">
              <span className="text-neutral-400">{shortTime(r.ts)}</span>
              <code className="text-neutral-200">{r.set}</code>
              <span className={r.passed === r.total ? 'text-emerald-400' : 'text-amber-400'}>
                {r.passed}/{r.total} passed
              </span>
              <span className={tone[vs]}>
                {r.checksPassed}/{r.checksTotal} checks{vs ? ` (${vs} baseline)` : ''}
              </span>
            </summary>
            <div className="mt-1 space-y-1 pl-3">
              <div className="text-[11px] text-neutral-500">
                {r.model && <>model {r.model} · </>}
                {r.gitHead && <>at {r.gitHead}</>}
              </div>
              {r.progress.length > 0 && (
                <ol data-eval-progress className="pl-1 text-[11px] text-neutral-400 space-y-0.5">
                  {r.progress.map((p, i) => (
                    <li key={i} className={/failed/.test(p) ? 'text-amber-400' : /passed/.test(p) ? 'text-emerald-400' : ''}>
                      {p}
                    </li>
                  ))}
                </ol>
              )}
              {r.cases.map((c, i) => (
                <div key={i} className="space-y-0.5">
                  <div className={c.passed ? 'text-emerald-400' : 'text-amber-400'}>
                    {c.passed ? '✓' : '✗'} <span className="text-neutral-300">{c.input}</span>
                  </div>
                  {c.failed.map((f) => (
                    <div key={f.name} className="pl-4 text-[11px] text-neutral-400 [overflow-wrap:anywhere]">
                      <code className="text-neutral-200">{f.name}</code>: {f.reason}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
        );
      })}
    </Card>
  );
};

// ---- Runs & telemetry -------------------------------------------------------------------------------------------

const RunsPane: React.FC = () => {
  const api = window.secondbrainDesktop?.stewardConsole;
  const { value, error, read } = useRead<RunsView>(api?.runs);
  return (
    <Card
      title="Recent runs"
      hint={value ? `From the last ${Math.round(value.read / 1024)} KB of his traces (${Math.round(value.size / 1048576)} MB in all).` : 'From the end of his traces file.'}
      action={<Refresh onClick={read} />}
    >
      {error && <p className="text-xs text-amber-400">{error}</p>}
      {!value && !error && <Empty>Reading…</Empty>}
      {value && !value.runs.length && <Empty>No run in the latest traces.</Empty>}
      {value?.runs.map((r) => (
        <details key={r.traceId} className="border-t border-neutral-900 pt-1.5 text-xs">
          <summary className="cursor-pointer flex flex-wrap items-baseline gap-x-2 tabular-nums">
            <span className="text-neutral-400">{shortTime(r.start)}</span>
            <span className="text-neutral-200 truncate">{r.root || 'run'}</span>
            <span className="text-neutral-500">{r.tools.length} tool calls</span>
            {r.errors.length > 0 && <span className="text-amber-400">{r.errors.length} errors</span>}
          </summary>
          <div className="mt-1 space-y-0.5 pl-3">
            <code className="block text-[10px] text-neutral-600">{r.traceId}</code>
            {r.tools.map((t, i) => (
              <div key={i} className="text-[11px] [overflow-wrap:anywhere]">
                <code className={t.ok ? 'text-neutral-200' : 'text-amber-400'}>{t.name}</code> <span className="text-neutral-500 font-mono">{t.args}</span>
              </div>
            ))}
            {r.errors.map((e, i) => (
              <div key={`e${i}`} className="text-[11px] text-amber-400 [overflow-wrap:anywhere]">
                {e.name}: {e.message}
              </div>
            ))}
          </div>
        </details>
      ))}
      {value && value.background > 0 && (
        <p className="text-[11px] text-neutral-500">
          Also {value.background} background traces (pings, tool lists){value.backgroundErrors ? `, ${value.backgroundErrors} with errors` : ''}.
        </p>
      )}
    </Card>
  );
};

// ---- Tools & policy -----------------------------------------------------------------------------------------------

/** Which of Steward's tools ask a card, from his storage/tool-policy.json (read only; was the Approvals window's). */
export const ToolPolicyTable: React.FC<{ policy: ToolPolicy | null }> = ({ policy }) => (
  <>
    {!policy && <Empty>Reading…</Empty>}
    {policy?.state === 'absent' && <Empty>Steward has not written his tool policy yet.</Empty>}
    {policy?.state === 'malformed' && (
      <p className="text-xs text-amber-400 [overflow-wrap:anywhere]">
        His tool policy could not be read ({policy.error}): <code className="text-neutral-500">{policy.file}</code>
      </p>
    )}
    {policy?.state === 'ok' && (
      <>
        <div className="text-[11px] text-neutral-500 [overflow-wrap:anywhere]">
          From <code>{policy.file}</code>
          {policy.ts ? `, written ${shortTime(policy.ts)}` : ''}
        </div>
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-neutral-500 border-b border-neutral-800">
              <th className="font-normal pr-2 py-0.5">Tool</th>
              <th className="font-normal pr-2 py-0.5">Source</th>
              <th className="font-normal py-0.5">Asks</th>
            </tr>
          </thead>
          <tbody>
            {policy.tools.map((t) => (
              <tr key={`${t.source}:${t.name}`} className="align-top text-neutral-300 border-b border-neutral-900" title={t.notes || ''}>
                <td className="pr-2 py-0.5 [overflow-wrap:anywhere]">
                  <code className="text-neutral-100">{t.name}</code>
                </td>
                <td className="pr-2 py-0.5 text-neutral-500">{t.source}</td>
                <td className={`py-0.5 ${t.approval === 'never' ? 'text-neutral-400' : 'text-amber-400'}`}>{approvalWord(t.approval)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!policy.tools.length && <Empty>The policy lists no tools.</Empty>}
      </>
    )}
  </>
);

const ToolsPane: React.FC = () => {
  const desk = window.secondbrainDesktop;
  const policy = useRead<ToolPolicy>(desk?.approvals?.policy);
  const uses = useRead<StewardUses>(desk?.steward?.uses);
  const servers = mcpServers(policy.value);
  return (
    <>
      <Card title="Which tools ask" hint="Every tool Steward has, where it comes from, and whether it waits for your card." action={<Refresh onClick={policy.read} />}>
        <div data-console="Tool policy" className="space-y-2">
          {policy.error && <p className="text-xs text-amber-400">{policy.error}</p>}
          <ToolPolicyTable policy={policy.value} />
        </div>
      </Card>
      <Card title="MCP servers he is connected to" hint="Named by his tool policy's sources.">
        {servers.length ? (
          servers.map((s) => (
            <div key={s.name} className="flex justify-between text-xs border-b border-neutral-900 last:border-b-0 py-0.5">
              <code className="text-neutral-200">{s.name}</code>
              <span className="text-neutral-500 tabular-nums">{s.tools} tools</span>
            </div>
          ))
        ) : (
          <Empty>None named.</Empty>
        )}
      </Card>
      <Card title={`Tools Jesster serves him (${uses.value?.tools.length ?? '…'})`} hint={uses.value && !uses.value.shareOn ? "Jesster's MCP is off (Aurora sharing, on the Servers shelf), so he cannot reach these." : undefined}>
        {uses.error && <p className="text-xs text-amber-400">{uses.error}</p>}
        <div className="flex flex-wrap gap-1">
          {(uses.value?.tools || []).map((t) => (
            <code key={t} className="px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-[11px] text-neutral-300">
              {t}
            </code>
          ))}
        </div>
      </Card>
      <div className="rounded-xl border border-neutral-800 overflow-hidden [&>section]:px-3 [&>section:last-child]:border-b-0">
        <TerminalSection />
        <BrowserSection />
        <ComputerSection />
        <CheckSection />
        <McpSection />
        <AutomationsSection />
      </div>
    </>
  );
};

// ---- Skills & memory ----------------------------------------------------------------------------------------------

const SkillsPane: React.FC = () => {
  const desk = window.secondbrainDesktop;
  const api = desk?.stewardConsole;
  const skills = useRead<{ skills: SkillInfo[] }>(api?.skills);
  const memory = useRead<{ files: MemoryFile[] }>(api?.memory);
  const uses = useRead<StewardUses>(desk?.steward?.uses);
  const [shown, setShown] = useState<{ path: string; text: string; cut: boolean } | null>(null);
  const [showError, setShowError] = useState('');
  const show = async (p: string) => {
    if (!api) return;
    if (shown?.path === p) return setShown(null);
    try {
      setShown(await api.memoryRead(p));
      setShowError('');
    } catch (e) {
      setShowError(clean(e));
    }
  };
  return (
    <>
      <Card title={`His skills (${skills.value?.skills.length ?? '…'})`} hint="From harness/steward/skills, each SKILL.md's name and description." action={<Refresh onClick={skills.read} />}>
        {skills.error && <p className="text-xs text-amber-400">{skills.error}</p>}
        {skills.value && !skills.value.skills.length && <Empty>No skill found.</Empty>}
        {skills.value?.skills.map((s) => (
          <div key={s.folder} className="text-xs border-b border-neutral-900 last:border-b-0 pb-1">
            <code className="text-neutral-100">{s.name}</code>
            {s.description && <p className="text-[11px] text-neutral-400 line-clamp-3" title={s.description}>{s.description}</p>}
          </div>
        ))}
      </Card>
      <Card title={`Skill notes from Jesster (${uses.value?.skillNotes.length ?? '…'})`}>
        <p className="text-xs text-neutral-400 [overflow-wrap:anywhere]">{uses.value ? uses.value.skillNotes.join(', ') || 'none' : 'Reading…'}</p>
      </Card>
      <Card title={`His memory (${memory.value?.files.length ?? '…'} files)`} hint="Click a file to read it." action={<Refresh onClick={memory.read} />}>
        {memory.error && <p className="text-xs text-amber-400">{memory.error}</p>}
        {showError && <p className="text-xs text-amber-400">{showError}</p>}
        {memory.value && !memory.value.files.length && <Empty>No memory store found.</Empty>}
        {memory.value?.files.map((f) => (
          <div key={f.path}>
            <button onClick={() => show(f.path)} aria-pressed={shown?.path === f.path} className="w-full flex justify-between gap-2 text-left text-xs py-0.5 hover:bg-neutral-900 rounded">
              <code className={`truncate ${shown?.path === f.path ? 'text-white' : 'text-neutral-300'}`}>{f.path}</code>
              <span className="text-neutral-500 tabular-nums shrink-0">{f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</span>
            </button>
            {shown?.path === f.path && (
              <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-neutral-900 border border-neutral-800 p-2 text-[11px] leading-snug font-mono text-neutral-300 whitespace-pre-wrap break-words">
                {shown.text}
                {shown.cut ? '\n…(cut at 256 KB)' : ''}
              </pre>
            )}
          </div>
        ))}
      </Card>
    </>
  );
};

// ---- the panel --------------------------------------------------------------------------------------------------

const SHELF_KEY = 'secondbrain_console_shelf_v1';

/**
 * The console, beside the conversation (Aurora's Inspector: a panel of tabs that opens beside the terminal and closes
 * with its X). One shelf at a time; the last one used is remembered.
 */
export const AgentConsole: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [shelf, setShelf] = useState<ConsoleShelf>(() => {
    const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(SHELF_KEY)) || '';
    return CONSOLE_SHELVES.some((s) => s.id === saved) ? (saved as ConsoleShelf) : 'servers';
  });
  const pick = (s: ConsoleShelf) => {
    setShelf(s);
    try {
      localStorage.setItem(SHELF_KEY, s);
    } catch {
      /* the choice is not kept */
    }
  };
  const label = CONSOLE_SHELVES.find((s) => s.id === shelf)?.label;
  return (
    <aside aria-label="Console" className="flex w-[30rem] max-w-[50%] shrink-0 min-h-0 min-w-0 flex-col border-l border-neutral-800">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800">
        <span className="text-[11px] text-neutral-500">
          console <span className="text-neutral-700">/</span> <b className="text-neutral-200 font-semibold">{label}</b>
        </span>
        <button onClick={onClose} aria-label="Close the console" className="ml-auto p-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div role="tablist" className="flex items-center gap-1 px-3 py-1.5 border-b border-neutral-800 overflow-x-auto">
        {CONSOLE_SHELVES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={shelf === s.id}
            onClick={() => pick(s.id)}
            className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap ${shelf === s.id ? 'bg-neutral-800 text-white font-semibold' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 space-y-3">
        {shelf === 'servers' && <ServersPane />}
        {shelf === 'approvals' && <ApprovalsShelf />}
        {shelf === 'evals' && <EvalsPane />}
        {shelf === 'runs' && <RunsPane />}
        {shelf === 'tools' && <ToolsPane />}
        {shelf === 'skills' && <SkillsPane />}
      </div>
    </aside>
  );
};
