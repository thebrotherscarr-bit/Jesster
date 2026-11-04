import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SETTINGS, flipSpeak } from './settingsMap.ts';

// The operator, 2026-11-04: "make sure there are no buried settings that are nested". Every setting is where
// settingsMap.ts says, and only there; nothing in the console or in a window opens another window.
const dir = new URL('../components/', import.meta.url);
const files: Record<string, string> = {};
for (const f of readdirSync(dir)) if (f.endsWith('.tsx')) files[f] = readFileSync(new URL(f, dir), 'utf8');
for (const f of readdirSync(new URL('settings/', dir))) if (f.endsWith('.tsx')) files[`settings/${f}`] = readFileSync(new URL(`settings/${f}`, dir), 'utf8');
files['App.tsx'] = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

test('every setting is rendered in its one place, and nowhere else', () => {
  for (const s of SETTINGS) {
    const where = Object.keys(files).filter((f) => new RegExp(`<${s.control}[\\s/>]`).test(files[f]));
    assert.deepEqual(where.sort(), [...s.files].sort(), `${s.control} is in ${s.files.join(' and ')} only`);
    assert.ok(s.clicks <= 2, `${s.control} is near the top`);
  }
  // the read-aloud switch is the speaker alone: no second checkbox for it
  for (const [f, text] of Object.entries(files)) if (f !== 'SpeakToggle.tsx') assert.ok(!/speakReplies:\s*e\.target/.test(text), `${f} has no second read-aloud control`);
});

test('there is one window (Settings), and nothing in the console or in a window opens another', () => {
  const windows = Object.keys(files).filter((f) => /role="dialog"|fixed inset-0 z-50 bg-black/.test(files[f]));
  assert.deepEqual(windows, ['SettingsModal.tsx'], 'the only window is Settings');
  const console = ['AgentConsole.tsx', 'ServersShelf.tsx', 'ApprovalsShelf.tsx', ...Object.keys(files).filter((f) => f.startsWith('settings/'))];
  for (const f of console) {
    assert.ok(!/<\w*Modal\b/.test(files[f]), `${f} renders no window`);
    assert.ok(!/onOpen\w*\s*[(=:]/.test(files[f]), `${f} has no button that opens a window`);
  }
  assert.ok(!/<\w*Modal\b/.test(files['SettingsModal.tsx']), 'Settings opens no window of its own');
});

test('the speaker flips speakReplies, and off stops what is being read', () => {
  const set: boolean[] = [];
  let stopped = 0;
  const update = (v: { speakReplies: boolean }) => set.push(v.speakReplies);
  assert.equal(flipSpeak(true, update, () => stopped++), false);
  assert.deepEqual(set, [false]);
  assert.equal(stopped, 1, 'turning it off stops speech now');
  assert.equal(flipSpeak(false, update, () => stopped++), true);
  assert.deepEqual(set, [false, true]);
  assert.equal(stopped, 1, 'turning it on stops nothing');
  // the button is wired to it, with the speech engine's stop
  assert.match(files['SpeakToggle.tsx'], /flipSpeak\(on, onVoiceChange, stopSpeaking\)/);
});
