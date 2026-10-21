export type NoteCategory = 'projects' | 'areas' | 'resources' | 'archives' | 'inbox';

export interface Note {
  id: string;
  title: string;
  content: string;
  category: NoteCategory;
  tags: string[];
  isPinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OllamaConfig {
  hostUrl: string;
  model: string;
  isConnected: boolean;
  isSimulatedMode: boolean;
  lastPingMs?: number;
  availableModels: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  sourceNoteIds?: string[];
}

export interface BrainStats {
  totalNotes: number;
  totalWords: number;
  totalTags: number;
  projectsCount: number;
  areasCount: number;
  resourcesCount: number;
  archivesCount: number;
  inboxCount: number;
}
