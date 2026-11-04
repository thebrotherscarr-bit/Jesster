import React, { useEffect, useState } from 'react';
import { Note, NoteCategory } from '../types/index.ts';
import { SHELVES, shelfOf } from '../utils/shelves.ts';
import { parseTags, shortDate } from '../utils/notesView.ts';
import { renderMarkdown } from '../utils/markdown.ts';
import { ArrowLeft, Bot, FileText, Pencil, Check, Trash2 } from 'lucide-react';

interface NoteEditorProps {
  note: Note | null;
  onUpdateNote: (updated: Partial<Note>) => void;
  /** asks first (App.tsx, utils/notesView.ts removeNoteConfirmed) */
  onDeleteNote: (id: string) => void;
  /** opens the Agent tab with this note named in the message box; absent where there is no Agent tab */
  onAskSteward?: (note: Note) => void;
  /** back to the list, where the window is too narrow for both */
  onBack: () => void;
  className?: string;
}

/**
 * The selected note: read it, or switch to Edit. One switch, read or edit. Steward is the agent, so there are no
 * AI buttons here; "Ask Steward" hands the note to him on the Agent tab.
 */
export const NoteEditor: React.FC<NoteEditorProps> = ({ note, onUpdateNote, onDeleteNote, onAskSteward, onBack, className = '' }) => {
  const [editing, setEditing] = useState(false);
  const [tagText, setTagText] = useState('');
  const noteId = note?.id ?? null;

  // a newly selected note opens to read
  useEffect(() => {
    setEditing(false);
  }, [noteId]);
  useEffect(() => {
    setTagText(note ? note.tags.join(', ') : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, editing]);

  if (!note) {
    return (
      <section className={`flex-1 min-w-0 min-h-0 flex-col items-center justify-center p-8 text-center ${className}`}>
        <FileText className="w-8 h-8 text-neutral-600 mb-3" />
        <p className="text-sm text-neutral-300">Pick a note to read it.</p>
        <p className="text-xs text-neutral-500 mt-1">Steward writes new notes.</p>
      </section>
    );
  }

  const shelf = shelfOf(note.category, note.tags);
  const shelfLabel = SHELVES.find((s) => s.id === shelf)?.label || shelf;
  const update = (fields: Partial<Note>) => onUpdateNote({ ...fields, updatedAt: Date.now() });
  const button = 'shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md';
  const quiet = `${button} text-neutral-400 hover:text-white hover:bg-neutral-900`;

  return (
    <section aria-label="Note" className={`flex-1 min-w-0 min-h-0 flex-col ${className}`}>
      {/* one header line, like the Agent tab's */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-neutral-800 text-xs min-w-0">
        <button onClick={onBack} aria-label="Back to the notes" className={`md:hidden ${quiet}`}>
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <span className="text-neutral-500 shrink-0">{shelfLabel}</span>
        <span className="text-neutral-600 shrink-0">/</span>
        <span className="text-neutral-200 font-semibold truncate min-w-0">{note.title || 'Untitled'}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {onAskSteward && (
            <button onClick={() => onAskSteward(note)} title="Open the Agent tab with this note named" className={quiet}>
              <Bot className="w-3.5 h-3.5 text-emerald-400" /> <span className="hidden sm:inline">Ask Steward</span>
            </button>
          )}
          <button
            onClick={() => setEditing(!editing)}
            aria-pressed={editing}
            className={editing ? `${button} bg-neutral-800 text-white` : quiet}
          >
            {editing ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />} {editing ? 'Done' : 'Edit'}
          </button>
          <button onClick={() => onDeleteNote(note.id)} title="Delete this note" aria-label="Delete" className={`${button} text-neutral-500 hover:text-rose-400 hover:bg-neutral-900`}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {editing ? (
        <div className="flex-1 min-h-0 flex flex-col gap-3 px-4 sm:px-8 py-5 max-w-3xl w-full mx-auto min-w-0">
          <input
            type="text"
            value={note.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="Title"
            aria-label="Title"
            className="w-full bg-transparent text-lg font-semibold text-white placeholder-neutral-600 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5 text-neutral-500">
              Shelf
              <select
                value={shelf}
                onChange={(e) => update({ category: e.target.value as NoteCategory })}
                className="bg-neutral-900 border border-neutral-800 rounded-md px-1.5 py-1 text-neutral-200 focus:outline-none"
              >
                {SHELVES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 min-w-[12rem] items-center gap-1.5 text-neutral-500">
              Tags
              <input
                type="text"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                onBlur={() => update({ tags: parseTags(tagText) })}
                placeholder="comma or space separated"
                className="flex-1 min-w-0 bg-neutral-900 border border-neutral-800 rounded-md px-2 py-1 text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
              />
            </label>
          </div>
          <textarea
            value={note.content}
            onChange={(e) => update({ content: e.target.value })}
            placeholder="Markdown"
            aria-label="Note text"
            className="flex-1 min-h-0 w-full p-3 bg-neutral-900/50 border border-neutral-800 rounded-md text-sm leading-relaxed text-neutral-200 font-mono resize-none focus:outline-none focus:border-neutral-600"
          />
          <p className="text-[11px] text-neutral-500">Saved as you type.</p>
        </div>
      ) : (
        <article className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-8 py-6">
          <div className="max-w-3xl mx-auto min-w-0">
            <h1 className="text-xl font-semibold text-white break-words">{note.title || 'Untitled'}</h1>
            <p className="mt-1 mb-5 text-xs text-neutral-500 break-words">
              {shelfLabel} · updated {shortDate(note.updatedAt)}
              {note.tags.length ? ` · ${note.tags.map((t) => `#${t}`).join(' ')}` : ''}
            </p>
            {note.content.trim() ? (
              <div className="markdown-body agent-md text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(note.content) }} />
            ) : (
              <p className="text-sm text-neutral-500">This note is empty.</p>
            )}
          </div>
        </article>
      )}
    </section>
  );
};
