import React from 'react';
import { OllamaConfig } from '../types/index.ts';
import { Plus, Brain, MessageSquare, Network, Zap, Cpu, Menu, Monitor } from 'lucide-react';

export type ActiveTab = 'notes' | 'ask' | 'graph';

interface HeaderProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenQuickCapture: () => void;
  onOpenOllamaModal: () => void;
  onOpenWindowsModal: () => void;
  onCreateNewNote: () => void;
  ollamaConfig: OllamaConfig;
  onToggleMobileMenu?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onSelectTab,
  onOpenQuickCapture,
  onOpenOllamaModal,
  onOpenWindowsModal,
  onCreateNewNote,
  ollamaConfig,
  onToggleMobileMenu,
}) => {
  return (
    <header className="h-14 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-md px-3 sm:px-6 flex items-center justify-between gap-2 shrink-0 z-20">
      {/* Zone 1: Brand Wordmark */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
        {onToggleMobileMenu && (
          <button
            onClick={onToggleMobileMenu}
            className="md:hidden p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors shrink-0"
            aria-label="Toggle navigation menu"
          >
            <Menu className="w-4 h-4" />
          </button>
        )}
        <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-neutral-900 border border-neutral-700 flex items-center justify-center text-white shrink-0">
          <Brain className="w-4 h-4 text-emerald-400" />
        </div>
        <span className="font-bold text-xs sm:text-sm tracking-tight text-white whitespace-nowrap">
          SecondBrain <span className="text-neutral-500 font-normal hidden lg:inline">Local</span>
        </span>
      </div>

      {/* Zone 2: Navigation Links / Tabs */}
      <nav className="flex items-center gap-1 text-xs font-medium text-neutral-400">
        <button
          onClick={() => onSelectTab('notes')}
          title="Notes Library"
          className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'notes'
              ? 'bg-neutral-800 text-white font-semibold'
              : 'hover:text-neutral-200 hover:bg-neutral-900'
          }`}
        >
          <Brain className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Notes</span>
        </button>

        <button
          onClick={() => onSelectTab('ask')}
          title="Ask Your Second Brain (Local Ollama)"
          className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'ask'
              ? 'bg-neutral-800 text-white font-semibold'
              : 'hover:text-neutral-200 hover:bg-neutral-900'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
          <span className="hidden md:inline">Ask Brain</span>
        </button>

        <button
          onClick={() => onSelectTab('graph')}
          title="Knowledge Graph Network"
          className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'graph'
              ? 'bg-neutral-800 text-white font-semibold'
              : 'hover:text-neutral-200 hover:bg-neutral-900'
          }`}
        >
          <Network className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Graph</span>
        </button>

        <button
          onClick={onOpenQuickCapture}
          className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900"
          title="Instant Quick Capture (Ctrl/Cmd+K)"
        >
          <Zap className="w-3.5 h-3.5 text-amber-400" />
          <span>Capture</span>
        </button>
      </nav>

      {/* Zone 3: Actions */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
        {/* Windows .exe Packaging Button */}
        <button
          onClick={onOpenWindowsModal}
          title="Package and Download Windows .exe Desktop App"
          className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-xs text-neutral-300 hover:text-white transition-colors shrink-0"
        >
          <Monitor className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="text-[11px] font-medium hidden sm:inline">Windows .exe</span>
        </button>

        {/* Ollama Status Button */}
        <button
          onClick={onOpenOllamaModal}
          aria-label="Configure local Ollama connection"
          className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-xs transition-colors shrink-0"
        >
          <Cpu className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
          <span
            className={`text-[11px] font-medium whitespace-nowrap ${
              ollamaConfig.isConnected
                ? 'text-emerald-400'
                : ollamaConfig.isSimulatedMode
                ? 'text-cyan-400'
                : 'text-amber-400'
            }`}
          >
            {ollamaConfig.isConnected
              ? 'Live'
              : ollamaConfig.isSimulatedMode
              ? 'Sim'
              : 'Ollama'}
          </span>
        </button>

        {/* Primary New Note CTA */}
        <button
          onClick={onCreateNewNote}
          aria-label="Create new note"
          className="flex items-center gap-1 px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-neutral-900 bg-white hover:bg-neutral-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden sm:inline">New Note</span>
        </button>
      </div>
    </header>
  );
};
