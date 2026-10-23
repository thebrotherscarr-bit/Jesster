import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestionNotes, titleQuestions, suggestionPrompt, parseSuggestions } from './suggest.ts';
import { Note } from '../types/index.ts';

const note = (id: string, title: string, extra: Partial<Note> = {}): Note => ({
  id, title, content: `${title} body`, category: 'projects', tags: [], isPinned: false, createdAt: 1, updatedAt: 1, ...extra,
});

test('suggestions come from the last answer\'s notes, else recent work without dug-up archive notes', () => {
  const notes = [
    note('old', 'Old plan', { updatedAt: 1 }),
    note('new', 'Archive digger', { updatedAt: 9 }),
    note('raw', 'Git: atlas, 2026-01', { updatedAt: 99, tags: ['archive'], category: 'archives' }),
    note('pin', 'Manjuel reconcile', { updatedAt: 2, isPinned: true }),
  ];
  assert.deepEqual(suggestionNotes(notes).map((n) => n.id), ['pin', 'new', 'old']);
  assert.deepEqual(suggestionNotes(notes, [notes[0]]).map((n) => n.id), ['old']);
});

test('title questions name the notes, never repeat, and need no model', () => {
  const qs = titleQuestions([note('a', 'Archive digger', { tags: ['archive-digger', 'kernel'] }), note('b', 'Atlas glass', { tags: ['atlas'] })]);
  assert.equal(qs[0], "What's the latest on Archive digger?");
  assert.equal(qs[1], "What's still open in Atlas glass?");
  assert.match(qs[2], /archive-digger, kernel, atlas/);
  assert.deepEqual(titleQuestions([]), []);
});

test('the model is asked about these notes, and its reply is cleaned into questions', () => {
  assert.match(suggestionPrompt([note('a', 'Archive digger')]), /- Archive digger: Archive digger body/);
  const qs = parseSuggestions('Here you go:\n1. What is left before the first real dig?\n- "How long will distilling take?"\nnot a question\n• Which sources come first?\n');
  assert.deepEqual(qs, ['What is left before the first real dig?', 'How long will distilling take?', 'Which sources come first?']);
});
