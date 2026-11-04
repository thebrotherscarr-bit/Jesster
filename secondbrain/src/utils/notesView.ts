import { Note, NoteCategory } from '../types/index.ts';
import { SHELVES, shelfOf } from './shelves.ts';
import { calculateBrainStats, filterNotes, parseNotesFromJson } from './notes.ts';

/**
 * The Notes tab, kept plain (the operator, 2026-11-04: "the notes tab makes sense if its organized and working
 * properly"). Notes sit on the vault's shelves with a count each, a search narrows them, and the list is newest
 * first. The vault folder is the store: no starter notes beside it, no reset, no JSON copies of it.
 */

export type ShelfFilter = NoteCategory | 'all';

/**
 * The notes the window starts with: what this window kept last time; otherwise nothing when a vault is
 * present (the vault loads its own), and the starter notes only in a browser that has no vault.
 */
export function initialNotes(saved: string | null, hasVault: boolean, starter: Note[]): Note[] {
  const kept = saved ? parseNotesFromJson(saved) : null;
  if (kept && kept.length) return kept;
  return hasVault ? [] : starter;
}

/** Each shelf with its count, "All" first. */
export function shelfCounts(notes: Note[]): { id: ShelfFilter; label: string; count: number }[] {
  const stats = calculateBrainStats(notes);
  return [
    { id: 'all', label: 'All notes', count: stats.totalNotes },
    ...SHELVES.map((s) => ({ id: s.id, label: s.label, count: stats.shelves[s.id] || 0 })),
  ];
}

/** The list: one shelf (or all), narrowed by the search, newest first. */
export function notesShown(notes: Note[], query: string, shelf: ShelfFilter): Note[] {
  return filterNotes(notes, query)
    .filter((n) => shelf === 'all' || shelfOf(n.category, n.tags) === shelf)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A short date for the list: the time today, the day this year, else the day and year. */
export function shortDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === n.getFullYear()) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The question a delete asks first. */
export function deletePrompt(note: Pick<Note, 'title'>): string {
  return `Delete "${note.title || 'Untitled'}"?\n\nIn the desktop app its file is moved to the vault's .trash folder.`;
}

/** Delete a note only on a yes: the notes without it, or null when the answer is no. */
export function removeNoteConfirmed(notes: Note[], id: string, ask: (message: string) => boolean): Note[] | null {
  const note = notes.find((n) => n.id === id);
  if (!note || !ask(deletePrompt(note))) return null;
  return notes.filter((n) => n.id !== id);
}

/** Tags typed as one line: "a, #b c" becomes ["a", "b", "c"]. */
export function parseTags(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,]+/)
        .map((t) => t.trim().replace(/^#/, '').toLowerCase())
        .filter(Boolean)
    )
  );
}

/** What the Agent tab's message box is filled with by "Ask Steward about this note". */
export function askAboutNote(note: Pick<Note, 'id' | 'title'>): string {
  return `About the note "${note.title || 'Untitled'}" (id ${note.id}): `;
}
