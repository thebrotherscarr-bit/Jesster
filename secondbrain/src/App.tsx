import { useState, useEffect, useMemo } from 'react';
import { Note, OllamaConfig } from './types/index.ts';
import { INITIAL_SEED_NOTES } from './data/seedNotes.ts';
import { exportNotesToJson } from './utils/notes.ts';
import { ShelfFilter, askAboutNote, initialNotes, notesShown, removeNoteConfirmed, shelfCounts } from './utils/notesView.ts';
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
import { SettingsModal } from './components/SettingsModal.tsx';
import { AgentView } from './components/AgentView.tsx';
import { PhoneView } from './components/PhoneView.tsx';
import { FlowsShelf } from './components/FlowsShelf.tsx';
import '@xyflow/react/dist/style.css';
import { HoldsDock } from './components/HoldsDock.tsx';
import { useVoiceSettings } from './voice/useVoice.ts';
import { useKernelSync } from './hooks/useKernelSync.ts';
import { useDesktopUpdate } from './hooks/useDesktopUpdate.ts';
import { useDesktopVault } from './hooks/useDesktopVault.ts';
import { rpc } from './utils/kernel.ts';

const STORAGE_KEY_NOTES = 'secondbrain_local_notes_v1';
const STORAGE_KEY_CONFIG = 'secondbrain_ollama_config_v1';

export default function App() {
  // what this window kept last time; with a vault present nothing else (the vault loads its own), and the
  // starter notes only in a browser with no vault
  const [notes, setNotes] = useState<Note[]>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY_NOTES);
    } catch (e) {
      console.warn('Failed to load notes from localStorage:', e);
    }
    return initialNotes(saved, Boolean(window.secondbrainDesktop?.vault), INITIAL_SEED_NOTES);
  });

  // no note is open until one is picked; where the window is narrow, an open note takes the place of the list
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>(() => defaultTab(Boolean(window.secondbrainDesktop?.agent)));
  const [shelf, setShelf] = useState<ShelfFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  // "Ask Steward about this note" fills the Agent tab's message box (n makes a second ask of the same note land)
  const [agentDraft, setAgentDraft] = useState<{ text: string; n: number } | undefined>();

  // the one Settings window: Ollama, integrations and voice are its sections (utils/settingsMap.ts)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

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

  // the list: one shelf (or all), narrowed by the search, newest first
  const displayedNotes = useMemo(() => notesShown(notes, searchQuery, shelf), [notes, searchQuery, shelf]);
  const shelves = useMemo(() => shelfCounts(notes), [notes]);

  // Selected note object
  const activeNote = useMemo(() => {
    if (!selectedNoteId) return null;
    return notes.find((n) => n.id === selectedNoteId) || null;
  }, [notes, selectedNoteId]);

  // Actions (a new note is Steward's to write: the operator, 2026-11-04, "steward is the note taker")
  const handleUpdateNote = (updatedFields: Partial<Note>) => {
    if (!selectedNoteId) return;
    setNotes((prev) =>
      prev.map((n) => (n.id === selectedNoteId ? { ...n, ...updatedFields } : n))
    );
  };

  // a delete asks first; in the desktop app the file goes to the vault's .trash folder
  const handleDeleteNote = (id: string) => {
    const remaining = removeNoteConfirmed(notes, id, (message) => window.confirm(message));
    if (!remaining) return;
    setNotes(remaining);
    if (selectedNoteId === id) setSelectedNoteId(null);
  };

  const agentPresent = Boolean(window.secondbrainDesktop?.agent);
  const handleAskSteward = (note: Note) => {
    setAgentDraft((prev) => ({ text: askAboutNote(note), n: (prev?.n || 0) + 1 }));
    setActiveTab('agent');
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
        onSelectTab={setActiveTab}
        onOpenOllamaModal={window.secondbrainDesktop?.agent ? undefined : () => setIsSettingsOpen(true)}
        ollamaConfig={ollamaConfig}
        storage={storage}
        onOpenSettings={window.secondbrainDesktop?.settings ? () => setIsSettingsOpen(true) : undefined}
        desktopUpdate={desktopUpdate}
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
            <Sidebar shelves={shelves} active={shelf} onSelect={setShelf} />

            <NotesList
              notes={displayedNotes}
              selectedNoteId={selectedNoteId}
              onSelectNote={setSelectedNoteId}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              shelves={shelves}
              shelf={shelf}
              onSelectShelf={setShelf}
              className={activeNote ? 'hidden md:flex' : 'flex'}
            />

            <NoteEditor
              note={activeNote}
              onUpdateNote={handleUpdateNote}
              onDeleteNote={handleDeleteNote}
              onAskSteward={agentPresent ? handleAskSteward : undefined}
              onBack={() => setSelectedNoteId(null)}
              className={activeNote ? 'flex' : 'hidden md:flex'}
            />
          </>
        )}

        {/* kept mounted so a conversation survives switching tabs */}
        {window.secondbrainDesktop?.agent && (
          <div className={activeTab === 'agent' ? 'flex flex-1 min-w-0 min-h-0' : 'hidden'}>
            <AgentView
              ollamaConfig={ollamaConfig}
              voice={voice}
              draft={agentDraft}
              onOpenNote={(id) => {
                setSelectedNoteId(id);
                setActiveTab('notes');
              }}
              onVoiceChange={setVoice}
            />
          </div>
        )}

        {/* the phone's conversations with Steward; kept mounted so it follows them live */}
        {window.secondbrainDesktop?.phone && (
          <div className={activeTab === 'phone' ? 'flex flex-1 min-w-0 min-h-0' : 'hidden'}>
            <PhoneView voice={voice} onVoiceChange={setVoice} />
          </div>
        )}

        {/* the Flows shelf: the automations as block cards, Run now, and their Set up */}
        {window.secondbrainDesktop?.schedules && activeTab === 'flows' && (
          <div className="flex flex-1 min-w-0 min-h-0">
            <FlowsShelf active />
          </div>
        )}
      </main>

      {/* SecondBrain's own cards, on every page (the Atlas glass shows Atlas's) */}
      <HoldsDock />

      {/* the one Settings window, every section flat */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        ollamaConfig={ollamaConfig}
        onUpdateOllama={(updates) => setOllamaConfig((prev) => ({ ...prev, ...updates }))}
        voice={window.secondbrainDesktop ? voice : undefined}
        onVoiceChange={setVoice}
      />
    </div>
  );
}
