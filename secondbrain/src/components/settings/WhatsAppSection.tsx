import React, { useEffect, useState } from 'react';
import { MessageSquare, Check, X } from 'lucide-react';
import { WhatsAppState } from '../../types/desktop.ts';
import { channelOn } from '../../utils/channels.ts';

/** WhatsApp: chat with SecondBrain from your phone, on your own account linked as a device (electron/agent/whatsapp.cjs). */
export const WhatsAppSection: React.FC = () => {
  const desk = window.secondbrainDesktop;
  const bridge = desk?.whatsapp;
  const [state, setState] = useState<WhatsAppState | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge || !channelOn('whatsapp')) return;
    bridge.state().then(setState);
    return bridge.onState(setState);
  }, [bridge]);

  // shown while channels.json switches WhatsApp on
  if (!bridge || !desk?.settings || !channelOn('whatsapp')) return null;

  const save = async (patch: { enabled?: boolean; selfChat?: boolean }) => {
    setNote(null);
    await desk.settings!.set('whatsapp', patch);
    bridge.state().then(setState);
  };

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="WhatsApp">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <MessageSquare className="w-4 h-4 text-emerald-400" /> WhatsApp
      </div>
      <p className="text-xs text-neutral-400">
        Chat with Jesster from your phone while the app runs, on your own WhatsApp: Jesster joins it as a linked device.
        Press <b>Link a phone</b>, then on the phone open WhatsApp → <b>Settings</b> (on Android: ⋮) → <b>Linked devices</b> →{' '}
        <b>Link a device</b> and scan the code below. Then write to Jesster in your <b>Message yourself</b> chat. Nobody
        else is answered unless they send <code>/pair</code> and you approve them here; groups and your other chats are
        never read. This is not WhatsApp's own app, so WhatsApp may restrict an account that uses it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {!state?.running && (
          <button onClick={() => save({ enabled: true })} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs text-white">
            {state?.linked ? 'Connect' : 'Link a phone'}
          </button>
        )}
        {state?.running && (
          <button onClick={() => save({ enabled: false })} className="px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800">
            Disconnect
          </button>
        )}
        {state?.linked && (
          <button onClick={() => bridge.unlink().then(setState)} className="px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-300 hover:text-rose-300 hover:bg-neutral-800">
            Unlink this device
          </button>
        )}
      </div>
      {state?.qr && (
        <div className="space-y-1">
          <img src={state.qr} alt="WhatsApp link code: scan it in WhatsApp, Linked devices, Link a device" className="w-56 h-56 rounded-lg bg-white p-1 [image-rendering:pixelated]" />
          <div className="text-xs text-neutral-500">The code changes every few seconds; scan the one shown.</div>
        </div>
      )}
      <div className="text-xs text-neutral-400">
        {state?.connected ? (
          <span className="text-emerald-400">Linked as {state.bot}</span>
        ) : state?.error ? (
          <span className="text-amber-400">{state.error}</span>
        ) : state?.running ? (
          state.qr ? 'Waiting for the code to be scanned' : 'Connecting…'
        ) : (
          'Not running'
        )}
      </div>
      <label className="flex items-center gap-2 text-xs text-neutral-300">
        <input type="checkbox" checked={state?.selfChat ?? true} onChange={(e) => save({ selfChat: e.target.checked })} />
        Answer me in my own Message yourself chat
      </label>
      {state?.pending.length ? (
        <div className="space-y-1">
          <div className="text-xs text-neutral-300">Asked to pair:</div>
          {state.pending.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-xs">
              <span className="text-neutral-200">{p.name}</span>
              <span className="text-neutral-500">{p.number || p.id}</span>
              <button aria-label={`Approve ${p.name} on WhatsApp`} onClick={() => bridge.pair(p.id, true).then(setState)} className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 text-white">
                <Check className="w-3 h-3" /> Approve
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {state?.allowed.length ? (
        <div className="space-y-1">
          <div className="text-xs text-neutral-300">Approved chats:</div>
          {state.allowed.map((id) => (
            <div key={id} className="flex items-center gap-2 text-xs text-neutral-400">
              {id}
              <button aria-label={`Remove WhatsApp chat ${id}`} onClick={() => bridge.pair(id, false).then(setState)} className="p-0.5 rounded hover:text-rose-400">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {state?.connected && (
        <button
          onClick={() => bridge.test().then(() => setNote('Sent.'), (e) => setNote(String(e.message || e)))}
          className="px-2.5 py-1 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          Send a test message
        </button>
      )}
      {note && <p className="text-xs text-neutral-400">{note}</p>}
    </section>
  );
};
