import React, { useEffect, useState } from 'react';
import { OllamaConfig } from '../types/index.ts';
import { KernelSync } from '../hooks/useKernelSync.ts';
import { DesktopUpdate } from '../hooks/useDesktopUpdate.ts';
import { AtlasButton } from './AtlasButton.tsx';
import { Brain, Cpu, Link2, Download, Settings as SettingsIcon, Bot, Smartphone } from 'lucide-react';

export type ActiveTab = 'notes' | 'agent' | 'phone';

interface HeaderProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  /** the Ollama connection: up here only where there is no Agent tab, whose console carries it (the web build) */
  onOpenOllamaModal?: () => void;
  ollamaConfig: OllamaConfig;
  storage?: KernelSync;
  desktopUpdate?: DesktopUpdate | null;
  onOpenSettings?: () => void;
}

/** Where notes are kept: the Jesster vault (with its chain) or this browser. */
const StorageBadge: React.FC<{ storage?: KernelSync }> = ({ storage }) => {
  if (!storage || storage.mode === 'detecting') return null;
  const { mode, chain, error } = storage;
  const label =
    mode === 'kernel'
      ? chain
        ? chain.intact
          ? `Vault · ${chain.links} links`
          : 'Chain broken'
        : 'Vault'
      : mode === 'error'
        ? 'Vault unreachable'
        : 'Browser only';
  const tone =
    mode === 'kernel' && (!chain || chain.intact)
      ? 'border-emerald-800 text-emerald-400'
      : mode === 'local'
        ? 'border-neutral-700 text-neutral-400'
        : 'border-amber-700 text-amber-400';
  const title =
    error ||
    (mode === 'kernel'
      ? `Notes are saved to the Jesster vault. ${chain ? `${chain.detail}; head ${chain.head.slice(0, 16)}…` : ''}`
      : mode === 'local'
        ? 'Notes are kept in this browser only. Serve with `python notes/cli.py serve` to use the vault.'
        : 'Saves will retry.');
  return (
    <span
      title={title}
      className={`hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] whitespace-nowrap ${tone}`}
    >
      <Link2 className="w-3 h-3" />
      {label}
    </span>
  );
};

/**
 * The top bar: the app's own navigation and nothing else (the operator, 2026-11-04: "there is a lot of clutter in the
 * top bar"). Every button here is marked data-topbar and utils/agentConsole.ts TOP_BAR lists them; Steward's controls
 * (his status, the servers, approvals, Ollama, integrations) are on the Agent tab's console.
 */
export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onSelectTab,
  onOpenOllamaModal,
  ollamaConfig,
  storage,
  desktopUpdate,
  onOpenSettings,
}) => {
  // the Agent tab names Steward when he is the agent (Settings: agent.backend), else it is the local loop
  const [backend, setBackend] = useState('');
  useEffect(() => {
    window.secondbrainDesktop?.settings
      ?.get()
      .then((s) => setBackend(String(s.agent?.backend || '')))
      .catch(() => {});
  }, []);
  const agentLabel = backend === 'steward' ? 'Agent: Steward' : 'Agent';
  const tab = (on: boolean) =>
    `flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 ${on ? 'bg-neutral-800 text-white font-semibold' : 'hover:text-neutral-200 hover:bg-neutral-900'}`;
  return (
    <header className="h-14 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-md px-3 sm:px-6 flex items-center justify-between gap-2 shrink-0 z-20">
      {/* the wordmark */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
        <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-neutral-900 border border-neutral-700 flex items-center justify-center text-white shrink-0">
          <Brain className="w-4 h-4 text-emerald-400" />
        </div>
        <span className="font-bold text-xs sm:text-sm tracking-tight text-white whitespace-nowrap">
          Jesster <span className="text-neutral-500 font-normal hidden lg:inline">Local</span>
          {desktopUpdate?.current ? (
            <span className="ml-1.5 text-[10px] font-normal text-neutral-500" title={`Desktop app build ${desktopUpdate.current}${desktopUpdate.commit ? ` (commit ${desktopUpdate.commit})` : ''}. Updates log to %TEMP%\\secondbrain-update.log`}>
              build {desktopUpdate.current}
            </span>
          ) : null}
        </span>
      </div>

      {/* where you are: the tabs, and Aurora beside them */}
      <nav className="flex items-center gap-1 text-xs font-medium text-neutral-400 min-w-0">
        <button data-topbar="Notes" onClick={() => onSelectTab('notes')} title="Notes" className={tab(activeTab === 'notes')}>
          <Brain className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Notes</span>
        </button>

        {window.secondbrainDesktop?.agent && (
          <button
            data-topbar="Agent"
            onClick={() => onSelectTab('agent')}
            title={backend === 'steward' ? 'Agent: Steward, and his console' : 'Agent: a model that uses tools on your notes and the web'}
            className={tab(activeTab === 'agent')}
          >
            <Bot className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{agentLabel}</span>
          </button>
        )}

        {/* the phone's conversations with Steward (Telegram today), beside the PC's Agent tab */}
        {window.secondbrainDesktop?.phone && (
          <button data-topbar="Phone" onClick={() => onSelectTab('phone')} title="Phone: your conversations with Steward from the phone" className={tab(activeTab === 'phone')}>
            <Smartphone className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Phone</span>
          </button>
        )}

        <AtlasButton />
      </nav>

      {/* the app itself: where notes are kept, updates and Settings */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
        <StorageBadge storage={storage} />
        {onOpenOllamaModal && (
          <button
            data-topbar="Ollama (web only)"
            onClick={onOpenOllamaModal}
            aria-label="Configure local Ollama connection"
            className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-xs transition-colors shrink-0"
          >
            <Cpu className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
            <span className={`text-[11px] font-medium whitespace-nowrap ${ollamaConfig.isConnected ? 'text-emerald-400' : ollamaConfig.isSimulatedMode ? 'text-cyan-400' : 'text-amber-400'}`}>
              {ollamaConfig.isConnected ? 'Live' : ollamaConfig.isSimulatedMode ? 'Sim' : 'Ollama'}
            </span>
          </button>
        )}
        {desktopUpdate?.available && (
          <button
            data-topbar="Update"
            onClick={() => desktopUpdate.apply()}
            disabled={desktopUpdate.updating}
            title={desktopUpdate.error || `Build ${desktopUpdate.latest} is out (you have ${desktopUpdate.current}): ${desktopUpdate.title}. The app restarts on the new build; notes are kept.`}
            className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg border border-sky-800 bg-sky-950/60 hover:bg-sky-900 text-xs text-sky-300 hover:text-white transition-colors shrink-0 disabled:opacity-60"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{desktopUpdate.updating ? 'Updating…' : 'Update'}</span>
          </button>
        )}
        {storage?.version && storage.version.behind > 0 && storage.update && (
          <button
            data-topbar="Update notes kernel"
            onClick={() => storage.update?.()}
            disabled={storage.updating}
            title={`Notes kernel: ${storage.version.behind} new commit(s) on ${storage.version.branch}: ${storage.version.latest}`}
            className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg border border-sky-800 bg-sky-950/60 hover:bg-sky-900 text-xs text-sky-300 hover:text-white transition-colors shrink-0 disabled:opacity-60"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{storage.updating ? 'Updating…' : 'Update'}</span>
          </button>
        )}
        {onOpenSettings && (
          <button
            data-topbar="Settings"
            onClick={onOpenSettings}
            title="Settings: notes folder, inbox, archive"
            aria-label="Settings"
            className="p-1.5 rounded-lg border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 hover:text-white transition-colors shrink-0"
          >
            <SettingsIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </header>
  );
};
