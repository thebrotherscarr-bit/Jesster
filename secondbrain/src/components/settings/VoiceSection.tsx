import React, { useEffect, useState } from 'react';
import { Mic } from 'lucide-react';
import { VoiceSettings } from '../../voice/useVoice.ts';
import '../../types/desktop.ts';

/** Voice: speech-to-text on this machine's whisper.cpp, replies read aloud. */
export const VoiceSection: React.FC<{ voice: VoiceSettings; onChange: (v: Partial<VoiceSettings>) => void }> = ({ voice, onChange }) => {
  const [where, setWhere] = useState<string | null>(null);
  const [model, setModel] = useState(voice.whisperModel);
  const desk = typeof window !== 'undefined' ? window.secondbrainDesktop : undefined;

  const check = async () => {
    if (!desk?.voice?.where) {
      setWhere('Speech-to-text runs in the SecondBrain desktop app.');
      return;
    }
    const w = await desk.voice.where();
    setWhere(w.error ? w.error : `whisper.cpp: ${w.bin}\nmodel: ${w.model}`);
  };

  useEffect(() => {
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.whisperModel]);

  return (
    <section className="px-5 py-4 border-b border-neutral-900 space-y-3" aria-label="Voice">
      <div className="flex items-center gap-2 text-white text-sm font-medium">
        <Mic className="w-4 h-4 text-rose-400" /> Voice
      </div>
      <p className="text-xs text-neutral-400">
        Talk to the agent with the mic button in the Agent tab, and send Telegram voice notes. Speech is turned into
        text by whisper.cpp on this machine (the one Manjuel uses, in its <code>bin</code> folder): nothing is
        downloaded. Replies can be read aloud with Windows' own voices.
      </p>
      <label className="flex items-center gap-2 text-xs text-neutral-200">
        <input type="checkbox" checked={voice.speakReplies} aria-label="Read replies aloud" onChange={(e) => onChange({ speakReplies: e.target.checked })} />
        Read the agent's replies aloud
      </label>
      <div className="flex gap-2">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => onChange({ whisperModel: model.trim() })}
          placeholder="ggml model (.bin): blank = found beside whisper-cli"
          aria-label="whisper.cpp model"
          className="flex-1 rounded-lg bg-neutral-900 border border-neutral-800 px-2.5 py-1.5 text-xs text-white"
        />
        <button onClick={check} className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs text-white">
          Check
        </button>
      </div>
      {where && <p className="text-xs text-neutral-300 whitespace-pre-wrap">{where}</p>}
    </section>
  );
};
