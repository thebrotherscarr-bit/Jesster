import React from 'react';
import { ShelfFilter } from '../utils/notesView.ts';

interface SidebarProps {
  shelves: { id: ShelfFilter; label: string; count: number }[];
  active: ShelfFilter;
  onSelect: (shelf: ShelfFilter) => void;
}

/**
 * The shelves the vault keeps notes on, each with its count. Nothing else: the vault folder is the store, so
 * there is no reset, export or import here, and Steward writes new notes.
 */
export const Sidebar: React.FC<SidebarProps> = ({ shelves, active, onSelect }) => (
  <nav aria-label="Shelves" className="hidden lg:flex w-52 shrink-0 min-h-0 flex-col border-r border-neutral-800">
    <div className="px-4 py-2 border-b border-neutral-800 text-xs text-neutral-200 font-semibold">Notes</div>
    <ul className="flex-1 min-h-0 overflow-y-auto p-2 space-y-0.5">
      {shelves.map((s) => (
        <li key={s.id}>
          <button
            onClick={() => onSelect(s.id)}
            aria-current={active === s.id}
            className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-xs ${
              active === s.id ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
            }`}
          >
            <span className="truncate">{s.label}</span>
            <span className="tabular-nums text-neutral-500 shrink-0">{s.count}</span>
          </button>
        </li>
      ))}
    </ul>
  </nav>
);
