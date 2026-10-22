/**
 * Speech-to-text on this machine's own whisper.cpp, through the desktop app's main
 * process (electron/whisper.cjs): the page decodes the audio to 16 kHz mono samples and
 * hands them over. Nothing is downloaded -- Kyle's word, 2026-10-22: "swap out that fetch
 * for our local model we already have" (it used to fetch a Whisper model from Hugging
 * Face). Outside the desktop app there is no whisper.cpp to reach, and it says so.
 * Tests replace the engine with setEngine.
 */
import { decodeTo16k } from './audio.ts';
import '../types/desktop.ts';

export type Engine = (samples: Float32Array) => Promise<string>;
export type Progress = (p: { status: string; file?: string; progress?: number }) => void;

/** '' = whisper.cpp's model as the desktop app finds it (Settings -> Voice can name a ggml .bin). */
export const DEFAULT_MODEL = '';

let engine: Engine | null = null;

export function setEngine(e: Engine | null) {
  engine = e;
}

/** The engine: the desktop app's local whisper.cpp. `model` and `onProgress` are kept for
 * callers; there is nothing to download, so there is no progress to report. */
export async function getEngine(_model = DEFAULT_MODEL, _onProgress?: Progress): Promise<Engine> {
  if (engine) return engine;
  const local = typeof window !== 'undefined' ? window.secondbrainDesktop?.voice?.local : undefined;
  if (!local) throw new Error('Speech-to-text runs in the SecondBrain desktop app, on its local whisper.cpp.');
  return (samples) => local(samples);
}

/** Audio bytes (any format the browser can decode) -> text. */
export async function transcribe(bytes: ArrayBuffer, model?: string, onProgress?: Progress): Promise<string> {
  const samples = await decodeTo16k(bytes);
  const run = await getEngine(model, onProgress);
  return run(samples);
}

/** Read text aloud with the system's voices (offline on Windows). */
export function speak(text: string) {
  if (!('speechSynthesis' in window)) return;
  const plain = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/[`*_#>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .slice(0, 4000);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(plain));
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
