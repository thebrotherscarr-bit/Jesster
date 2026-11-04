import React, { useEffect, useRef, useState } from 'react';
import { Smartphone, ShieldAlert, Check, X, Settings2 } from 'lucide-react';
import { PhoneConversation, PhoneEntry } from '../types/desktop.ts';
import { VoiceSettings } from '../voice/useVoice.ts';
import { renderMarkdown } from '../utils/markdown.ts';
import { SpeakToggle } from './SpeakToggle.tsx';
import { TelegramSection } from './settings/TelegramSection.tsx';

/**
 * The phone (the operator, 2026-11-04: "so we know like 'this is the pc' and 'this is the phone'"): the Agent tab's
 * basics for the phone's conversations with Steward. On the left each chat (Telegram today); on the right what was
 * said both ways, as it happened, and its cards, answered here the way the Agent tab answers them (the phone's
 * buttons settle too). Telegram's setup is here, folded under Setup.
 */
export const PhoneView: React.FC<{ voice?: VoiceSettings; onVoiceChange?: (v: Partial<VoiceSettings>) => void }> = ({ voice, onVoiceChange }) => {
  const desk = window.secondbrainDesktop;
  const phone = desk?.phone;
  const agent = desk?.agent;
  const [chats, setChats] = useState<PhoneConversation[]>([]);
  const [chat, setChat] = useState<PhoneConversation | null>(null);
  const [entries, setEntries] = useState<PhoneEntry[]>([]);
  const [open, setOpen] = useState<string[]>([]);
  const [setup, setSetup] = useState(false);
  const current = useRef<PhoneConversation | null>(null);
  current.current = chat;
  const pane = useRef<HTMLDivElement>(null);

  const refresh = () => phone?.list().then(setChats).catch(() => {});

  const show = async (c: PhoneConversation) => {
    setChat(c);
    const r = await phone!.read(c.channel, c.chatId);
    setEntries([...r.entries].reverse());
    setOpen(r.open);
  };

  useEffect(() => {
    if (!phone) return;
    refresh();
    const offEntry = phone.onEntry((e) => {
      refresh();
      const c = current.current;
      if (!c || c.channel !== e.channel || c.chatId !== e.chatId) return;
      setEntries((x) => [...x, e]);
      if (e.kind === 'card' && e.cardId) setOpen((o) => [...o, e.cardId!]);
      if (e.kind === 'answer' && e.cardId) setOpen((o) => o.filter((id) => id !== e.cardId));
    });
    // a card answered anywhere (here, the Agent tab, the phone) loses its buttons here
    const offAnswered = agent?.onAnswered?.((d) => setOpen((o) => o.filter((id) => id !== d.id)));
    return () => {
      offEntry();
      offAnswered?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  useEffect(() => {
    if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }, [entries]);

  if (!phone) return <div className="p-8 text-sm text-neutral-400">The phone view runs in the Jesster desktop app.</div>;

  const answer = async (cardId: string, allow: boolean) => {
    await agent?.approve(cardId, allow);
    setOpen((o) => o.filter((id) => id !== cardId));
  };

  return (
    <div className="flex flex-1 min-w-0 min-h-0">
      <aside aria-label="Phone conversations" className="flex w-56 max-w-[30%] shrink-0 min-w-0 min-h-0 flex-col border-r border-neutral-800">
        <ul className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-2 space-y-0.5">
          {chats.map((c) => (
            <li key={`${c.channel}:${c.chatId}`} className="min-w-0">
              <button
                onClick={() => show(c)}
                title={c.last}
                className={`block w-full min-w-0 text-left px-2 py-1.5 rounded-md text-xs truncate ${chat?.channel === c.channel && chat.chatId === c.chatId ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'}`}
              >
                {c.label}
              </button>
            </li>
          ))}
          {!chats.length && <li className="px-2 py-1.5 text-xs text-neutral-500">No phone conversations yet.</li>}
        </ul>
      </aside>

      <section className="flex flex-1 min-w-0 min-h-0 flex-col">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800 text-xs min-w-0">
          <Smartphone className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <span className="text-neutral-200 font-semibold">Phone</span>
          <span className="text-neutral-600">/</span>
          <span className="text-neutral-500 truncate min-w-0">{chat?.label || 'pick a conversation'}</span>
          <span className="ml-auto" />
          <SpeakToggle voice={voice} onVoiceChange={onVoiceChange} />
          <button
            onClick={() => setSetup(!setup)}
            aria-pressed={setup}
            title="Telegram: the bot, its token and the paired chats"
            className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md ${setup ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'}`}
          >
            <Settings2 className="w-3.5 h-3.5" /> Setup
          </button>
        </div>
        {setup && (
          <div className="border-b border-neutral-800 max-h-[50%] overflow-y-auto">
            <TelegramSection />
          </div>
        )}
        <div ref={pane} className="flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-8 py-6 space-y-4">
          {!chat && (
            <div className="max-w-xl mx-auto text-center text-neutral-400 mt-16 space-y-2">
              <Smartphone className="w-10 h-10 mx-auto text-sky-400" />
              <p className="text-sm text-neutral-200">What you and Steward said on the phone.</p>
              <p className="text-xs">Pick a conversation on the left. Telegram is set up under Setup.</p>
            </div>
          )}
          {entries.map((e, i) =>
            e.kind === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] min-w-0 rounded-2xl bg-neutral-800 px-4 py-2.5 text-sm text-white whitespace-pre-wrap [overflow-wrap:anywhere]">{e.text}</div>
              </div>
            ) : e.kind === 'reply' ? (
              <div key={i} className="agent-md prose prose-invert prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(e.text) }} />
            ) : e.kind === 'card' ? (
              <div key={i} role="alertdialog" className="rounded-xl border border-amber-800 bg-amber-950/40 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm text-amber-200">
                  <ShieldAlert className="w-4 h-4 shrink-0" /> <span className="min-w-0 [overflow-wrap:anywhere]">Steward wants to use <code>{e.name}</code></span>
                </div>
                <pre className="text-xs text-neutral-200 whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-w-full bg-black/40 rounded-md p-2">{e.text}</pre>
                {e.cardId && open.includes(e.cardId) && (
                  <div className="flex gap-2">
                    <button onClick={() => answer(e.cardId!, true)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-xs text-white hover:bg-emerald-500">
                      <Check className="w-3.5 h-3.5" /> Allow
                    </button>
                    <button onClick={() => answer(e.cardId!, false)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800">
                      <X className="w-3.5 h-3.5" /> Deny
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div key={i} className="text-[11px] text-neutral-500 pl-2 border-l border-neutral-800">
                {e.text}
                {e.where === 'telegram' ? ' on the phone' : e.where ? ' on the PC' : ''}
              </div>
            )
          )}
        </div>
      </section>
    </div>
  );
};
