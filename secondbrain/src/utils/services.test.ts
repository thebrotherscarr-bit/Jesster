import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindWord, lastLines, statusTone, statusWord } from './services.ts';

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
