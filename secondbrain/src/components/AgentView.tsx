import React, { useEffect, useRef, useState } from 'react';
import { Bot, Plus, Send, Square, Wrench, ShieldAlert, Check, X, MessageSquare, Mic, Loader2 } from 'lucide-react';
import { VoiceSettings, useRecorder, speak } from '../voice/useVoice.ts';
import { AgentEvent, ApprovalRequest } from '../types/desktop.ts';
import { OllamaConfig } from '../types/index.ts';
import { renderMarkdown } from '../utils/markdown.ts';

interface Turn {
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'error' | 'check';
  text: string;
  name?: string;
  // assistant text or thinking still arriving from Steward's stream
  live?: boolean;
}

interface AgentViewProps {
  ollamaConfig: OllamaConfig;
  voice?: VoiceSettings;
  onOpenNote: (id: string) => void;
}

// MAF's PlanningResponse, as the guide's console renders it in plan mode: a clarification (questions,
// each with choices) or an approval (the plan to approve before execute mode)
interface Planning {
  type: 'clarification' | 'approval';
  questions: { message: string; choices?: string[] | null }[];
}
const planningOf = (text: string): Planning | null => {
  try {
    const p = JSON.parse(text);
    return (p?.type === 'clarification' || p?.type === 'approval') && Array.isArray(p.questions) && p.questions.length ? p : null;
  } catch {
    return null;
  }
};
const APPROVE = 'Approve and switch to execute mode';

