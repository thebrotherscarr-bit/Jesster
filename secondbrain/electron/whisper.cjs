/**
 * Speech-to-text on this machine's own whisper.cpp -- no download, ever.
 *
 * Kyle's word (2026-10-22): "swap out that fetch for our local model we already have".
 * The app used transformers.js, which fetched a Whisper model from Hugging Face on first
 * use. Manjuel already carries whisper.cpp compiled offline (Research\bin\whisper-cli.exe
 * with ggml-base.en.bin), so the page hands 16 kHz mono samples to the main process, they
 * go into a temp WAV, and whisper-cli turns them into text -- the same call Manjuel's own
 * `listen` makes. Speaking stays on Windows' own voices (speechSynthesis in the page).
 *
 * Where whisper.cpp is found, first match wins:
 *   1. Settings -> Voice (whisperCli, and whisperModel when it names a .bin)
 *   2. SECONDBRAIN_WHISPER_CLI / SECONDBRAIN_WHISPER_GGML
 *   3. a bin\whisper-cli.exe up the folders from the notes vault, then from this app --
 *      Research\bin, since the vault is Research\worlds\notes
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SAMPLE_RATE = 16000;
const TIMEOUT_MS = 180000;
const BIN_NAMES = ['whisper-cli.exe', 'whisper-cli', 'main.exe'];

function isFile(p) {
  try {
    return Boolean(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The first bin\whisper-cli up the folders from `start`, with its ggml model beside it. */
function findUp(start) {
  let dir = start ? path.resolve(start) : '';
  for (let i = 0; dir && i < 6; i += 1) {
    const binDir = path.join(dir, 'bin');
    const bin = BIN_NAMES.map((n) => path.join(binDir, n)).find(isFile);
    if (bin) {
      let models = [];
      try {
        models = fs.readdirSync(binDir).filter((n) => /^ggml-.*\.bin$/i.test(n));
      } catch {
        models = [];
      }
      const model = models.includes('ggml-base.en.bin') ? 'ggml-base.en.bin' : models[0];
      return { bin, model: model ? path.join(binDir, model) : '' };
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** {bin, model} or {error}: where this machine's whisper.cpp is. */
function find({ voice = {}, vaultDir = '', appDir = '' } = {}) {
  const env = process.env;
  const setModel = /\.bin$/i.test(String(voice.whisperModel || '')) ? voice.whisperModel : '';
  let bin = voice.whisperCli || env.SECONDBRAIN_WHISPER_CLI || '';
  let model = setModel || env.SECONDBRAIN_WHISPER_GGML || '';
  if (!bin || !model) {
    const found = findUp(vaultDir) || findUp(appDir);
    if (found) {
      bin = bin || found.bin;
      model = model || found.model;
    }
  }
  if (!isFile(bin)) return { error: 'whisper.cpp was not found: set its path in Settings -> Voice (whisper-cli.exe)' };
  if (!isFile(model)) return { error: 'no whisper.cpp model (ggml-*.bin) was found beside it: set its path in Settings -> Voice' };
  return { bin, model };
}

/** 16 kHz mono float samples -> a 16-bit PCM WAV file's bytes. */
function wavBytes(samples, rate = SAMPLE_RATE) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const v = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** Bracketed noise marks ([BLANK_AUDIO], [Music]) out, whitespace folded. */
function clean(text) {
  return String(text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function runFile(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`whisper.cpp failed: ${String(stderr || err.message).split(/\s+/).join(' ').slice(0, 200)}`));
      else resolve(stdout);
    });
  });
}

/** How loud a clip is (root mean square); under SILENCE nothing was said. */
const SILENCE = 0.005;
function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Samples -> text through whisper.cpp; '' for a silent clip (Whisper invents words on
 * silence, so it is never asked). `run` is for tests. */
async function transcribe(samples, opts = {}, run = runFile) {
  if (rms(samples) < SILENCE) return '';
  const where = find(opts);
  if (where.error) throw new Error(where.error);
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secondbrain-voice-')), 'clip.wav');
  try {
    fs.writeFileSync(wav, wavBytes(samples));
    const out = await run(where.bin, ['-m', where.model, '-f', wav, '-l', 'en', '--no-timestamps', '--no-prints']);
    return clean(out);
  } finally {
    fs.rmSync(path.dirname(wav), { recursive: true, force: true });
  }
}

module.exports = { find, findUp, wavBytes, clean, rms, transcribe, SAMPLE_RATE, SILENCE };
