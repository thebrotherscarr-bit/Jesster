import React, { useEffect, useState } from 'react';
import { X, Inbox, RefreshCw, FolderGit2, Unplug } from 'lucide-react';
import { InboxStatus } from '../types/desktop.ts';
import { ReportBack } from './settings/ReportBack.tsx';
import { OllamaSection } from './settings/OllamaSection.tsx';
import { IntegrationsSection } from './settings/IntegrationsSection.tsx';
import { VoiceSection } from './settings/VoiceSection.tsx';
import { OllamaConfig } from '../types/index.ts';
import { VoiceSettings } from '../voice/useVoice.ts';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  ollamaConfig: OllamaConfig;
  onUpdateOllama: (c: Partial<OllamaConfig>) => void;
  voice?: VoiceSettings;
  onVoiceChange?: (v: Partial<VoiceSettings>) => void;
}

/**
 * The app's one Settings window, every section on it flat (the operator, 2026-11-04: "no buried settings that are
 * nested"): the notes folder, the inbox, Ollama, integrations and voice (the archive digger was retired 2026-11-05, ADR-0010). Steward's own settings
 * (Aurora sharing, his tools, MCP servers) are on the Agent tab's console, the automations on the Flows shelf's Set up,
 * Telegram on the Phone view;
 * utils/settingsMap.ts lists where each one is.
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, ollamaConfig, onUpdateOllama, voice, onVoiceChange }) => {
  const bridge = window.secondbrainDesktop;
  const [inbox, setInbox] = useState<InboxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [vaultDir, setVaultDir] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !bridge?.inbox) return;
    bridge.inbox.status().then(setInbox);
    bridge.vault?.info().then((v) => setVaultDir(v.dir)).catch(() => {});
    return bridge.inbox.onStatus(setInbox);
  }, [isOpen, bridge]);

  if (!isOpen) return null;

  const run = async (fn: () => Promise<InboxStatus>) => {
    setBusy(true);
    try {
      setInbox(await fn());
    } catch (e) {
      setInbox((s) => (s ? { ...s, error: e instanceof Error ? e.message : String(e) } : s));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Settings"
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800 sticky top-0 bg-neutral-950">
          <h2 className="text-sm font-semibold text-white">Settings</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800" aria-label="Close settings">
            <X className="w-4 h-4" />
          </button>
        </div>

        {vaultDir && (
          <section className="px-5 py-4 border-b border-neutral-900 space-y-2" aria-label="Notes folder">
            <div className="text-white text-sm font-medium">Notes folder</div>
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <span className="flex-1 min-w-0 break-all text-neutral-300">{vaultDir}</span>
              <button onClick={() => bridge?.vault?.reveal()} className="px-2.5 py-1 rounded-lg border border-neutral-700 text-neutral-200 hover:bg-neutral-800 shrink-0">Open folder</button>
            </div>
          </section>
        )}

        <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Inbox from Claude">
          <div className="flex items-center gap-2 text-white text-sm font-medium">
            <Inbox className="w-4 h-4 text-emerald-400" /> Inbox from Claude
          </div>
          <p className="text-xs text-neutral-400">
            Notes left in your <code>secondbrain-bridge</code> repository's <code>inbox</code> folder are filed here every few minutes.
          </p>
          {!bridge?.inbox ? (
            <p className="text-xs text-neutral-500">Available in the desktop app.</p>
          ) : inbox?.clone ? (
            <>
              <div className="text-xs text-neutral-300 break-all">
                Clone: <span className="text-neutral-400">{inbox.clone}</span>
              </div>
              <div className="text-xs text-neutral-400">
                {inbox.running
                  ? 'Syncing…'
                  : inbox.error
                    ? <span className="text-amber-400">Last sync failed: {inbox.error}</span>
                    : inbox.last
                      ? `Last sync ${new Date(inbox.last.at).toLocaleTimeString()}: ${inbox.last.filed.length ? `filed ${inbox.last.filed.map((f) => f.title).join(', ')}` : 'nothing new'}${inbox.last.pulled && inbox.last.pulled !== 'ok' ? ` (git: ${inbox.last.pulled})` : ''}`
                      : 'Not synced yet.'}
              </div>
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => run(() => bridge.inbox!.sync())}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-700 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Sync now
                </button>
                <button
                  disabled={busy}
                  onClick={() => run(() => bridge.inbox!.disconnect())}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-800 text-xs text-neutral-400 hover:text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  <Unplug className="w-3.5 h-3.5" /> Disconnect
                </button>
              </div>
              <ReportBack />
            </>
          ) : (
            <button
              disabled={busy}
              onClick={() => run(() => bridge.inbox!.connect())}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs text-white disabled:opacity-50"
            >
              <FolderGit2 className="w-3.5 h-3.5" /> {busy ? 'Connecting…' : 'Connect inbox (choose where to keep the clone)'}
            </button>
          )}
        </section>

        <OllamaSection config={ollamaConfig} onUpdateConfig={onUpdateOllama} />
        <IntegrationsSection />
        {voice && onVoiceChange && <VoiceSection voice={voice} onChange={onVoiceChange} />}
      </div>
    </div>
  );
};