const PlanningCard: React.FC<{ p: Planning; open: boolean; onAnswer: (text: string, mode?: 'execute') => void }> = ({ p, open, onAnswer }) => (
  <div className="rounded-xl border border-cyan-900 bg-cyan-950/30 px-3 py-2 space-y-3" aria-label={p.type === 'approval' ? 'Plan to approve' : 'Clarifying questions'}>
    {p.questions.map((q, j) => (
      <div key={j} className="space-y-2">
        <div className="prose prose-invert prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(q.message) }} />
        {open && (
          <div className="flex flex-wrap gap-2">
            {p.type === 'approval' ? (
              <button onClick={() => onAnswer(APPROVE, 'execute')} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-xs text-white hover:bg-emerald-500">
                {APPROVE}
              </button>
            ) : (
              (q.choices || []).map((c) => (
                <button key={c} onClick={() => onAnswer(`Q: ${q.message}\nA: ${c}`)} className="px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800">
                  {c}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    ))}
    {open && <div className="text-[11px] text-neutral-500">Or type your own answer below.</div>}
  </div>
);

/**
 * The agent: chat with a model that uses tools (notes, todo, web, and more
 * as features add them). Runs in the desktop app; every conversation is
 * saved as a session note.
 */
export const AgentView: React.FC<AgentViewProps> = ({ ollamaConfig, voice }) => {
  const agent = window.secondbrainDesktop?.agent;
  const [sessions, setSessions] = useState<{ id: string; title: string; updatedAt: number; source?: string }[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [tools, setTools] = useState<{ name: string; description: string }[]>([]);
  // 'steward': the tab talks to Steward (electron/agent/steward.cjs); otherwise the local loop
  const [backend, setBackend] = useState('');
  const current = useRef<string | null>(null);
  // the conversation pane: it follows new text only while you are at its bottom
  const pane = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const speakRef = useRef(false);
  current.current = sessionId;
  speakRef.current = Boolean(voice?.speakReplies);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorder = useRecorder(
    voice?.whisperModel || '',
    (text) => setInput((x) => (x ? `${x} ${text}` : text)),
    setVoiceError
  );

  const refresh = () => agent?.sessions().then(setSessions);

  useEffect(() => {
    if (!agent) return;
    refresh();
    agent.tools().then(setTools);
    window.secondbrainDesktop?.settings
      ?.get()
      .then((s) => setBackend(String(s.agent?.backend || '')))
      .catch(() => {});
    const offEvent = agent.onEvent((e: AgentEvent) => {
      if (e.sessionId !== current.current) {
        if (e.type === 'done') refresh();
        return;
      }
      setTurns((t) => {
        if (e.type === 'tool') return [...t, { role: 'tool', name: e.name, text: JSON.stringify(e.args) }];
        if (e.type === 'result') {
          const last = [...t];
          for (let i = last.length - 1; i >= 0; i--) {
            if (last[i].role === 'tool' && last[i].name === e.name && !last[i].text.includes('\n→ ')) {
              last[i] = { ...last[i], text: `${last[i].text}\n→ ${e.text.slice(0, 400)}` };
              break;
            }
          }
          return last;
        }
        // his thinking, collected live into one line until something else arrives (MAF's
        // console shows it the same way: observers/reasoning_display.py)
        if (e.type === 'thinking') {
          const last = t[t.length - 1];
          if (last?.role === 'thinking' && last.live) return [...t.slice(0, -1), { ...last, text: last.text + e.text }];
          return [...t, { role: 'thinking', text: e.text, live: true }];
        }
        if (e.type === 'delta') {
          const last = t[t.length - 1];
          if (last?.role === 'assistant' && last.live) return [...t.slice(0, -1), { ...last, text: last.text + e.text }];
          return [...t, { role: 'assistant', text: e.text, live: true }];
        }
        if (e.type === 'answer') {
          if (speakRef.current) speak(e.text);
          // streamed: the text is already on screen, so it is settled in place, not shown twice
          if (t.some((x) => x.live)) return t.map((x) => (x.live ? { ...x, live: false } : x));
          return [...t, { role: 'assistant', text: e.text }];
        }
        if (e.type === 'error') return [...t.map((x) => (x.live ? { ...x, live: false } : x)), { role: 'error', text: e.text }];
        if (e.type === 'check') return [...t, { role: 'check', text: e.text }];
        return t;
      });
      if (e.type === 'done') {
        setBusy(false);
        refresh();
      }
    });
    const offApproval = agent.onApproval((r) => setApprovals((a) => [...a, r]));
    return () => {
      offEvent();
      offApproval();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // a conversation started from outside (agent_send over MCP) opens here, to be watched live
  useEffect(() => {
    if (!agent?.onShow) return;
    return agent.onShow(async (id) => {
      current.current = id;
      setSessionId(id);
      const s = await agent.open(id);
      setBusy(s.busy);
      setTurns(s.messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.content })));
      refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  useEffect(() => {
    const el = pane.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns, approvals]);

  if (!agent) {
    return <div className="p-8 text-sm text-neutral-400">The agent runs in the SecondBrain desktop app.</div>;
  }

  const open = async (id: string) => {
    const s = await agent.open(id);
    setSessionId(id);
    setBusy(s.busy);
    setTurns(s.messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.content })));
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    sendText(text);
  };

  const sendText = async (text: string, mode?: 'execute') => {
    if (busy) return;
    atBottom.current = true;
    setBusy(true);
    setTurns((t) => [...t, { role: 'user', text }]);
    const r = await agent.send(text, sessionId, { host: ollamaConfig.hostUrl, model: ollamaConfig.model, mode });
    setSessionId(r.sessionId);
    current.current = r.sessionId;
  };

  const answer = async (req: ApprovalRequest, allow: boolean, always = false) => {
    await agent.approve(req.id, allow, always);
    setApprovals((a) => a.filter((x) => x.id !== req.id));
  };

  return (
    <div className="flex flex-1 min-h-0">
      <aside className="hidden md:flex w-64 shrink-0 min-h-0 flex-col border-r border-neutral-800">
        <button
          onClick={() => {
            setSessionId(null);
            setTurns([]);
            setBusy(false);
          }}
          className="m-3 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-white text-black text-xs font-semibold hover:bg-neutral-200"
        >
          <Plus className="w-3.5 h-3.5" /> New conversation
        </button>
        <div className="px-3 pb-2 text-[10px] uppercase tracking-wider text-neutral-500">Sessions</div>
        <ul className="flex-1 min-h-0 overflow-y-auto px-2 space-y-0.5" aria-label="Agent sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => open(s.id)}
                className={`w-full text-left px-2 py-1.5 rounded-md text-xs truncate ${s.id === sessionId ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'}`}
                title={s.title}
              >
                <MessageSquare className="inline w-3 h-3 mr-1.5 -mt-0.5" />
                {s.title.replace(/^Agent: /, '')}
              </button>
            </li>
          ))}
        </ul>
        <details className="m-3 text-[11px] text-neutral-500">
          <summary className="cursor-pointer">{tools.length} tools available</summary>
          <ul className="mt-1 space-y-0.5 max-h-48 overflow-y-auto">
            {tools.map((t) => (
              <li key={t.name} title={t.description}>
                <code>{t.name}</code>
              </li>
            ))}
          </ul>
        </details>
      </aside>

      <section className="flex flex-1 min-w-0 min-h-0 flex-col">
        <div
          ref={pane}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 py-6 space-y-4"
        >
          {!turns.length && (
            <div className="max-w-xl mx-auto text-center text-neutral-400 mt-16 space-y-2">
              <Bot className="w-10 h-10 mx-auto text-emerald-400" />
              {backend === 'steward' ? (
                <>
                  <p className="text-sm text-neutral-200">Ask Steward to do something.</p>
                  <p className="text-xs">
                    Steward is your agent: he works through SecondBrain's notes, memory, skills and the web, and asks
                    here before anything that needs your yes. Every conversation is saved as a note.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-neutral-200">Ask SecondBrain to do something.</p>
                  <p className="text-xs">
                    It can search, read and write your notes, keep your todo list, and look things up on the web, using
                    your local model ({ollamaConfig.model}). Every conversation is saved as a note.
                  </p>
                </>
              )}
            </div>
          )}
          {turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl bg-neutral-800 px-4 py-2.5 text-sm text-white whitespace-pre-wrap">{t.text}</div>
              </div>
            ) : t.role === 'tool' ? (
              <div key={i} className="text-[11px] text-neutral-500 font-mono whitespace-pre-wrap break-words pl-2 border-l border-neutral-800">
                <Wrench className="inline w-3 h-3 mr-1 -mt-0.5" />
                {t.name} {t.text}
              </div>
            ) : t.role === 'thinking' ? (
              <div key={i} className="text-xs text-neutral-500 italic whitespace-pre-wrap break-words pl-2 border-l border-neutral-800" aria-label="Thinking">
                💭 {t.text}
              </div>
            ) : t.role === 'check' ? (
              <div key={i} className="rounded-xl border border-violet-900 bg-violet-950/30 px-3 py-2 space-y-1" aria-label="Claude's check">
                <div className="text-[11px] uppercase tracking-wider text-violet-300">Claude's check</div>
                <div className="prose prose-invert prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.text) }} />
              </div>
            ) : t.role === 'error' ? (
              <div key={i} role="alert" className="text-sm text-amber-300 bg-amber-950/40 border border-amber-900 rounded-lg px-3 py-2">
                {t.text}
              </div>
            ) : !t.live && planningOf(t.text) ? (
              <PlanningCard key={i} p={planningOf(t.text)!} open={i === turns.length - 1 && !busy} onAnswer={sendText} />
            ) : (
              <div
                key={i}
                className="prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(t.text) }}
              />
            )
          )}
          {approvals.map((r) => (
            <div key={r.id} role="alertdialog" className="rounded-xl border border-amber-800 bg-amber-950/40 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm text-amber-200">
                <ShieldAlert className="w-4 h-4" /> The agent wants to use <code>{r.name}</code>
              </div>
              <pre className="text-xs text-neutral-200 whitespace-pre-wrap break-words bg-black/40 rounded-md p-2">{r.summary}</pre>
              <div className="flex gap-2">
                <button onClick={() => answer(r, true)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-xs text-white hover:bg-emerald-500">
                  <Check className="w-3.5 h-3.5" /> Allow once
                </button>
                <button onClick={() => answer(r, true, true)} className="px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800">
                  Always allow this exact action
                </button>
                <button onClick={() => answer(r, false)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800">
                  <X className="w-3.5 h-3.5" /> Deny
                </button>
              </div>
            </div>
          ))}
          {busy && <div className="text-xs text-neutral-500 animate-pulse">Working…</div>}
          {voiceError && <div role="alert" className="text-xs text-amber-400">{voiceError}</div>}
          {recorder.progress && <div className="text-xs text-neutral-500">Preparing speech model: {recorder.progress}</div>}
        </div>
        <div className="border-t border-neutral-800 p-3 flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Ask the agent… (Enter to send, Shift+Enter for a new line)"
            aria-label="Message the agent"
            className="flex-1 resize-none rounded-xl bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
          />
          <button
            onClick={() => (recorder.state === 'recording' ? recorder.stop() : recorder.state === 'idle' && (setVoiceError(null), recorder.start()))}
            aria-label={recorder.state === 'recording' ? 'Stop recording' : 'Speak'}
            title={recorder.state === 'recording' ? 'Stop and transcribe' : recorder.state === 'idle' ? 'Speak (Whisper, on this PC)' : recorder.progress || 'Transcribing…'}
            className={`p-2.5 rounded-xl border ${recorder.state === 'recording' ? 'border-rose-500 bg-rose-950 text-rose-300 animate-pulse' : 'border-neutral-700 text-neutral-200 hover:bg-neutral-800'}`}
          >
            {recorder.state === 'idle' || recorder.state === 'recording' ? <Mic className="w-4 h-4" /> : <Loader2 className="w-4 h-4 animate-spin" />}
          </button>
          {busy ? (
            <button onClick={() => sessionId && agent.stop(sessionId)} aria-label="Stop" className="p-2.5 rounded-xl border border-neutral-700 text-neutral-200 hover:bg-neutral-800">
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={send} aria-label="Send" className="p-2.5 rounded-xl bg-white text-black hover:bg-neutral-200 disabled:opacity-40" disabled={!input.trim()}>
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </section>
    </div>
  );
};
