import React, { useEffect, useState } from 'react';
import { MessageCircle, Check, X } from 'lucide-react';
import { DiscordState } from '../../types/desktop.ts';

/** Discord: chat with SecondBrain from your phone, in a DM with your own bot (electron/agent/discord.cjs). */
export const DiscordSection: React.FC = () => {
  const desk = window.secondbrainDesktop;
  const bridge = desk?.discord;
  const [state, setState] = useState<DiscordState | null>(null);
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge || !desk?.settings) return;
    bridge.state().then(setState);
    desk.settings.get().then((s) => {
      const d = (s.discord || {}) as { token?: string; enabled?: boolean };
      setToken(d.token || '');
      setEnabled(Boolean(d.enabled));
    });
    return bridge.onState(setState);
  }, [bridge, desk]);

  if (!bridge || !desk?.settings) return null;

  const save = async (patch: { token?: string; enabled?: boolean }) => {
    setNote(null);
    await desk.settings!.set('discord', patch);
    setTimeout(() => bridge.state().then(setState), 1500);
  };

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Discord">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <MessageCircle className="w-4 h-4 text-indigo-400" /> Discord
      </div>
      <p className="text-xs text-neutral-400">
        Chat with Jesster from your phone while the app runs, in a direct message with your own bot. In the Discord
        Developer Portal make a <b>New Application</b>, open <b>Bot</b>, press <b>Reset Token</b> and paste the token
        here. Add the bot to a server of yours (<b>OAuth2</b> → URL Generator → scope <code>bot</code>), then send it a
        direct message: your user shows up below to approve. Only approved users get answers; server channels are never
        read.
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Bot token from the Developer Portal"
          aria-label="Discord bot token"
          className="flex-1 rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white"
        />
        <button onClick={() => save({ token, enabled: true }).then(() => setEnabled(true))} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs text-white">
          Save and start
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            save({ enabled: e.target.checked });
          }}
        />
        Connected
      </label>
      <div className="text-xs text-neutral-400">
        {state?.running ? <span className="text-emerald-400">Running as {state.bot}</span> : state?.error ? <span className="text-amber-400">{state.error}</span> : 'Not running'}
      </div>
      {state?.pending.length ? (
        <div className="space-y-1">
          <div className="text-xs text-neutral-300">Waiting for approval:</div>
          {state.pending.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-xs">
              <span className="text-neutral-200">{p.name}</span>
              <span className="text-neutral-500">user {p.id}</span>
              <button aria-label={`Approve ${p.name} on Discord`} onClick={() => bridge.pair(p.id, true).then(setState)} className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 text-white">
                <Check className="w-3 h-3" /> Approve
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {state?.allowed.length ? (
        <div className="space-y-1">
          <div className="text-xs text-neutral-300">Paired users:</div>
          {state.allowed.map((id) => (
            <div key={id} className="flex items-center gap-2 text-xs text-neutral-400">
              user {id}
              <button aria-label={`Remove Discord user ${id}`} onClick={() => bridge.pair(id, false).then(setState)} className="p-0.5 rounded hover:text-rose-400">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          <button
            onClick={() => bridge.test().then(() => setNote('Sent.'), (e) => setNote(String(e.message || e)))}
            className="px-2.5 py-1 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Send a test message
          </button>
        </div>
      ) : null}
      {note && <p className="text-xs text-neutral-400">{note}</p>}
    </section>
  );
};
