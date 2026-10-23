import { useEffect, useRef, useState } from 'react';
import { DEFAULT_MODEL, getEngine, setEngine, speak, transcribe, Progress } from './engine.ts';
import { decodeTo16k } from './audio.ts';
import '../types/desktop.ts';

declare global {
  interface Window {
    /** for tests: swap the Whisper engine for a stand-in */
    __secondbrainVoice?: { setEngine: typeof setEngine; decodeTo16k: typeof decodeTo16k };
  }
}
if (typeof window !== 'undefined') window.__secondbrainVoice = { setEngine, decodeTo16k };

function b64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export interface VoiceSettings {
  speakReplies: boolean;
  whisperModel: string;
}

/** Voice settings, plus transcribing the voice notes Telegram sends in. */
export function useVoiceSettings(): [VoiceSettings, (v: Partial<VoiceSettings>) => void] {
  const desk = typeof window !== 'undefined' ? window.secondbrainDesktop : undefined;
  const [v, setV] = useState<VoiceSettings>({ speakReplies: false, whisperModel: DEFAULT_MODEL });
  const latest = useRef(v);
  latest.current = v;

  useEffect(() => {
    desk?.settings?.get().then((s) => setV({ ...latest.current, ...(s.voice as Partial<VoiceSettings>) }));
    return desk?.voice?.onTranscribe(async (job) => {
      try {
        const text = await transcribe(b64ToBuffer(job.bytes), latest.current.whisperModel);
        desk.voice!.result(job.id, text);
      } catch (e) {
        desk.voice!.result(job.id, '', e instanceof Error ? e.message : String(e));
      }
    });
  }, [desk]);

  const update = (patch: Partial<VoiceSettings>) => {
    setV((x) => ({ ...x, ...patch }));
    desk?.settings?.set('voice', patch as Record<string, unknown>);
  };
  return [v, update];
}

export type RecState = 'idle' | 'recording' | 'transcribing' | 'loading-model';

/** Hold-to-talk style recorder: start(), stop() → text via onText. */
export function useRecorder(model: string, onText: (text: string) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<RecState>('idle');
  const [progress, setProgress] = useState<string>('');
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const onProgress: Progress = (p) => {
    if (p.status === 'progress' && p.file && p.progress != null) setProgress(`${p.file.split('/').pop()} ${Math.round(p.progress)}%`);
  };

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const bytes = await new Blob(chunks.current, { type: r.mimeType }).arrayBuffer();
        try {
          setState('loading-model');
          await getEngine(model, onProgress);
          setState('transcribing');
          const text = await transcribe(bytes, model);
          if (text) onText(text);
          else onError('No speech heard.');
        } catch (e) {
          onError(`Speech-to-text failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setState('idle');
          setProgress('');
        }
      };
      rec.current = r;
      r.start();
      setState('recording');
    } catch (e) {
      onError(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}. Check Windows Settings → Privacy → Microphone.`);
    }
  };

  const stop = () => {
    if (rec.current && rec.current.state === 'recording') rec.current.stop();
  };

  return { state, progress, start, stop };
}

export { speak };
