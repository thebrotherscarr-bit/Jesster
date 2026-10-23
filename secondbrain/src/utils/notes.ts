import { Note, NoteCategory, BrainStats } from '../types/index.ts';
import { SHELF_IDS, shelfOf } from './shelves.ts';

/**
 * Filter notes by search text, category, and active tag
 */
export function filterNotes(
  notes: Note[],
  query: string,
  categoryFilter: NoteCategory | 'all' = 'all',
  tagFilter: string | 'all' = 'all',
  pinnedOnly: boolean = false
): Note[] {
  const cleanQuery = query.trim().toLowerCase();

  return notes.filter((note) => {
    if (pinnedOnly && !note.isPinned) {
      return false;
    }

    if (categoryFilter !== 'all' && note.category !== categoryFilter) {
      return false;
    }

    if (tagFilter !== 'all' && !note.tags.includes(tagFilter)) {
      return false;
    }

    if (!cleanQuery) {
      return true;
    }

    const titleMatch = note.title.toLowerCase().includes(cleanQuery);
    const contentMatch = note.content.toLowerCase().includes(cleanQuery);
    const tagMatch = note.tags.some((t) => t.toLowerCase().includes(cleanQuery));

    return titleMatch || contentMatch || tagMatch;
  });
}

/**
 * Sort notes by selected criteria
 */
export function sortNotes(
  notes: Note[],
  sortBy: 'updated' | 'created' | 'title' | 'words' = 'updated'
): Note[] {
  return [...notes].sort((a, b) => {
    // Pinned notes always surface to top unless sorting alphabetically
    if (a.isPinned !== b.isPinned && sortBy !== 'title') {
      return a.isPinned ? -1 : 1;
    }

    switch (sortBy) {
      case 'created':
        return b.createdAt - a.createdAt;
      case 'title':
        return a.title.localeCompare(b.title);
      case 'words': {
        const countA = calculateNoteStats(a.content).words;
        const countB = calculateNoteStats(b.content).words;
        return countB - countA;
      }
      case 'updated':
      default:
        return b.updatedAt - a.updatedAt;
    }
  });
}

/**
 * Word count, character count, and estimated reading time
 */
export function calculateNoteStats(content: string): {
  words: number;
  chars: number;
  readingTimeMinutes: number;
} {
  const trimmed = content.trim();
  if (!trimmed) {
    return { words: 0, chars: 0, readingTimeMinutes: 0 };
  }
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const chars = content.length;
  const readingTimeMinutes = Math.max(1, Math.ceil(words / 200));
  return { words, chars, readingTimeMinutes };
}

/**
 * Automatically scan text for hashtags like #secondbrain, #idea, #ollama
 */
export function extractTagsFromText(text: string): string[] {
  const regex = /#([a-zA-Z0-9_\-]+)/g;
  const matches = text.match(regex);
  if (!matches) return [];
  const uniqueTags = new Set(matches.map((m) => m.slice(1).toLowerCase()));
  return Array.from(uniqueTags);
}

/**
 * Calculate aggregate statistics for the second brain
 */
export function calculateBrainStats(notes: Note[]): BrainStats {
  let totalWords = 0;
  const allTags = new Set<string>();

  const shelves = Object.fromEntries(SHELF_IDS.map((id) => [id, 0])) as Record<NoteCategory, number>;

  for (const note of notes) {
    totalWords += calculateNoteStats(note.content).words;
    for (const tag of note.tags) {
      allTags.add(tag);
    }
    shelves[shelfOf(note.category, note.tags)]++;
  }

  return {
    totalNotes: notes.length,
    totalWords,
    totalTags: allTags.size,
    shelves,
  };
}

/**
 * Build RAG context from notes by ranking relevance to query
 */
export function buildNotesContextForRag(
  notes: Note[],
  query: string,
  maxNotes: number = 4
): { contextText: string; relevantNoteIds: string[] } {
  if (notes.length === 0) {
    return { contextText: 'No notes available.', relevantNoteIds: [] };
  }

  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\w]/g, ''))
    .filter((w) => w.length > 2);

  // Score each note
  const scored = notes.map((note) => {
    let score = 0;
    const titleLower = note.title.toLowerCase();
    const contentLower = note.content.toLowerCase();

    for (const term of queryTerms) {
      if (titleLower.includes(term)) score += 5;
      if (note.tags.some((t) => t.toLowerCase().includes(term))) score += 4;
      if (contentLower.includes(term)) score += 1;
    }

    // Boost pinned notes slightly
    if (note.isPinned) score += 0.5;

    return { note, score };
  });

  // If no terms matched, take the most recently updated notes
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.note.updatedAt - a.note.updatedAt;
  });

  const selected = scored.slice(0, maxNotes);
  const relevantNoteIds = selected.map((s) => s.note.id);

  const contextText = selected
    .map(
      (s, idx) =>
        `### Note [${idx + 1}]: "${s.note.title}" (Category: ${s.note.category.toUpperCase()}${
          s.note.tags.length ? `, Tags: ${s.note.tags.join(', ')}` : ''
        })\nID: ${s.note.id}\nContent:\n${s.note.content.slice(0, 1500)}`
    )
    .join('\n\n---\n\n');

  return { contextText, relevantNoteIds };
}

/**
 * Export and import helpers
 */
export function exportNotesToJson(notes: Note[]): string {
  return JSON.stringify(notes, null, 2);
}



function normalizeImportedNote(item: unknown): Note | null {
  if (!item || typeof item !== 'object') return null;

  const raw = item as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;

  const now = Date.now();
  const tags = Array.isArray(raw.tags)
    ? Array.from(
        new Set(
          raw.tags
            .filter((tag): tag is string => typeof tag === 'string')
            .map((tag) => tag.trim().replace(/^#/, '').toLowerCase())
            .filter(Boolean)
        )
      )
    : [];

  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : now;
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : createdAt;

  return {
    id: raw.id,
    title: raw.title,
    content: typeof raw.content === 'string' ? raw.content : '',
    category: shelfOf(raw.category, tags),
    tags,
    isPinned: raw.isPinned === true,
    createdAt,
    updatedAt,
  };
}

/**
 * Parse an exported backup. Unknown fields are dropped and missing/invalid
 * fields are normalized so a hand-edited or foreign JSON file cannot crash the
 * note list after import.
 */
export function parseNotesFromJson(jsonString: string): Note[] | null {
  try {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map(normalizeImportedNote)
      .filter((note): note is Note => note !== null);
  } catch {
    return null;
  }
}
