import React from 'react';
import { Note } from '../types/index.ts';
import { calculateNoteStats } from '../utils/notes.ts';
import { Search, Pin, Trash2, Plus, X } from 'lucide-react';

interface NotesListProps {
  notes: Note[];
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onTogglePin: (id: string, e: React.MouseEvent) => void;
  onDeleteNote: (id: string, e: React.MouseEvent) => void;
  onCreateNote: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sortBy: 'updated' | 'created' | 'title' | 'words';
  onSortChange: (sort: 'updated' | 'created' | 'title' | 'words') => void;
  className?: string;
}

export const NotesList: React.FC<NotesListProps> = ({
  notes,
  selectedNoteId,
  onSelectNote,
  onTogglePin,
  onDeleteNote,
  onCreateNote,
  searchQuery,
  onSearchChange,
  sortBy,
  onSortChange,
  className = '',
}) => {
  const formatTime = (ts: number) => {
    const diffMs = Date.now() - ts;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'yesterday';
    return `${diffDays}d ago`;
  };

  return (
    <div className={`w-full md:w-80 border-r border-neutral-800 bg-neutral-950 flex flex-col h-[calc(100vh-3.5rem)] shrink-0 ${className}`}>
      {/* Top search & sorting bar */}
      <div className="p-3 border-b border-neutral-800 space-y-2">
        <div className="relative">
          <Search className="w-4 h-4 text-neutral-400 absolute left-2.5 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search notes & #tags..."
            className="w-full pl-8 pr-7 py-1.5 bg-neutral-900 border border-neutral-800 rounded-lg text-xs text-white placeholder-neutral-400 focus:outline-none focus:border-neutral-600"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-2 text-neutral-500 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between text-[11px] text-neutral-400">
          <span className="tabular-nums font-mono">{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
          <div className="flex items-center gap-1.5">
            <span>Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value as any)}
              className="bg-transparent text-neutral-300 font-medium focus:outline-none cursor-pointer hover:text-white"
            >
              <option value="updated" className="bg-neutral-900">Recent</option>
              <option value="created" className="bg-neutral-900">Created</option>
              <option value="title" className="bg-neutral-900">Title</option>
              <option value="words" className="bg-neutral-900">Words</option>
            </select>
          </div>
        </div>
      </div>

      {/* Note Cards List */}
      <div className="flex-1 overflow-y-auto divide-y divide-neutral-900">
        {notes.length === 0 ? (
          <div className="p-6 text-center space-y-3">
            <p className="text-xs text-neutral-400">No matching notes found.</p>
            <button
              onClick={onCreateNote}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-neutral-900 bg-white hover:bg-neutral-100 rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create Note</span>
            </button>
          </div>
        ) : (
          notes.map((note) => {
            const isSelected = selectedNoteId === note.id;
            const stats = calculateNoteStats(note.content);

            // Clean snippet
            const snippet = note.content
              .replace(/^[#\s\-*>`_]+/gm, '')
              .replace(/\[[ xX]\]/g, '')
              .slice(0, 110)
              .trim();

            return (
              <div
                key={note.id}
                onClick={() => onSelectNote(note.id)}
                className={`group p-3.5 cursor-pointer transition-colors relative flex flex-col gap-1.5 ${
                  isSelected
                    ? 'bg-neutral-900/90'
                    : 'hover:bg-neutral-900/40'
                }`}
              >
                {/* Header row: Title & Actions */}
                <div className="flex items-start justify-between gap-2">
                  <h3
                    className={`text-xs font-semibold leading-snug line-clamp-1 ${
                      isSelected ? 'text-white' : 'text-neutral-200 group-hover:text-white'
                    }`}
                  >
                    {note.title || 'Untitled Note'}
                  </h3>

                  <div className="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100">
                    <button
                      onClick={(e) => onTogglePin(note.id, e)}
                      title={note.isPinned ? 'Unpin note' : 'Pin note'}
                      className={`p-1 rounded hover:bg-neutral-800 transition-colors ${
                        note.isPinned ? 'text-amber-400' : 'text-neutral-600 hover:text-neutral-300'
                      }`}
                    >
                      <Pin className="w-3 h-3 fill-current" />
                    </button>
                    <button
                      onClick={(e) => onDeleteNote(note.id, e)}
                      title="Delete note"
                      className="p-1 rounded text-neutral-600 hover:text-rose-400 hover:bg-neutral-800 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Content snippet */}
                <p className="text-[11px] text-neutral-400 line-clamp-2 leading-relaxed">
                  {snippet || 'Empty note...'}
                </p>

                {/* Unboxed Metadata (Zero-pill discipline) */}
                <div className="flex items-center gap-2 text-[10px] text-neutral-400 font-mono pt-1">
                  <span className="capitalize">{note.category}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{stats.words}w</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatTime(note.updatedAt)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
