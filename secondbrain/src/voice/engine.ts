/**
 * Speech-to-text with Whisper, running inside the app (transformers.js on
 * ONNX Runtime WebAssembly). The model downloads once from Hugging Face on
 * first use, then works offline. Tests replace the engine with setEngine.
 */
import { decodeTo16k } from './audio.ts';
// ONNX Runtime's WebAssembly, bundled with the app (no CDN, works offline);
// its JavaScript half is already inside the bundled runtime
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

export type Engine = (samples: Float32Array) => Promise<string>;
export type Progress = (p: { status: string; file?: string; progress?: number }) => void;

export const DEFAULT_MODEL = 'onnx-community/whisper-base.en';

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;
let loadedModel = '';

export function setEngine(e: Engine | null) {
  engine = e;
  loading = null;
}

export async function getEngine(model = DEFAULT_MODEL, onProgress?: Progress): Promise<Engine> {
  if (engine && (loadedModel === model || !loadedModel)) return engine;
  if (loading && loadedModel === model) return loading;
  loadedModel = model;
  loading = (async () => {
    const tf = await import('@huggingface/transformers');
    const onnx = tf.env.backends.onnx as unknown as { wasm: { wasmPaths: unknown; numThreads: number } };
    onnx.wasm.wasmPaths = { wasm: new URL(ortWasm, window.location.href).href };
    onnx.wasm.numThreads = 1; // threads need cross-origin isolation, which this page does not have
    tf.env.allowLocalModels = false;
    const asr = await tf.pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: onProgress as never,
    });
    const run: Engine = async (samples) => {
      const out = (await asr(samples, { chunk_length_s: 30, stride_length_s: 5 })) as { text: string } | { text: string }[];
      return (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
    };
    engine = run;
    return run;
  })();
  try {
    return await loading;
  } catch (e) {
    loading = null;
    loadedModel = '';
    throw e;
  }
}

/** Audio bytes (any format the browser can decode) → text. */
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
