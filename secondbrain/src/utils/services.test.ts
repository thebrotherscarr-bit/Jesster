import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindWord, lastLines, ollamaSwitch, ollamaToggle, statusTone, statusWord } from './services.ts';

test("the 'SecondBrain runs Ollama' toggle writes services.ollama.enabled, and nothing else", () => {
  assert.deepEqual(ollamaSwitch(true), ['services', { ollama: { enabled: true } }]);
  assert.deepEqual(ollamaSwitch(false), ['services', { ollama: { enabled: false } }]);
});

test('the toggle reads its state from the Ollama row, and is locked while SECONDBRAIN_RUNS_OLLAMA sets it', () => {
  assert.deepEqual(ollamaToggle({ enabled: false, override: null }), { on: false, locked: '' });
  assert.deepEqual(ollamaToggle({ enabled: true, override: null }), { on: true, locked: '' });
  assert.deepEqual(ollamaToggle({ enabled: true, override: 'on' }), { on: true, locked: 'set by SECONDBRAIN_RUNS_OLLAMA=1' });
  assert.deepEqual(ollamaToggle({ enabled: false, override: 'off' }), { on: false, locked: 'set by SECONDBRAIN_RUNS_OLLAMA=0' });
  assert.deepEqual(ollamaToggle(undefined), { on: false, locked: '' });
});

test('a server status reads as a word and a colour', () => {
  assert.equal(statusWord('up'), 'running');
  assert.equal(statusWord('down'), 'not answering');
  assert.equal(statusWord('starting'), 'starting');
  assert.equal(statusWord('held'), 'held');
  assert.equal(statusTone('up').dot, 'bg-emerald-400');
  assert.equal(statusTone('down').text, 'text-amber-400');
});

test('who runs a server, in words', () => {
  assert.equal(kindWord('owned'), 'SecondBrain runs it');
  assert.equal(kindWord('external'), 'runs outside SecondBrain');
});

test('a log is cut to its last n lines', () => {
  const log = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n';
  const cut = lastLines(log).split('\n');
  assert.equal(cut.length, 200);
  assert.equal(cut[0], 'line 51');
  assert.equal(cut[199], 'line 250');
  assert.equal(lastLines('a\nb\nc', 2), 'b\nc');
  assert.equal(lastLines('', 5), '');
  assert.equal(lastLines('a\nb', 0), '');
});
