import { NoteCategory } from '../types/index.ts';

/**
 * The shelves notes sit on. One list, used by the sidebar, the editor, quick
 * capture and the graph, so adding a shelf is one line here.
 */
export const SHELVES: { id: NoteCategory; label: string; description: string; color: string }[] = [
  { id: 'inbox', label: 'Inbox', description: 'Captured, not yet filed', color: '#a855f7' },
  { id: 'projects', label: 'Projects', description: 'What is being built', color: '#3b82f6' },
  { id: 'tasks', label: 'Tasks', description: 'Things to do', color: '#10b981' },
  { id: 'worlds', label: 'Worlds', description: 'The worlds in the ground', color: '#06b6d4' },
  { id: 'archives', label: 'Archives', description: 'Done, imported and dug up', color: '#71717a' },
  { id: 'laws', label: 'Laws', description: 'Rulings and rules', color: '#f59e0b' },
  { id: 'scratchpads', label: 'Scratchpads', description: 'Working notes', color: '#ec4899' },
];

export const SHELF_IDS: NoteCategory[] = SHELVES.map((s) => s.id);

/** Where the old shelves went (2026-10-22). */
export const LEGACY_SHELVES: Record<string, NoteCategory> = { areas: 'projects', resources: 'archives' };

/** The shelf for a note as stored: old shelves moved, rulings on Laws, unknowns to the inbox. */
export function shelfOf(category: unknown, tags: string[] = []): NoteCategory {
  if (tags.includes('ruling')) return 'laws';
  const c = String(category || '').toLowerCase();
  if (SHELF_IDS.includes(c as NoteCategory)) return c as NoteCategory;
  return LEGACY_SHELVES[c] || 'inbox';
}
