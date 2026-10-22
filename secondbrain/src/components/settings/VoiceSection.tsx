import React, { useState } from 'react';
import { Mic } from 'lucide-react';
import { getEngine } from '../../voice/engine.ts';
import { VoiceSettings } from '../../voice/useVoice.ts';

/** Voice: Whisper speech-to-text in the app, replies read aloud. */
export const VoiceSection: React.FC<{ voice: VoiceSettings; onChange: (v: Partial<VoiceSettings>) => void }> = ({ voice, onChange }) => {
  const [status, setStatus] = useState<string | null>(null);
  const [model, setModel] = useState(voice.whisperModel);

  const prepare = async () => {
    setStatus('Starting…');
    try {
      await getEngine(model, (p) => {
        if (p.status === 'progress' && p.file && p.progress != null) setStatus(`Downloading ${p.file.split('/').pop()}: ${Math.round(p.progress)}%`);
      });
      setStatus('Ready. Speech-to-text now works offline.');
    } catch (e) {
      setStatus(`Could not load the model: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Voice">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <Mic className="w-4 h-4 text-rose-400" /> Voice
      </div>
      <p className="text-xs text-neutral-400">
        Talk to the agent with the mic button in the Agent tab, and send Telegram voice notes. Speech is turned into
        text by Whisper running inside this app: the model (about 80 MB) downloads once from Hugging Face, then works
        offline. Replies can be read aloud with Windows' own voices.
      </p>
      <label className="flex items-center gap-2 text-xs text-neutral-200">
        <input type="checkbox" checked={voice.speakReplies} aria-label="Read replies aloud" onChange={(e) => onChange({ speakReplies: e.target.checked })} />
        Read the agent's replies aloud
      </label>
      <div className="flex gap-2">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => onChange({ whisperModel: model.trim() || voice.whisperModel })}
          aria-label="Whisper model"
          className="flex-1 rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white"
        />
        <button onClick={prepare} className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs text-white">
          Download model now
        </button>
      </div>
      <p className="text-[11px] text-neutral-500">
        Larger models are more accurate and slower: <code>onnx-community/whisper-tiny.en</code>, <code>whisper-base.en</code> (default),{' '}
        <code>whisper-small.en</code>; drop <code>.en</code> for other languages.
      </p>
      {status && <p className="text-xs text-neutral-300">{status}</p>}
    </section>
  );
};
