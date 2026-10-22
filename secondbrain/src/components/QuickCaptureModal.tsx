import React, { useState } from 'react';
import { NoteCategory } from '../types/index.ts';
import { SHELVES } from '../utils/shelves.ts';
import { Zap, X, Plus, Mic, Loader2 } from 'lucide-react';
import { useRecorder } from '../voice/useVoice.ts';

interface QuickCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (title: string, content: string, category: NoteCategory, tags: string[]) => void;
  /** whisper.cpp model for the mic ('' = the one found beside whisper-cli) */
  whisperModel?: string;
}

export const QuickCaptureModal: React.FC<QuickCaptureModalProps> = ({
  isOpen,
  onClose,
  onSave,
  whisperModel = '',
}) => {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<NoteCategory>('inbox');
  const [tagsInput, setTagsInput] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorder = useRecorder(
    whisperModel,
    (text) => setContent((x) => (x.trim() ? `${x.trimEnd()} ${text}` : text)),
    setVoiceError
  );
  const canSpeak = typeof window !== 'undefined' && Boolean(window.secondbrainDesktop?.voice?.local);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() && !title.trim()) return;

    const tags = tagsInput
      .split(/[\s,]+/)
      .map((t) => t.trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean);

    onSave(
      title.trim() || 'Quick Thought',
      content.trim(),
      category,
      tags
    );

    setTitle('');
    setContent('');
    setCategory('inbox');
    setTagsInput('');
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-capture-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
    >
      <div className="relative w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl p-5 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <h2 id="quick-capture-title" className="text-sm font-bold text-white tracking-tight">
              Instant Quick Capture
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close capture modal"
            className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="py-4 space-y-3">
          <div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Thought or Idea Title..."
              autoFocus
              className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-sm font-semibold text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-600"
            />
          </div>

          <div className="relative">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={canSpeak ? 'Unload raw thoughts, links, code, or tasks here, or press the mic and talk...' : 'Unload raw thoughts, links, code, or tasks here...'}
              rows={5}
              className={`w-full p-3 ${canSpeak ? 'pr-12' : ''} bg-neutral-950 border border-neutral-800 rounded-lg text-xs font-mono text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-neutral-600 resize-none leading-relaxed`}
            />
            {canSpeak && (
              <button
                type="button"
                onClick={() => (recorder.state === 'recording' ? recorder.stop() : recorder.state === 'idle' && (setVoiceError(null), recorder.start()))}
                aria-label={recorder.state === 'recording' ? 'Stop recording' : 'Speak'}
                title={recorder.state === 'recording' ? 'Stop and transcribe' : recorder.state === 'idle' ? 'Speak (whisper.cpp, on this PC)' : 'Transcribing…'}
                className={`absolute right-2 top-2 p-2 rounded-lg border ${recorder.state === 'recording' ? 'border-rose-500 bg-rose-950 text-rose-300 animate-pulse' : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'}`}
              >
                {recorder.state === 'idle' || recorder.state === 'recording' ? <Mic className="w-4 h-4" /> : <Loader2 className="w-4 h-4 animate-spin" />}
              </button>
            )}
            {voiceError && <p className="mt-1 text-[11px] text-amber-400">{voiceError}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="quick-category-select" className="block text-[11px] font-semibold text-neutral-400 mb-1">
                Category
              </label>
              <select
                id="quick-category-select"
                value={category}
                onChange={(e) => setCategory(e.target.value as NoteCategory)}
                className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 rounded-lg text-xs text-white focus:outline-none focus:border-neutral-600 capitalize"
              >
                {SHELVES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id === 'inbox' ? 'Inbox (unfiled)' : s.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="quick-tags-input" className="block text-[11px] font-semibold text-neutral-400 mb-1">
                Tags (space separated)
              </label>
              <input
                id="quick-tags-input"
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="idea ollama focus"
                className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 rounded-lg text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-600 font-mono"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-neutral-800 flex items-center justify-between">
            <span className="text-[11px] text-neutral-500">Shortcut: Enter to submit</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim() && !content.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-neutral-900 bg-white hover:bg-neutral-100 rounded-lg transition-colors disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Save to Brain</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
