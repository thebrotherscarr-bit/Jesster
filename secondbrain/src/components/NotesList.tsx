import React from 'react';
import { Note } from '../types/index.ts';
import { ShelfFilter, shortDate } from '../utils/notesView.ts';
import { Search, X } from 'lucide-react';

interface NotesListProps {
  notes: Note[];
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  /** the shelves again, as a picker, where the window is too narrow for the shelf column */
  shelves: { id: ShelfFilter; label: string; count: number }[];
  shelf: ShelfFilter;
  onSelectShelf: (shelf: ShelfFilter) => void;
  className?: string;
}

/** A search and a plain list: each note's title and a short date, newest first. */
export const NotesList: React.FC<NotesListProps> = ({
  notes,
  selectedNoteId,
  onSelectNote,
  searchQuery,
  onSearchChange,
  shelves,
  shelf,
  onSelectShelf,
  className = '',
}) => (
  <section aria-label="Notes" className={`w-full md:w-72 shrink-0 min-w-0 min-h-0 flex-col border-r border-neutral-800 ${className}`}>
    <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800 min-w-0">
      <div className="relative flex-1 min-w-0">
        <Search className="w-3.5 h-3.5 text-neutral-500 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search notes"
          aria-label="Search notes"
          className="w-full pl-7 pr-7 py-1 bg-neutral-900 border border-neutral-800 rounded-md text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-600"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            aria-label="Clear the search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <select
        value={shelf}
        onChange={(e) => onSelectShelf(e.target.value as ShelfFilter)}
        aria-label="Shelf"
        className="lg:hidden shrink-0 max-w-[45%] bg-neutral-900 border border-neutral-800 rounded-md px-1.5 py-1 text-xs text-neutral-200 focus:outline-none"
      >
        {shelves.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label} ({s.count})
          </option>
        ))}
      </select>
    </div>

    <ul className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-2 space-y-0.5">
      {notes.length === 0 ? (
        <li className="px-2 py-6 text-center text-xs text-neutral-500">
          {searchQuery ? 'No notes match the search.' : 'No notes here yet. Steward writes them.'}
        </li>
      ) : (
        notes.map((note) => (
          <li key={note.id} className="min-w-0">
            <button
              onClick={() => onSelectNote(note.id)}
              aria-current={note.id === selectedNoteId}
              title={note.title || 'Untitled'}
              className={`w-full min-w-0 flex items-baseline gap-2 px-2 py-1.5 rounded-md text-left text-xs ${
                note.id === selectedNoteId ? 'bg-neutral-800 text-white' : 'text-neutral-300 hover:bg-neutral-900 hover:text-white'
              }`}
            >
              <span className="flex-1 min-w-0 truncate">{note.title || 'Untitled'}</span>
              <span className="shrink-0 tabular-nums text-[11px] text-neutral-500">{shortDate(note.updatedAt)}</span>
            </button>
          </li>
        ))
      )}
    </ul>
  </section>
);
