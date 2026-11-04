import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { VoiceSettings, stopSpeaking } from '../voice/useVoice.ts';
import { flipSpeak } from '../utils/settingsMap.ts';

/**
 * Read replies aloud, on or off, in one click (the operator, 2026-11-04: "there is no way to turn off the read back out
 * loud now, is there?"). The same voice.speakReplies setting as ever; off also stops what is being read now.
 */
export const SpeakToggle: React.FC<{ voice?: VoiceSettings; onVoiceChange?: (v: Partial<VoiceSettings>) => void }> = ({ voice, onVoiceChange }) => {
  if (!voice || !onVoiceChange) return null;
  const on = voice.speakReplies;
  return (
    <button
      onClick={() => flipSpeak(on, onVoiceChange, stopSpeaking)}
      aria-pressed={on}
      aria-label={on ? 'Stop reading replies aloud' : 'Read replies aloud'}
      title={on ? 'Replies are read aloud: click to stop' : 'Replies are not read aloud: click to turn on'}
      className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md ${on ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:text-white hover:bg-neutral-900'}`}
    >
      {on ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />} {on ? 'Read aloud' : 'Muted'}
    </button>
  );
};
