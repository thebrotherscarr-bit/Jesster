import React, { useEffect, useRef, useState } from 'react';
import { Bot, Plus, Send, Square, Wrench, ShieldAlert, Check, X, Mic, Loader2, PanelLeft, PanelRight } from 'lucide-react';
import { VoiceSettings, useRecorder, speak } from '../voice/useVoice.ts';
import { AgentEvent, ApprovalRequest } from '../types/desktop.ts';
import { OllamaConfig } from '../types/index.ts';
import { renderMarkdown } from '../utils/markdown.ts';
import { AgentConsole } from './AgentConsole.tsx';
import { StepLine } from './StepLine.tsx';
import { SpeakToggle } from './SpeakToggle.tsx';
import { CHATS_OPEN_KEY, CONSOLE_OPEN_KEY, WorkflowStepEvent, keepPanel, panelOpen, stepLine } from '../utils/agentConsole.ts';

// where the two folding panels keep their state (none when the window's storage cannot be reached)
const store = () => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

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
  /** a message to start from: the Notes tab's "Ask Steward" (n changes on every ask) */
  draft?: { text: string; n: number };
  /** the speaker in the header: voice.speakReplies on or off */
  onVoiceChange?: (v: Partial<VoiceSettings>) => void;
}

/**
 * The agent: chat with a model that uses tools (notes, todo, web, and more
 * as features add them). Runs in the desktop app; every conversation is
 * saved as a session note. Beside it, the console (AgentConsole.tsx): everything
 * that watches and steers Steward, opened and closed like Aurora's Inspector.
 */
