import React, { useState, useEffect, useRef, useId } from 'react';
import { Note, NoteCategory, OllamaConfig } from '../types/index.ts';
import { SHELVES } from '../utils/shelves.ts';
import { calculateNoteStats, extractTagsFromText } from '../utils/notes.ts';
import {
  buildOllamaBrainPrompt,
  queryOllama,
  generateSimulatedResponse,
} from '../utils/ollama.ts';
import { renderMarkdown } from '../utils/markdown.ts';
import {
  FileText,
  Columns,
  Eye,
  Tag,
  Sparkles,
  ListTodo,
  FileCheck,
  GitBranch,
  Lightbulb,
  Plus,
  X,
  Copy,
  Check,
  Clock,
  ArrowDownToLine,
  Loader2,
  ArrowLeft,
} from 'lucide-react';

interface NoteEditorProps {
  note: Note | null;
  onUpdateNote: (updated: Partial<Note>) => void;
  ollamaConfig: OllamaConfig;
  onOpenOllamaSetup: () => void;
  onBackToNotes?: () => void;
  className?: string;
}

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  onUpdateNote,
  ollamaConfig,
  onOpenOllamaSetup,
  onBackToNotes,
  className = '',
}) => {
  const [viewMode, setViewMode] = useState<'edit' | 'split' | 'preview'>('split');
  const [newTagInput, setNewTagInput] = useState('');
  const [aiDistillLoading, setAiDistillLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{ mode: string; text: string } | null>(null);
  const [copiedResult, setCopiedResult] = useState(false);
  const tagInputId = useId();

  const activeNoteId = note?.id ?? null;
  const activeNoteIdRef = useRef(activeNoteId);
  activeNoteIdRef.current = activeNoteId;

  // Results belong to the note that produced them. Reset when the selection
  // changes so a summary of note A can never be appended to note B.
  useEffect(() => {
    setAiResult(null);
    setNewTagInput('');
    setCopiedResult(false);
    setAiDistillLoading(false);
  }, [activeNoteId]);

  if (!note) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-neutral-950 text-neutral-400">
        <div className="w-12 h-12 rounded-xl bg-neutral-900 border border-neutral-800 flex items-center justify-center mb-4 text-neutral-400">
          <FileText className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-semibold text-white mb-1">No Note Selected</h3>
        <p className="text-xs max-w-sm text-neutral-400 mb-4">
          Select a note from the library or create a new one to start writing and synthesizing.
        </p>
      </div>
    );
  }

  const stats = calculateNoteStats(note.content);

  const categories: { id: NoteCategory; label: string }[] = SHELVES;

  const handleAddTag = (e: React.KeyboardEvent | React.MouseEvent) => {
    if ('key' in e && e.key !== 'Enter') return;
    e.preventDefault();
    const clean = newTagInput.trim().replace(/^#/, '').toLowerCase();
    if (clean && !note.tags.includes(clean)) {
      onUpdateNote({ tags: [...note.tags, clean], updatedAt: Date.now() });
      setNewTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    onUpdateNote({
      tags: note.tags.filter((t) => t !== tagToRemove),
      updatedAt: Date.now(),
    });
  };

  const handleAutoExtractTags = () => {
    const extracted = extractTagsFromText(note.content);
    if (extracted.length === 0) return;
    const combined = Array.from(new Set([...note.tags, ...extracted]));
    onUpdateNote({ tags: combined, updatedAt: Date.now() });
  };

  const handleRunAiDistill = async (
    mode: 'summarize' | 'action_items' | 'connect' | 'expand'
  ) => {
    if (!note.content.trim()) return;

    const requestNoteId = note.id;
    setAiDistillLoading(true);
    setAiResult(null);

    const modeLabels: Record<string, string> = {
      summarize: 'Executive Summary',
      action_items: 'Action Checklist',
      connect: 'Knowledge Connections',
      expand: 'Thought Partner Expansion',
    };

    try {
      if (ollamaConfig.isConnected && !ollamaConfig.isSimulatedMode) {
        const { prompt, system } = buildOllamaBrainPrompt(mode, note.content);
        const text = await queryOllama(
          ollamaConfig.hostUrl,
          ollamaConfig.model,
          prompt,
          system
        );
        if (activeNoteIdRef.current !== requestNoteId) return;
        setAiResult({ mode: modeLabels[mode], text });
      } else {
        // Fallback to local simulation mode with slight delay for natural feeling
        await new Promise((r) => setTimeout(r, 600));
        if (activeNoteIdRef.current !== requestNoteId) return;
        const simulated = generateSimulatedResponse(mode, note.content);
        const label = ollamaConfig.isSimulatedMode
          ? `${modeLabels[mode]} (Simulation Mode)`
          : `${modeLabels[mode]} (Offline Demo — Ollama not connected)`;
        setAiResult({ mode: label, text: simulated });
      }
    } catch (err: unknown) {
      if (activeNoteIdRef.current !== requestNoteId) return;
      console.warn('Ollama distill error:', err);
      // Fallback gracefully so user experience is never blocked
      const simulated = generateSimulatedResponse(mode, note.content);
      setAiResult({
        mode: `${modeLabels[mode]} (Simulated Fallback)`,
        text: simulated,
      });
    } finally {
      if (activeNoteIdRef.current === requestNoteId) {
        setAiDistillLoading(false);
      }
    }
  };

  const handleAppendResultToNote = () => {
    if (!aiResult) return;
    const newContent = `${note.content}\n\n---\n\n${aiResult.text}`;
    onUpdateNote({ content: newContent, updatedAt: Date.now() });
    setAiResult(null);
  };

  const handleCopyResult = () => {
    if (!aiResult) return;
    navigator.clipboard.writeText(aiResult.text);
    setCopiedResult(true);
    setTimeout(() => setCopiedResult(false), 2000);
  };

  // Convert markdown to sanitized HTML for the preview pane
  const renderedHtml = renderMarkdown(note.content);

  return (
    <div className={`flex-1 flex flex-col h-[calc(100vh-3.5rem)] bg-neutral-950 overflow-hidden ${className}`}>
      {/* Top note toolbar */}
      <div className="px-4 sm:px-6 py-2.5 sm:py-3 border-b border-neutral-800 flex flex-wrap items-center justify-between gap-3 shrink-0 bg-neutral-950/90 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          {onBackToNotes && (
            <button
              onClick={onBackToNotes}
              className="md:hidden flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-900 border border-neutral-800 rounded-lg transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Notes</span>
            </button>
          )}

          {/* Category Segmented Control */}
          <div className="flex items-center gap-1 p-1 bg-neutral-900 border border-neutral-800 rounded-lg overflow-x-auto max-w-[200px] sm:max-w-none shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => onUpdateNote({ category: cat.id, updatedAt: Date.now() })}
              className={`px-2 py-0.5 sm:px-2.5 sm:py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                note.category === cat.id
                  ? 'bg-neutral-800 text-white font-semibold'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {cat.label}
            </button>
          ))}
          </div>
        </div>

        {/* View Mode & AI Distill Buttons */}
        <div className="flex items-center gap-2">
          {/* AI Distill Dropdown / Buttons */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleRunAiDistill('summarize')}
              disabled={aiDistillLoading}
              title="Distill into executive summary & key insights"
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-md transition-colors disabled:opacity-50"
            >
              <FileCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden sm:inline">Summarize</span>
            </button>

            <button
              onClick={() => handleRunAiDistill('action_items')}
              disabled={aiDistillLoading}
              title="Extract tasks and deadlines as checklist"
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-md transition-colors disabled:opacity-50"
            >
              <ListTodo className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline">Action Items</span>
            </button>

            <button
              onClick={() => handleRunAiDistill('connect')}
              disabled={aiDistillLoading}
              title="Identify conceptual pillars and cross-links"
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-md transition-colors disabled:opacity-50"
            >
              <GitBranch className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Connect</span>
            </button>

            <button
              onClick={() => handleRunAiDistill('expand')}
              disabled={aiDistillLoading}
              title="Act as a thought partner to expand concepts"
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-md transition-colors disabled:opacity-50"
            >
              <Lightbulb className="w-3.5 h-3.5 text-purple-400" />
              <span className="hidden md:inline">Expand</span>
            </button>
          </div>

          <div className="h-4 w-px bg-neutral-800 mx-1" />

          {/* Editor view toggle */}
          <div className="flex items-center gap-1 p-1 bg-neutral-900 border border-neutral-800 rounded-lg">
            <button
              onClick={() => setViewMode('edit')}
              title="Write mode only"
              className={`p-1 rounded transition-colors ${
                viewMode === 'edit' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('split')}
              title="Split side-by-side mode"
              className={`p-1 rounded transition-colors ${
                viewMode === 'split' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <Columns className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('preview')}
              title="Preview rendered markdown only"
              className={`p-1 rounded transition-colors ${
                viewMode === 'preview' ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Title & Metadata Strip */}
      <div className="px-4 sm:px-8 pt-5 pb-3 space-y-2.5 shrink-0">
        <input
          type="text"
          value={note.title}
          onChange={(e) => onUpdateNote({ title: e.target.value, updatedAt: Date.now() })}
          placeholder="Untitled Note..."
          className="w-full max-w-full bg-transparent text-xl sm:text-2xl font-bold tracking-tight text-white placeholder-neutral-600 focus:outline-none pr-3"
        />

        {/* Tags bar */}
        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
          <div className="flex items-center gap-1 text-neutral-400">
            <Tag className="w-3.5 h-3.5" />
            <span>Tags:</span>
          </div>

          {note.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-300 font-mono text-[11px]"
            >
              #{tag}
              <button
                onClick={() => handleRemoveTag(tag)}
                className="text-neutral-500 hover:text-rose-400 ml-0.5"
                title={`Remove tag #${tag}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}

          {/* Add tag inline */}
          <div className="inline-flex items-center gap-1">
            <label htmlFor={tagInputId} className="sr-only">Add tag</label>
            <input
              id={tagInputId}
              type="text"
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              onKeyDown={handleAddTag}
              placeholder="+ add tag..."
              className="w-24 px-2 py-0.5 bg-neutral-900 border border-neutral-800 rounded text-[11px] text-neutral-200 placeholder-neutral-400 focus:outline-none focus:border-neutral-600"
            />
            {newTagInput && (
              <button
                onClick={handleAddTag}
                className="p-1 text-neutral-400 hover:text-white"
              >
                <Plus className="w-3 h-3" />
              </button>
            )}
          </div>

          <button
            onClick={handleAutoExtractTags}
            title="Scan note text for #hashtags and register them"
            className="text-[11px] text-neutral-400 hover:text-neutral-300 ml-2 transition-colors"
          >
            Detect in text
          </button>
        </div>
      </div>

      {/* AI Processing Status / Drawer */}
      {aiDistillLoading && (
        <div className="mx-8 mb-3 p-3 bg-neutral-900/90 border border-neutral-800 rounded-lg flex items-center gap-3 text-xs text-neutral-300 animate-pulse shrink-0">
          <Loader2 className="w-4 h-4 text-emerald-400 animate-spin shrink-0" />
          <div className="flex-1">
            <span className="font-semibold text-white">Synthesizing with {ollamaConfig.model}... </span>
            <span className="text-neutral-400">Distilling insights from local note context.</span>
          </div>
        </div>
      )}

      {aiResult && !aiDistillLoading && (
        <div className="mx-8 mb-4 p-4 bg-neutral-900 border border-neutral-700 rounded-xl shadow-lg space-y-3 shrink-0 max-h-56 overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-bold text-white tracking-wide uppercase">
                {aiResult.mode}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleAppendResultToNote}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:text-emerald-200 bg-emerald-950/60 border border-emerald-800/60 rounded hover:bg-emerald-950 transition-colors"
              >
                <ArrowDownToLine className="w-3.5 h-3.5" />
                <span>Append to Note</span>
              </button>
              <button
                onClick={handleCopyResult}
                className="flex items-center gap-1 px-2 py-1 text-xs text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition-colors"
              >
                {copiedResult ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedResult ? 'Copied' : 'Copy'}</span>
              </button>
              <button
                onClick={() => setAiResult(null)}
                className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div
            className="text-xs text-neutral-300 markdown-body leading-relaxed select-text"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(aiResult.text) }}
          />
        </div>
      )}

      {/* Editor & Preview Viewport */}
      <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-2 divide-x divide-neutral-900">
        {/* Editor Area */}
        {(viewMode === 'edit' || viewMode === 'split') && (
          <div className={`h-full flex flex-col ${viewMode === 'edit' ? 'col-span-full' : ''}`}>
            <textarea
              value={note.content}
              onChange={(e) => onUpdateNote({ content: e.target.value, updatedAt: Date.now() })}
              placeholder="Start typing your note in Markdown... Use #tags to index."
              className="w-full h-full p-8 bg-transparent text-neutral-200 text-sm leading-relaxed font-mono resize-none focus:outline-none selection:bg-neutral-800 overflow-y-auto"
            />
          </div>
        )}

        {/* Rendered Preview Area */}
        {(viewMode === 'preview' || viewMode === 'split') && (
          <div
            className={`h-full p-8 overflow-y-auto bg-neutral-950 markdown-body ${
              viewMode === 'preview' ? 'col-span-full' : ''
            }`}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}
      </div>

      {/* Editor Status Bar */}
      <div className="px-4 sm:px-6 py-2 border-t border-neutral-900 bg-neutral-950/80 flex items-center justify-between text-[11px] text-neutral-400 font-mono tabular-nums shrink-0">
        <div className="flex items-center gap-2">
          <span>{stats.words} words</span>
          <span className="hidden sm:inline">·</span>
          <span className="hidden sm:inline">{stats.chars} chars</span>
          <span className="hidden sm:inline">·</span>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3 text-neutral-400" />
            <span>{stats.readingTimeMinutes}m read</span>
          </span>
        </div>

        <div className="flex items-center gap-2 text-neutral-500">
          <span>Auto-saved</span>
        </div>
      </div>
    </div>
  );
};
