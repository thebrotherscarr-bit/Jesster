import React, { useState, useEffect, useMemo, useTransition } from 'react';
import { Note, NoteCategory, OllamaConfig } from './types/index.ts';
import { INITIAL_SEED_NOTES } from './data/seedNotes.ts';
import {
  filterNotes,
  sortNotes,
  calculateBrainStats,
  exportNotesToJson,
  parseNotesFromJson,
} from './utils/notes.ts';
import {
  checkOllamaConnection,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
} from './utils/ollama.ts';
import { Header, ActiveTab } from './components/Header.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { NotesList } from './components/NotesList.tsx';
import { NoteEditor } from './components/NoteEditor.tsx';
import { defaultTab } from './utils/tabs.ts';
import { OllamaSetupModal } from './components/OllamaSetupModal.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { IntegrationsModal } from './components/IntegrationsModal.tsx';
import { AgentView } from './components/AgentView.tsx';
import { HoldsDock } from './components/HoldsDock.tsx';
import { useVoiceSettings } from './voice/useVoice.ts';
import { useKernelSync } from './hooks/useKernelSync.ts';
import { useDesktopUpdate } from './hooks/useDesktopUpdate.ts';
import { useDesktopVault } from './hooks/useDesktopVault.ts';
import { rpc } from './utils/kernel.ts';

const STORAGE_KEY_NOTES = 'secondbrain_local_notes_v1';
const STORAGE_KEY_CONFIG = 'secondbrain_ollama_config_v1';

