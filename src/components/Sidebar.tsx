import React from 'react';
import { NoteCategory, BrainStats } from '../types/index.ts';
import {
  Inbox,
  FolderGit2,
  Compass,
  BookOpen,
  Archive,
  Layers,
  Pin,
  Download,
  Upload,
  RotateCcw,
  Tag,
} from 'lucide-react';

interface SidebarProps {
  activeCategory: NoteCategory | 'all';
  onSelectCategory: (cat: NoteCategory | 'all') => void;
  activeTag: string | 'all';
  onSelectTag: (tag: string | 'all') => void;
  pinnedOnly: boolean;
  onTogglePinnedOnly: () => void;
  allTags: string[];
  stats: BrainStats;
  onExportNotes: () => void;
  onImportNotes: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onResetSeedNotes: () => void;
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeCategory,
  onSelectCategory,
  activeTag,
  onSelectTag,
  pinnedOnly,
  onTogglePinnedOnly,
  allTags,
  stats,
  onExportNotes,
  onImportNotes,
  onResetSeedNotes,
  className = '',
}) => {
  const categories: {
    id: NoteCategory | 'all';
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count: number;
    description: string;
  }[] = [
    { id: 'all', label: 'All Notes', icon: Layers, count: stats.totalNotes, description: 'Entire knowledge graph' },
    { id: 'inbox', label: 'Inbox', icon: Inbox, count: stats.inboxCount, description: 'Quick captured ideas' },
    { id: 'projects', label: 'Projects', icon: FolderGit2, count: stats.projectsCount, description: 'Active outcomes & deadlines' },
    { id: 'areas', label: 'Areas', icon: Compass, count: stats.areasCount, description: 'Ongoing responsibilities' },
    { id: 'resources', label: 'Resources', icon: BookOpen, count: stats.resourcesCount, description: 'Reference & playbooks' },
    { id: 'archives', label: 'Archives', icon: Archive, count: stats.archivesCount, description: 'Completed historical' },
  ];

  return (
    <aside className={`w-full md:w-64 border-r border-neutral-800 bg-neutral-950 flex flex-col h-[calc(100vh-3.5rem)] shrink-0 select-none ${className}`}>
      {/* Navigation / PARA categories */}
      <div className="p-3 space-y-1">
        <div className="px-3 py-1.5 text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">
          Organization (PARA)
        </div>

        {categories.map((cat) => {
          const Icon = cat.icon;
          const isActive = activeCategory === cat.id && !pinnedOnly;
          return (
            <button
              key={cat.id}
              onClick={() => {
                if (pinnedOnly) onTogglePinnedOnly();
                onSelectCategory(cat.id);
              }}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-neutral-800 text-white font-semibold'
                  : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
              }`}
            >
              <div className="flex items-center gap-2.5 truncate">
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-white' : 'text-neutral-400'}`} />
                <span className="truncate">{cat.label}</span>
              </div>
              <span className="font-mono text-[11px] text-neutral-400 tabular-nums shrink-0 ml-2">
                {cat.count}
              </span>
            </button>
          );
        })}

        {/* Pinned filter button */}
        <button
          onClick={onTogglePinnedOnly}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
            pinnedOnly
              ? 'bg-neutral-800 text-white font-semibold'
              : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
          }`}
        >
          <div className="flex items-center gap-2.5 truncate">
            <Pin className={`w-4 h-4 shrink-0 ${pinnedOnly ? 'text-amber-400' : 'text-neutral-400'}`} />
            <span className="truncate">Pinned Notes</span>
          </div>
        </button>
      </div>

      {/* Tags section */}
      <div className="flex-1 overflow-y-auto px-3 py-2 border-t border-neutral-900 space-y-2">
        <div className="flex items-center justify-between px-3 py-1">
          <span className="text-[11px] font-semibold tracking-wider text-neutral-400 uppercase">
            Tags ({allTags.length})
          </span>
          {activeTag !== 'all' && (
            <button
              onClick={() => onSelectTag('all')}
              className="text-[11px] text-neutral-400 hover:text-white transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 px-2">
          {allTags.length === 0 ? (
            <span className="text-xs text-neutral-600 italic px-1">No tags yet</span>
          ) : (
            allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => onSelectTag(activeTag === tag ? 'all' : tag)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                  activeTag === tag
                    ? 'bg-neutral-800 text-emerald-400 font-medium'
                    : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
                }`}
              >
                <Tag className="w-3 h-3 text-neutral-500" />
                <span>{tag}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Brain Metrics & Local Data Sovereignty Footer */}
      <div className="p-3 border-t border-neutral-800 space-y-3 shrink-0 bg-neutral-950/60">
        <div className="flex items-center justify-between text-[11px] text-neutral-400 px-1 font-mono tabular-nums">
          <span>{stats.totalNotes} notes</span>
          <span>·</span>
          <span>{stats.totalWords.toLocaleString()} words</span>
          <span>·</span>
          <span>{stats.totalTags} tags</span>
        </div>

        <div className="flex items-center justify-between gap-1 pt-1 border-t border-neutral-900 text-xs">
          <button
            onClick={onExportNotes}
            title="Export all notes to JSON backup"
            className="flex items-center gap-1 px-2 py-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-900 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="text-[11px]">Export</span>
          </button>

          <label
            title="Import notes from JSON backup"
            className="flex items-center gap-1 px-2 py-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-900 transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span className="text-[11px]">Import</span>
            <input
              type="file"
              accept=".json"
              onChange={onImportNotes}
              className="hidden"
            />
          </label>

          <button
            onClick={onResetSeedNotes}
            title="Reset to starter notes"
            className="flex items-center gap-1 px-2 py-1 rounded text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            <span className="text-[11px]">Reset</span>
          </button>
        </div>
      </div>
    </aside>
  );
};
