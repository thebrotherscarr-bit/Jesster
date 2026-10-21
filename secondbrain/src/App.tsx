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
import { AskBrainView } from './components/AskBrainView.tsx';
import { GraphView } from './components/GraphView.tsx';
import { OllamaSetupModal } from './components/OllamaSetupModal.tsx';
import { QuickCaptureModal } from './components/QuickCaptureModal.tsx';
import { WindowsPublishModal } from './components/WindowsPublishModal.tsx';
import { useKernelSync } from './hooks/useKernelSync.ts';

const STORAGE_KEY_NOTES = 'secondbrain_local_notes_v1';
const STORAGE_KEY_CONFIG = 'secondbrain_ollama_config_v1';

function createNoteId(prefix = 'note'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

  const [activeTab, setActiveTab] = useState<ActiveTab>('notes');
  const [activeCategory, setActiveCategory] = useState<NoteCategory | 'all'>('all');
  const [activeTag, setActiveTag] = useState<string | 'all'>('all');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'created' | 'title' | 'words'>('updated');
  const [mobileNotesView, setMobileNotesView] = useState<'sidebar' | 'list' | 'editor'>('list');

  const [isOllamaModalOpen, setIsOllamaModalOpen] = useState(false);
  const [isWindowsModalOpen, setIsWindowsModalOpen] = useState(false);
  const [isQuickCaptureOpen, setIsQuickCaptureOpen] = useState(false);
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
  const storage = useKernelSync(notes, setNotes, (from, to) => {
    setNotes((prev) => prev.map((n) => (n.id === from ? { ...n, id: to } : n)));
    setSelectedNoteId((cur) => (cur === from ? to : cur));
  });

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

  // Keyboard shortcut listener (Cmd+K / Ctrl+K for quick capture)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsQuickCaptureOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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

  // Actions
  const handleCreateNewNote = () => {
    const newNote: Note = {
      id: createNoteId(),
      title: 'Untitled Note',
      content: '',
      category: activeCategory !== 'all' ? activeCategory : 'inbox',
      tags: activeTag !== 'all' ? [activeTag] : [],
      isPinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    startTransition(() => {
      setNotes((prev) => [newNote, ...prev]);
      setSelectedNoteId(newNote.id);
      setActiveTab('notes');
    });
  };

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

  const handleQuickCaptureSave = (
    title: string,
    content: string,
    category: NoteCategory,
    tags: string[]
  ) => {
    const newNote: Note = {
      id: createNoteId(),
      title: title || 'Quick Note',
      content,
      category,
      tags,
      isPinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    startTransition(() => {
      setNotes((prev) => [newNote, ...prev]);
      setSelectedNoteId(newNote.id);
      setActiveTab('notes');
    });
  };

  const handleCreateNoteFromSynthesis = (title: string, content: string) => {
    const newNote: Note = {
      id: createNoteId('note-synthesis'),
      title,
      content,
      category: 'resources',
      tags: ['synthesis', 'gpt-oss'],
      isPinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    startTransition(() => {
      setNotes((prev) => [newNote, ...prev]);
      setSelectedNoteId(newNote.id);
      setActiveTab('notes');
    });
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
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans selection:bg-neutral-800">
      {/* 3-Zone Top Bar */}
      <Header
        activeTab={activeTab}
        onSelectTab={(tab) => {
          setActiveTab(tab);
          if (tab === 'notes') setMobileNotesView('list');
        }}
        onOpenQuickCapture={() => setIsQuickCaptureOpen(true)}
        onOpenOllamaModal={() => setIsOllamaModalOpen(true)}
        onOpenWindowsModal={() => setIsWindowsModalOpen(true)}
        onCreateNewNote={() => {
          handleCreateNewNote();
          setMobileNotesView('editor');
        }}
        ollamaConfig={ollamaConfig}
        storage={storage}
        onToggleMobileMenu={() => setMobileNotesView((prev) => (prev === 'sidebar' ? 'list' : 'sidebar'))}
      />

      {/* Main Workspace */}
      <main className="flex-1 flex overflow-hidden">
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
              onCreateNote={() => {
                handleCreateNewNote();
                setMobileNotesView('editor');
              }}
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

        {activeTab === 'ask' && (
          <AskBrainView
            notes={notes}
            ollamaConfig={ollamaConfig}
            onOpenNote={(id) => {
              setSelectedNoteId(id);
              setActiveTab('notes');
            }}
            onCreateNoteFromSynthesis={handleCreateNoteFromSynthesis}
            onOpenOllamaSetup={() => setIsOllamaModalOpen(true)}
          />
        )}

        {activeTab === 'graph' && (
          <GraphView
            notes={notes}
            onSelectNote={(id) => {
              setSelectedNoteId(id);
              setActiveTab('notes');
            }}
          />
        )}
      </main>

      {/* Modals */}
      <OllamaSetupModal
        isOpen={isOllamaModalOpen}
        onClose={() => setIsOllamaModalOpen(false)}
        config={ollamaConfig}
        onUpdateConfig={(updates) => setOllamaConfig((prev) => ({ ...prev, ...updates }))}
      />

      <QuickCaptureModal
        isOpen={isQuickCaptureOpen}
        onClose={() => setIsQuickCaptureOpen(false)}
        onSave={handleQuickCaptureSave}
      />

      <WindowsPublishModal
        isOpen={isWindowsModalOpen}
        onClose={() => setIsWindowsModalOpen(false)}
        appUrl={typeof window !== 'undefined' ? window.location.origin : ''}
      />
    </div>
  );
}
