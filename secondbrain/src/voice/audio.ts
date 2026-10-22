/**
 * Audio for speech-to-text: any recording or voice note (WebM/Opus from the
 * mic, OGG/Opus from Telegram, WAV, MP3) decoded and resampled to the 16 kHz
 * mono samples Whisper expects.
 */
export const SAMPLE_RATE = 16000;

export async function decodeTo16k(bytes: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } finally {
    ctx.close();
  }
  const length = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
  const off = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded; // a multi-channel buffer is mixed down to the mono destination
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}
