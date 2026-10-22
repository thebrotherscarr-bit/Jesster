const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const whisper = require('./whisper.cjs');

function ground() {
  // <tmp>/bin/{whisper-cli.exe, ggml-base.en.bin}, and a vault two folders down, as Research is laid out
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'whisper-cli.exe'), '');
  fs.writeFileSync(path.join(root, 'bin', 'ggml-tiny.en.bin'), '');
  fs.writeFileSync(path.join(root, 'bin', 'ggml-base.en.bin'), '');
  const vault = path.join(root, 'worlds', 'notes');
  fs.mkdirSync(vault, { recursive: true });
  return { root, vault };
}

test('whisper.cpp is found up the folders from the vault, base.en preferred', () => {
  const { root, vault } = ground();
  const w = whisper.find({ vaultDir: vault });
  assert.equal(w.bin, path.join(root, 'bin', 'whisper-cli.exe'));
  assert.equal(w.model, path.join(root, 'bin', 'ggml-base.en.bin'));
});

test('Settings win, and a model setting that is not a .bin (the old Hugging Face name) is ignored', () => {
  const { root, vault } = ground();
  const mine = path.join(root, 'bin', 'ggml-tiny.en.bin');
  assert.equal(whisper.find({ vaultDir: vault, voice: { whisperModel: mine } }).model, mine);
  assert.equal(whisper.find({ vaultDir: vault, voice: { whisperModel: 'onnx-community/whisper-base.en' } }).model,
    path.join(root, 'bin', 'ggml-base.en.bin'));
});

test('nothing found is said plainly, and nothing is downloaded', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhisper-'));
  const saved = [process.env.SECONDBRAIN_WHISPER_CLI, process.env.SECONDBRAIN_WHISPER_GGML];
  delete process.env.SECONDBRAIN_WHISPER_CLI;
  delete process.env.SECONDBRAIN_WHISPER_GGML;
  try {
    assert.match(whisper.find({ vaultDir: empty, appDir: empty }).error, /whisper\.cpp was not found/);
  } finally {
    if (saved[0] !== undefined) process.env.SECONDBRAIN_WHISPER_CLI = saved[0];
    if (saved[1] !== undefined) process.env.SECONDBRAIN_WHISPER_GGML = saved[1];
  }
});

test('samples become a 16 kHz mono 16-bit WAV', () => {
  const wav = whisper.wavBytes(new Float32Array([0, 1, -1, 2]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => wav.readInt16LE(44 + i * 2)), [0, 32767, -32767, 32767]);
});

test('a silent clip is no speech, and whisper is never asked (it invents words on silence)', async () => {
  let asked = false;
  const text = await whisper.transcribe(new Float32Array(16000), {}, async () => { asked = true; return 'you'; });
  assert.equal(text, '');
  assert.equal(asked, false);
});

test('transcribe hands whisper-cli the model and a WAV, cleans the text, and leaves no file behind', async () => {
  const { vault } = ground();
  let seen = null;
  const speech = Float32Array.from({ length: 1600 }, (_, i) => 0.3 * Math.sin(i / 5));
  const text = await whisper.transcribe(speech, { vaultDir: vault }, async (bin, args) => {
    seen = { bin, args, wav: args[args.indexOf('-f') + 1] };
    assert.ok(fs.existsSync(seen.wav), 'the WAV is there while whisper reads it');
    return ' [BLANK_AUDIO]\n Hello   there. \n';
  });
  assert.equal(text, 'Hello there.');
  assert.ok(seen.bin.endsWith('whisper-cli.exe'));
  assert.deepEqual(seen.args.filter((a) => a.startsWith('-')), ['-m', '-f', '-l', '--no-timestamps', '--no-prints']);
  assert.ok(!fs.existsSync(seen.wav), 'the temp WAV is removed');
});
