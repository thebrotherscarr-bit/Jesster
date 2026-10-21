import React, { useState } from 'react';
import { Note, OllamaConfig, ChatMessage } from '../types/index.ts';
import { buildNotesContextForRag } from '../utils/notes.ts';
import { vaultContext } from '../utils/kernel.ts';
import {
  buildOllamaBrainPrompt,
  queryOllama,
  generateSimulatedResponse,
} from '../utils/ollama.ts';
import { renderMarkdown } from '../utils/markdown.ts';
import {
  Brain,
  Send,
  Sparkles,
  FileText,
  Copy,
  Check,
  Plus,
  Loader2,
  AlertCircle,
  HelpCircle,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';

interface AskBrainViewProps {
  notes: Note[];
  ollamaConfig: OllamaConfig;
  onOpenNote: (noteId: string) => void;
  onCreateNoteFromSynthesis: (title: string, content: string) => void;
  onOpenOllamaSetup: () => void;
  /** served by the notes kernel: search the whole vault, chats included */
  useVault?: boolean;
}

export const AskBrainView: React.FC<AskBrainViewProps> = ({
  notes,
  ollamaConfig,
  useVault = false,
  onOpenNote,
  onCreateNoteFromSynthesis,
  onOpenOllamaSetup,
}) => {
  const [query, setQuery] = useState('');
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: `Welcome to your **Second Brain AI Synthesis**. I run locally via your **Ollama desktop** using the **${ollamaConfig.model}** model. 

Ask any question across your notes, extract cross-project connections, or synthesize action items. Everything is computed directly on your device with complete privacy.`,
      timestamp: Date.now(),
    },
  ]);
  const [activeSources, setActiveSources] = useState<Note[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const sampleQuestions = [
    'What are all my active project action items and deadlines?',
    'Synthesize my notes on prompt engineering for GPT-OSS 20B',
    'What are my daily focus and deep work standards?',
    'Why should I prefer local models over cloud subscriptions?',
  ];

  const handleAsk = async (textToAsk?: string) => {
    const promptText = (textToAsk || query).trim();
    if (!promptText || isSynthesizing) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: promptText,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setQuery('');
    setIsSynthesizing(true);

    // Retrieve relevant notes: from the whole vault (imported chats and
    // captures included) when served by the kernel, else from what is loaded
    let { contextText, relevantNoteIds } = buildNotesContextForRag(notes, promptText, 5);
    if (useVault) {
      try {
        const v = await vaultContext(promptText);
        if (v.text) {
          contextText = v.text;
          relevantNoteIds = v.sources;
        }
      } catch {
        /* keep the local context */
      }
    }
    const retrievedNotes = notes.filter((n) => relevantNoteIds.includes(n.id));
    setActiveSources(retrievedNotes);

    const assistantMsgId = `assistant-${Date.now()}`;
    const initialAssistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      sourceNoteIds: relevantNoteIds,
    };

    setMessages((prev) => [...prev, initialAssistantMsg]);

    try {
      if (ollamaConfig.isConnected && !ollamaConfig.isSimulatedMode) {
        const { prompt, system } = buildOllamaBrainPrompt('ask', contextText, promptText);
        let accumulatedText = '';

        await queryOllama(
          ollamaConfig.hostUrl,
          ollamaConfig.model,
          prompt,
          system,
          (chunk) => {
            accumulatedText += chunk;
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMsgId ? { ...msg, content: accumulatedText } : msg
              )
            );
          }
        );
      } else {
        // Simulation is explicit demo text, never a stand-in model answer.
        await new Promise((r) => setTimeout(r, 600));
        const fullSimulated = generateSimulatedResponse('ask', contextText, promptText);
        const notice = ollamaConfig.isSimulatedMode
          ? 'Simulation Mode is enabled. This is canned demo text, not output from your local model.'
          : `Ollama is not connected at ${ollamaConfig.hostUrl}. This is canned demo text generated offline, not output from your local model.`;
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? { ...msg, content: `${fullSimulated}\n\n---\n*${notice}*` }
              : msg
          )
        );
      }
    } catch (err: unknown) {
      console.warn('Ollama RAG Query Error:', err);
      // Graceful local synthesis fallback
      const fallbackText = generateSimulatedResponse('ask', contextText, promptText);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
                ...msg,
                content: `${fallbackText}\n\n---\n*Ollama could not be reached at ${ollamaConfig.hostUrl}. This is a canned offline fallback, not output from your local model.*`,
              }
            : msg
        )
      );
    } finally {
      setIsSynthesizing(false);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex-1 flex flex-col md:flex-row h-[calc(100vh-3.5rem)] bg-neutral-950 overflow-hidden">
      {/* Main Chat / Synthesis Area */}
      <div className="flex-1 flex flex-col h-full border-r border-neutral-800">
        {/* Top Header */}
        <div className="px-6 py-3 border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-sm flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">Ask Your Second Brain</h2>
            <span className="text-xs text-neutral-400">·</span>
            <span className="text-xs text-neutral-400 font-mono">
              Model: {ollamaConfig.model}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {!ollamaConfig.isConnected && !ollamaConfig.isSimulatedMode && (
              <button
                onClick={onOpenOllamaSetup}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-amber-300 bg-amber-950/40 border border-amber-800/60 rounded-md hover:bg-amber-950 transition-colors"
              >
                <AlertCircle className="w-3.5 h-3.5" />
                <span>Ollama Offline (Click to configure)</span>
              </button>
            )}
            <button
              onClick={() =>
                setMessages([
                  {
                    id: 'reset',
                    role: 'assistant',
                    content: 'Synthesis session reset. Ask a new question to scan your notes.',
                    timestamp: Date.now(),
                  },
                ])
              }
              className="p-1.5 text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition-colors"
              title="Clear conversation"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Message Thread */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.map((msg) => {
            const isUser = msg.role === 'user';
            const htmlContent = renderMarkdown(msg.content);

            return (
              <div
                key={msg.id}
                className={`flex gap-3 max-w-3xl ${isUser ? 'ml-auto justify-end' : 'mr-auto justify-start'}`}
              >
                {!isUser && (
                  <div className="w-7 h-7 rounded-lg bg-neutral-900 border border-neutral-700 flex items-center justify-center shrink-0 text-emerald-400 mt-1">
                    <Brain className="w-4 h-4" />
                  </div>
                )}

                <div
                  className={`rounded-xl p-4 text-xs leading-relaxed space-y-2 ${
                    isUser
                      ? 'bg-neutral-800 text-white max-w-xl'
                      : 'bg-neutral-900 border border-neutral-800 text-neutral-200 max-w-2xl'
                  }`}
                >
                  <div
                    className="markdown-body select-text"
                    dangerouslySetInnerHTML={{ __html: htmlContent }}
                  />

                  {/* Actions for assistant response */}
                  {!isUser && msg.id !== 'welcome' && (
                    <div className="flex items-center gap-2 pt-2 border-t border-neutral-800 text-[11px] text-neutral-400">
                      <button
                        onClick={() => handleCopy(msg.id, msg.content)}
                        className="flex items-center gap-1 hover:text-white transition-colors"
                      >
                        {copiedId === msg.id ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span>{copiedId === msg.id ? 'Copied' : 'Copy'}</span>
                      </button>

                      <button
                        onClick={() =>
                          onCreateNoteFromSynthesis('AI Synthesis: Second Brain', msg.content)
                        }
                        className="flex items-center gap-1 hover:text-emerald-300 transition-colors ml-2"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Save as Note</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {isSynthesizing && (
            <div className="flex gap-3 max-w-xl items-center text-xs text-neutral-400">
              <div className="w-7 h-7 rounded-lg bg-neutral-900 border border-neutral-700 flex items-center justify-center shrink-0 text-emerald-400">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
              <div className="space-y-0.5">
                <div className="text-white font-medium">Scanning notes & generating synthesis...</div>
                <div className="text-[11px] text-neutral-500">Local model: {ollamaConfig.model}</div>
              </div>
            </div>
          )}
        </div>

        {/* Suggestion prompts if thread is short */}
        {messages.length <= 2 && (
          <div className="px-6 pb-3 shrink-0">
            <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-2">
              Suggested Questions
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {sampleQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => handleAsk(q)}
                  className="text-left p-2.5 rounded-lg bg-neutral-900 border border-neutral-800 hover:border-neutral-700 text-xs text-neutral-300 hover:text-white transition-colors line-clamp-1"
                >
                  "{q}"
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Question Input Box */}
        <div className="p-4 border-t border-neutral-800 bg-neutral-950 shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAsk();
            }}
            className="relative flex items-center"
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask anything across your Second Brain notes..."
              disabled={isSynthesizing}
              className="w-full pl-4 pr-12 py-3 bg-neutral-900 border border-neutral-800 rounded-xl text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-600 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!query.trim() || isSynthesizing}
              aria-label="Send query"
              className="absolute right-2 p-2 text-neutral-900 bg-white hover:bg-neutral-200 rounded-lg transition-colors disabled:opacity-30 disabled:hover:bg-white"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
          <div className="flex items-center justify-between mt-2 px-1 text-[11px] text-neutral-500">
            <span>Powered by your local Ollama desktop & GPT-OSS:20B</span>
            <span>Zero telemetry · 100% private</span>
          </div>
        </div>
      </div>

      {/* Grounded Note References Sidebar */}
      <div className="w-full md:w-72 border-t md:border-t-0 md:border-l border-neutral-800 bg-neutral-950 p-4 flex flex-col shrink-0 overflow-y-auto">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-4 h-4 text-neutral-400" />
          <h3 className="text-xs font-bold text-white tracking-wide uppercase">
            Retrieved Context Notes
          </h3>
        </div>

        {activeSources.length === 0 ? (
          <div className="text-xs text-neutral-500 py-6 text-center">
            Ask a question to see which notes from your Second Brain are pulled into the local LLM context.
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="text-[11px] text-neutral-400 leading-relaxed">
              These {activeSources.length} notes were fed into the model's prompt context:
            </p>

            {activeSources.map((source) => (
              <div
                key={source.id}
                onClick={() => onOpenNote(source.id)}
                className="group p-3 rounded-lg bg-neutral-900 border border-neutral-800 hover:border-neutral-700 cursor-pointer transition-colors space-y-1"
              >
                <div className="flex items-start justify-between gap-1">
                  <h4 className="text-xs font-semibold text-neutral-200 group-hover:text-white line-clamp-1">
                    {source.title}
                  </h4>
                  <ExternalLink className="w-3 h-3 text-neutral-600 group-hover:text-neutral-400 shrink-0 mt-0.5" />
                </div>
                <div className="text-[10px] text-neutral-500 font-mono capitalize">
                  {source.category}
                  {source.tags.length > 0 && ` · #${source.tags.slice(0, 2).join(' #')}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