export default function App() {
  // Initialize notes from local storage or seed
  const [notes, setNotes] = useState<Note[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_NOTES);
      if (saved) {
        const parsed = parseNotesFromJson(saved);
        if (parsed && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.warn('Failed to load notes from localStorage:', e);
    }
    return INITIAL_SEED_NOTES;
  });

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(() => {
    return notes.length > 0 ? notes[0].id : null;
  });

  const [activeTab, setActiveTab] = useState<ActiveTab>(() => defaultTab(Boolean(window.secondbrainDesktop?.agent)));
  const [activeCategory, setActiveCategory] = useState<NoteCategory | 'all'>('all');
  const [activeTag, setActiveTag] = useState<string | 'all'>('all');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'created' | 'title' | 'words'>('updated');
  const [mobileNotesView, setMobileNotesView] = useState<'sidebar' | 'list' | 'editor'>('list');

  const [isOllamaModalOpen, setIsOllamaModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isIntegrationsOpen, setIsIntegrationsOpen] = useState(false);
  const [, startTransition] = useTransition();

  // Ollama Configuration State
  const [ollamaConfig, setOllamaConfig] = useState<OllamaConfig>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_CONFIG);
      if (saved) {
        const parsed = JSON.parse(saved) as OllamaConfig;
        // Connection state is a live fact, not a preference. Never trust the
        // previous session's "Live" badge until the probe answers.
        return { ...parsed, isConnected: false, lastPingMs: undefined };
      }
    } catch {}
    return {
      hostUrl: DEFAULT_OLLAMA_HOST,
      model: DEFAULT_OLLAMA_MODEL,
      isConnected: false,
      isSimulatedMode: false,
      availableModels: [DEFAULT_OLLAMA_MODEL],
    };
  });

  // Served by the Jesster notes kernel: the vault is the store and every save
  // lands on its provenance chain. Otherwise this stays in local mode.
  const [liveMessage, setLiveMessage] = useState<string | null>(null);
  const storage = useKernelSync(
    notes,
    setNotes,
    (from, to) => {
      setNotes((prev) => prev.map((n) => (n.id === from ? { ...n, id: to } : n)));
      setSelectedNoteId((cur) => (cur === from ? to : cur));
    },
    (cmd) => {
      // sent by another caller (the CLI, an agent, a collaborator on the bridge)
      if (cmd.action === 'open' && cmd.id) {
        setSelectedNoteId(cmd.id);
        setActiveTab('notes');
        setMobileNotesView('editor');
      } else if (cmd.action === 'message' && cmd.text) {
        setLiveMessage(cmd.text);
      }
    }
  );

  // the packaged .exe updates itself from GitHub releases
  const desktopUpdate = useDesktopUpdate((text) => setLiveMessage(text));

  // the desktop app keeps notes as Markdown files in a folder on disk
  const desktopVault = useDesktopVault(
    notes,
    setNotes,
    (from, to) => {
      setNotes((prev) => prev.map((n) => (n.id === from ? { ...n, id: to } : n)));
      setSelectedNoteId((cur) => (cur === from ? to : cur));
    },
    (text) => setLiveMessage(text)
  );
  const [dragging, setDragging] = useState(false);
  // voice settings; also transcribes Telegram voice notes while the app runs
  const [voice, setVoice] = useVoiceSettings();

  // a conversation started from outside (agent_send over MCP) brings the Agent tab forward
  useEffect(() => window.secondbrainDesktop?.agent?.onShow?.(() => setActiveTab('agent')), []);

  // tell the kernel what this window has open, so collaborators can see it
  useEffect(() => {
    if (storage.mode !== 'kernel') return;
    const open = notes.find((n) => n.id === selectedNoteId);
    rpc('live.report', {
      view: activeTab,
      ...(open ? { note: open.id, title: open.title } : {}),
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage.mode, selectedNoteId, activeTab]);

  // Save notes whenever they change (in kernel mode this is the offline copy)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_NOTES, exportNotesToJson(notes));
    } catch (e) {
      console.warn('Failed to persist notes to localStorage:', e);
    }
  }, [notes]);

  // Save config whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(ollamaConfig));
    } catch (e) {
      console.warn('Failed to persist config to localStorage:', e);
    }
  }, [ollamaConfig]);

  // Auto probe Ollama connection on mount, and keep retrying while offline.
  // Ollama can take 20+ seconds to become ready after a cold start, so a
  // single probe at launch would otherwise leave the app stuck in fallback
  // mode until the user manually clicked "Test Connection".
  useEffect(() => {
    let isMounted = true;
    let retryTimer: number | undefined;

    async function probe() {
      const res = await checkOllamaConnection(ollamaConfig.hostUrl);
      if (!isMounted) return;

      setOllamaConfig((prev) => ({
        ...prev,
        isConnected: res.isConnected,
        lastPingMs: res.pingMs,
        availableModels: res.models.length > 0 ? res.models : prev.availableModels,
      }));

      if (!res.isConnected) {
        retryTimer = window.setTimeout(probe, 10000);
      }
    }

    probe();
    return () => {
      isMounted = false;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [ollamaConfig.hostUrl]);

  // Compute filtered & sorted notes
  const displayedNotes = useMemo(() => {
    const filtered = filterNotes(notes, searchQuery, activeCategory, activeTag, pinnedOnly);
    return sortNotes(filtered, sortBy);
  }, [notes, searchQuery, activeCategory, activeTag, pinnedOnly, sortBy]);

  // Selected note object
  const activeNote = useMemo(() => {
    if (!selectedNoteId) return null;
    return notes.find((n) => n.id === selectedNoteId) || null;
  }, [notes, selectedNoteId]);

  // Aggregate brain stats
  const stats = useMemo(() => calculateBrainStats(notes), [notes]);

  // Distinct tags list
  const allTags = useMemo(() => {
    const set = new Set<string>();
    notes.forEach((n) => n.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [notes]);

  // Actions (a new note is Steward's to write: the operator, 2026-11-04, "steward is the note taker")
  const handleUpdateNote = (updatedFields: Partial<Note>) => {
    if (!selectedNoteId) return;
    setNotes((prev) =>
      prev.map((n) => (n.id === selectedNoteId ? { ...n, ...updatedFields } : n))
    );
  };

  const handleDeleteNote = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setNotes((prev) => {
      const remaining = prev.filter((n) => n.id !== id);
      if (selectedNoteId === id) {
        setSelectedNoteId(remaining.length > 0 ? remaining[0].id : null);
      }
      return remaining;
    });
  };

  const handleTogglePin = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setNotes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isPinned: !n.isPinned, updatedAt: Date.now() } : n))
    );
  };

  const handleExportNotes = () => {
    const jsonString = exportNotesToJson(notes);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `secondbrain-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImportNotes = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const parsed = parseNotesFromJson(content);
      if (parsed && parsed.length > 0) {
        startTransition(() => {
          setNotes(parsed);
          setSelectedNoteId(parsed[0].id);
        });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleResetSeedNotes = () => {
    if (window.confirm('Reset all notes to starter Second Brain setup? Current notes will be replaced.')) {
      startTransition(() => {
        setNotes(INITIAL_SEED_NOTES);
        setSelectedNoteId(INITIAL_SEED_NOTES[0].id);
      });
    }
  };

  return (
    <div
      className="h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans selection:bg-neutral-800"
      onDragOver={(e) => {
        if (!desktopVault || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!desktopVault || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        desktopVault.importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center bg-emerald-950/70 border-4 border-dashed border-emerald-500 text-emerald-100 text-lg font-semibold">
          Drop to import as notes
        </div>
      )}
      {/* the top bar: the app's own navigation; Steward's controls are on the Agent tab's console */}
      <Header
        activeTab={activeTab}
        onSelectTab={(tab) => {
          setActiveTab(tab);
          if (tab === 'notes') setMobileNotesView('list');
        }}
        onOpenOllamaModal={window.secondbrainDesktop?.agent ? undefined : () => setIsOllamaModalOpen(true)}
        ollamaConfig={ollamaConfig}
        storage={storage}
        onOpenSettings={window.secondbrainDesktop?.settings ? () => setIsSettingsOpen(true) : undefined}
        desktopUpdate={desktopUpdate}
        onToggleMobileMenu={() => setMobileNotesView((prev) => (prev === 'sidebar' ? 'list' : 'sidebar'))}
      />

      {liveMessage && (
        <div
          role="status"
          className="flex items-start gap-3 px-4 sm:px-6 py-2 border-b border-emerald-900 bg-emerald-950/60 text-sm text-emerald-100"
        >
          <span className="flex-1 whitespace-pre-wrap break-words">{liveMessage}</span>
          <button
            onClick={() => setLiveMessage(null)}
            className="text-emerald-300 hover:text-white text-xs shrink-0"
            aria-label="Dismiss message"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Workspace */}
      <main className="flex-1 min-h-0 flex overflow-hidden">
        {activeTab === 'notes' && (
          <>
            <Sidebar
              activeCategory={activeCategory}
              onSelectCategory={(cat) => {
                setActiveCategory(cat);
                setMobileNotesView('list');
              }}
              activeTag={activeTag}
              onSelectTag={(tag) => {
                setActiveTag(tag);
                setMobileNotesView('list');
              }}
              pinnedOnly={pinnedOnly}
              onTogglePinnedOnly={() => setPinnedOnly((p) => !p)}
              allTags={allTags}
              stats={stats}
              onExportNotes={handleExportNotes}
              onImportNotes={handleImportNotes}
              onResetSeedNotes={handleResetSeedNotes}
              className={mobileNotesView === 'sidebar' ? 'flex' : 'hidden md:flex'}
            />

            <NotesList
              notes={displayedNotes}
              selectedNoteId={selectedNoteId}
              onSelectNote={(id) => {
                setSelectedNoteId(id);
                setMobileNotesView('editor');
              }}
              onTogglePin={handleTogglePin}
              onDeleteNote={handleDeleteNote}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              sortBy={sortBy}
              onSortChange={setSortBy}
              className={mobileNotesView === 'list' ? 'flex' : 'hidden md:flex'}
            />

            <NoteEditor
              note={activeNote}
              onUpdateNote={handleUpdateNote}
              ollamaConfig={ollamaConfig}
              onOpenOllamaSetup={() => setIsOllamaModalOpen(true)}
              onBackToNotes={() => setMobileNotesView('list')}
              className={mobileNotesView === 'editor' ? 'flex' : 'hidden md:flex'}
            />
          </>
        )}

        {/* kept mounted so a conversation survives switching tabs */}
        {window.secondbrainDesktop?.agent && (
          <div className={activeTab === 'agent' ? 'flex flex-1 min-w-0 min-h-0' : 'hidden'}>
            <AgentView
              ollamaConfig={ollamaConfig}
              voice={voice}
              onOpenNote={(id) => {
                setSelectedNoteId(id);
                setActiveTab('notes');
              }}
              onOpenOllama={() => setIsOllamaModalOpen(true)}
              onOpenIntegrations={window.secondbrainDesktop?.integrations ? () => setIsIntegrationsOpen(true) : undefined}
            />
          </div>
        )}
      </main>

      {/* SecondBrain's own cards, on every page (the Atlas glass shows Atlas's) */}
      <HoldsDock />

      {/* Modals */}
      <OllamaSetupModal
        isOpen={isOllamaModalOpen}
        onClose={() => setIsOllamaModalOpen(false)}
        config={ollamaConfig}
        onUpdateConfig={(updates) => setOllamaConfig((prev) => ({ ...prev, ...updates }))}
      />

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      {/* opened from the console's Servers shelf */}
      <IntegrationsModal
        isOpen={isIntegrationsOpen}
        onClose={() => setIsIntegrationsOpen(false)}
        voice={window.secondbrainDesktop ? voice : undefined}
        onVoiceChange={setVoice}
      />
    </div>
  );
}