export const AgentView: React.FC<AgentViewProps> = ({ ollamaConfig, voice, draft, onVoiceChange }) => {
  const agent = window.secondbrainDesktop?.agent;
  const [sessions, setSessions] = useState<{ id: string; title: string; updatedAt: number; source?: string }[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  // the turn's workflow steps (AG-UI step 3): the step line above its output; a new message starts a new line
  const [steps, setSteps] = useState<WorkflowStepEvent[]>([]);
  const [input, setInput] = useState('');
  // the Notes tab's "Ask Steward" puts the note in the message box; he sends nothing until it is sent
  useEffect(() => {
    if (draft) setInput(draft.text);
  }, [draft]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  // the console on the right and the chats bar on the left fold the same way, each remembered
  const [consoleOpen, setConsoleOpen] = useState(() => panelOpen(store(), CONSOLE_OPEN_KEY));
  const showConsole = (on: boolean) => {
    setConsoleOpen(on);
    keepPanel(store(), CONSOLE_OPEN_KEY, on);
  };
  const [chatsOpen, setChatsOpen] = useState(() => panelOpen(store(), CHATS_OPEN_KEY));
  const showChats = (on: boolean) => {
    setChatsOpen(on);
    keepPanel(store(), CHATS_OPEN_KEY, on);
  };
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
    window.secondbrainDesktop?.settings
      ?.get()
      .then((s) => setBackend(String(s.agent?.backend || '')))
      .catch(() => {});
    const offEvent = agent.onEvent((e: AgentEvent) => {
      if (e.sessionId !== current.current) {
        if (e.type === 'done') refresh();
        return;
      }
      if (e.type === 'user') setSteps([]);
      if (e.type === 'workflow_step') setSteps((x) => [...x, { name: e.name, state: e.state }]);
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
    // answered elsewhere (the console's Approvals shelf): the card leaves here too
    const offAnswered = agent.onAnswered?.((d) => setApprovals((a) => a.filter((x) => x.id !== d.id)));
    return () => {
      offEvent();
      offApproval();
      offAnswered?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // a conversation started from outside (agent_send over MCP) opens here, to be watched live
  useEffect(() => {
    if (!agent?.onShow) return;
    return agent.onShow(async (id) => {
      current.current = id;
      setSessionId(id);
      setSteps([]);
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
    return <div className="p-8 text-sm text-neutral-400">The agent runs in the Jesster desktop app.</div>;
  }

  const open = async (id: string) => {
    const s = await agent.open(id);
    setSessionId(id);
    setSteps([]);
    setBusy(s.busy);
    setTurns(s.messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.content })));
  };

  // a card waiting in this conversation: a message sent now answers it No and goes to the agent
  // next (service.cjs ask), so Send stays open while it waits
  const cardWaits = approvals.some((a) => a.sessionId === sessionId);
  const lastUser = turns.map((t) => t.role).lastIndexOf('user');

  const send = () => {
    const text = input.trim();
    if (!text || (busy && !cardWaits)) return;
    setInput('');
    sendText(text);
  };

  const sendText = async (text: string) => {
    if (busy && !cardWaits) return;
    atBottom.current = true;
    setBusy(true);
    setApprovals((a) => a.filter((x) => x.sessionId !== sessionId));
    setTurns((t) => [...t, { role: 'user', text }]);
    const r = await agent.send(text, sessionId, { host: ollamaConfig.hostUrl, model: ollamaConfig.model });
    setSessionId(r.sessionId);
    current.current = r.sessionId;
  };

  // a reply typed on a card (Kyle, 2026-11-02: "add a line to the card so i can reply on it"): sent as a message
  // while the card waits, so service.cjs answers it - a review takes it as guidance, any other card is answered
  // No and the reply goes to Steward next
  const [replies, setReplies] = useState<Record<string, string>>({});
  const replyOn = (req: ApprovalRequest) => {
    const text = (replies[req.id] || '').trim();
    if (!text) return;
    setReplies((r) => ({ ...r, [req.id]: '' }));
    sendText(text);
  };

  const answer = async (req: ApprovalRequest, allow: boolean, always = false) => {
    await agent.approve(req.id, allow, always);
    setApprovals((a) => a.filter((x) => x.id !== req.id));
  };

  return (
    <div className="flex flex-1 min-w-0 min-h-0">
      {/* the chats: a plain list of past conversations and one New chat, folded from the header like the console */}
      {chatsOpen && (
        <aside aria-label="Chats" className="flex w-56 max-w-[30%] shrink-0 min-w-0 min-h-0 flex-col border-r border-neutral-800">
          <button
            onClick={() => {
              setSessionId(null);
              setTurns([]);
              setSteps([]);
              setBusy(false);
            }}
            className="mx-2 mt-2 mb-1 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-neutral-300 hover:bg-neutral-900 hover:text-white min-w-0"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">New chat</span>
          </button>
          <ul className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-0.5" aria-label="Agent sessions">
            {sessions.map((s) => (
              <li key={s.id} className="min-w-0">
                <button
                  onClick={() => open(s.id)}
                  className={`block w-full min-w-0 text-left px-2 py-1.5 rounded-md text-xs truncate ${s.id === sessionId ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'}`}
                  title={s.title.replace(/^Agent: /, '')}
                >
                  {s.title.replace(/^Agent: /, '')}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}

      <section className="flex flex-1 min-w-0 min-h-0 flex-col">
        {/* one header line, as Aurora's terminal has: the chats' toggle, who you are talking to, and the console's toggle */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800 text-xs min-w-0">
          <button
            onClick={() => showChats(!chatsOpen)}
            aria-pressed={chatsOpen}
            aria-label={chatsOpen ? 'Close the chats' : 'Open the chats'}
            title="Past conversations"
            className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md ${chatsOpen ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'}`}
          >
            <PanelLeft className="w-3.5 h-3.5" /> Chats
          </button>
          <Bot className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="text-neutral-200 font-semibold">{backend === 'steward' ? 'Steward' : 'Agent'}</span>
          <span className="text-neutral-600">/</span>
          <span className="text-neutral-500 truncate min-w-0">{sessions.find((s) => s.id === sessionId)?.title.replace(/^Agent: /, '') || 'new conversation'}</span>
          <span className="ml-auto" />
          <SpeakToggle voice={voice} onVoiceChange={onVoiceChange} />
          <button
            onClick={() => showConsole(!consoleOpen)}
            aria-pressed={consoleOpen}
            aria-label={consoleOpen ? 'Close the console' : 'Open the console'}
            title="The console: servers, approvals, evals, runs, tools, skills and memory"
            className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md ${consoleOpen ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'}`}
          >
            <PanelRight className="w-3.5 h-3.5" /> Console
          </button>
        </div>
        <div
          ref={pane}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-8 py-6 space-y-4"
        >
          {!turns.length && (
            <div className="max-w-xl mx-auto text-center text-neutral-400 mt-16 space-y-2">
              <Bot className="w-10 h-10 mx-auto text-emerald-400" />
              {backend === 'steward' ? (
                <>
                  <p className="text-sm text-neutral-200">Ask Steward to do something.</p>
                  <p className="text-xs">
                    Steward is your agent: he works through Jesster's notes, memory, skills and the web, and asks
                    here before anything that needs your yes. Every conversation is saved as a note.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-neutral-200">Ask Jesster to do something.</p>
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
              <React.Fragment key={i}>
                <div className="flex justify-end">
                  <div className="max-w-[80%] min-w-0 rounded-2xl bg-neutral-800 px-4 py-2.5 text-sm text-white whitespace-pre-wrap [overflow-wrap:anywhere]">{t.text}</div>
                </div>
                {/* the step line sits above the output of the last turn, the one its events are for */}
                {i === lastUser && <StepLine cells={stepLine(steps, cardWaits)} />}
              </React.Fragment>
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
                <div className="agent-md prose prose-invert prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.text) }} />
              </div>
            ) : t.role === 'error' ? (
              <div key={i} role="alert" className="text-sm text-amber-300 bg-amber-950/40 border border-amber-900 rounded-lg px-3 py-2 [overflow-wrap:anywhere]">
                {t.text}
              </div>
            ) : (
              <div
                key={i}
                className="agent-md prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(t.text) }}
              />
            )
          )}
          {approvals.map((r) => (
            <div key={r.id} role="alertdialog" className="rounded-xl border border-amber-800 bg-amber-950/40 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm text-amber-200">
                <ShieldAlert className="w-4 h-4 shrink-0" /> <span className="min-w-0 [overflow-wrap:anywhere]">The agent wants to use <code>{r.name}</code></span>
              </div>
              <pre className="text-xs text-neutral-200 whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-w-full bg-black/40 rounded-md p-2">{r.summary}</pre>
              <div className="flex gap-2">
                <button onClick={() => answer(r, true)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-xs text-white hover:bg-emerald-500">
                  <Check className="w-3.5 h-3.5" /> Allow once
                </button>
                <button onClick={() => answer(r, false)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800">
                  <X className="w-3.5 h-3.5" /> Deny
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  value={replies[r.id] || ''}
                  onChange={(e) => setReplies((x) => ({ ...x, [r.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && replyOn(r)}
                  placeholder="Reply on this card…"
                  aria-label="Reply on this card"
                  className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-1 text-xs text-neutral-100"
                />
                <button
                  onClick={() => replyOn(r)}
                  disabled={!(replies[r.id] || '').trim()}
                  className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
                >
                  <Send className="w-3.5 h-3.5" /> Reply
                </button>
              </div>
            </div>
          ))}
          {busy && <div className="text-xs text-neutral-500 animate-pulse">Working…</div>}
          {voiceError && <div role="alert" className="text-xs text-amber-400">{voiceError}</div>}
          {recorder.progress && <div className="text-xs text-neutral-500">Preparing speech model: {recorder.progress}</div>}
        </div>
        <div className="border-t border-neutral-800 p-3 flex gap-2 items-end min-w-0">
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
            className="flex-1 min-w-0 resize-none rounded-xl bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
          />
          <button
            onClick={() => (recorder.state === 'recording' ? recorder.stop() : recorder.state === 'idle' && (setVoiceError(null), recorder.start()))}
            aria-label={recorder.state === 'recording' ? 'Stop recording' : 'Speak'}
            title={recorder.state === 'recording' ? 'Stop and transcribe' : recorder.state === 'idle' ? 'Speak (Whisper, on this PC)' : recorder.progress || 'Transcribing…'}
            className={`shrink-0 p-2.5 rounded-xl border ${recorder.state === 'recording' ? 'border-rose-500 bg-rose-950 text-rose-300 animate-pulse' : 'border-neutral-700 text-neutral-200 hover:bg-neutral-800'}`}
          >
            {recorder.state === 'idle' || recorder.state === 'recording' ? <Mic className="w-4 h-4" /> : <Loader2 className="w-4 h-4 animate-spin" />}
          </button>
          {busy && !cardWaits ? (
            <button onClick={() => sessionId && agent.stop(sessionId)} aria-label="Stop" className="shrink-0 p-2.5 rounded-xl border border-neutral-700 text-neutral-200 hover:bg-neutral-800">
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={send} aria-label="Send" className="shrink-0 p-2.5 rounded-xl bg-white text-black hover:bg-neutral-200 disabled:opacity-40" disabled={!input.trim()}>
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </section>
      {consoleOpen && <AgentConsole onClose={() => showConsole(false)} />}
    </div>
  );
};
