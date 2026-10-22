import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterNotes,
  sortNotes,
  calculateNoteStats,
  extractTagsFromText,
  calculateBrainStats,
  buildNotesContextForRag,
  exportNotesToJson,
  parseNotesFromJson,
} from './notes.ts';
import { Note } from '../types/index.ts';

const mockNotes: Note[] = [
  {
    id: 'note-1',
    title: 'Local Ollama Setup Guide',
    content: 'Running gpt-oss:20b locally gives full privacy and zero token cost. #ollama #local-ai',
    category: 'projects',
    tags: ['ollama', 'local-ai'],
    isPinned: true,
    createdAt: 1000,
    updatedAt: 3000,
  },
  {
    id: 'note-2',
    title: 'Daily Deep Work Routine',
    content: 'Focus blocks in the morning from 8 to 11am. Turn off notifications. #focus',
    category: 'tasks',
    tags: ['focus', 'routine'],
    isPinned: false,
    createdAt: 2000,
    updatedAt: 2000,
  },
  {
    id: 'note-3',
    title: 'Archive: 2025 Tech Stack',
    content: 'Old notes on legacy cloud setups. Replaced by local models.',
    category: 'archives',
    tags: ['legacy'],
    isPinned: false,
    createdAt: 500,
    updatedAt: 800,
  },
];

test('filterNotes filters correctly by query, category, and tags', () => {
  // Query search
  const queryResult = filterNotes(mockNotes, 'privacy');
  assert.equal(queryResult.length, 1);
  assert.equal(queryResult[0].id, 'note-1');

  // Category filter
  const categoryResult = filterNotes(mockNotes, '', 'tasks');
  assert.equal(categoryResult.length, 1);
  assert.equal(categoryResult[0].id, 'note-2');

  // Tag filter
  const tagResult = filterNotes(mockNotes, '', 'all', 'focus');
  assert.equal(tagResult.length, 1);
  assert.equal(tagResult[0].id, 'note-2');

  // Pinned only
  const pinnedResult = filterNotes(mockNotes, '', 'all', 'all', true);
  assert.equal(pinnedResult.length, 1);
  assert.equal(pinnedResult[0].id, 'note-1');
});

test('sortNotes orders correctly by updated, created, title, and word count', () => {
  // Pinned note should come first for 'updated'
  const sortedUpdated = sortNotes(mockNotes, 'updated');
  assert.equal(sortedUpdated[0].id, 'note-1');

  // Sort by title
  const sortedTitle = sortNotes(mockNotes, 'title');
  assert.equal(sortedTitle[0].title, 'Archive: 2025 Tech Stack');
  assert.equal(sortedTitle[1].title, 'Daily Deep Work Routine');
  assert.equal(sortedTitle[2].title, 'Local Ollama Setup Guide');
});

test('calculateNoteStats measures word count and reading time', () => {
  const statsEmpty = calculateNoteStats('');
  assert.equal(statsEmpty.words, 0);

  const stats = calculateNoteStats('One two three four five six seven eight nine ten.');
  assert.equal(stats.words, 10);
  assert.equal(stats.readingTimeMinutes, 1);
});

test('extractTagsFromText identifies hashtags accurately', () => {
  const tags = extractTagsFromText('Here are #productivity tips for #secondbrain and #ollama!');
  assert.deepEqual(tags.sort(), ['ollama', 'productivity', 'secondbrain'].sort());
});

test('calculateBrainStats produces correct aggregate metrics', () => {
  const stats = calculateBrainStats(mockNotes);
  assert.equal(stats.totalNotes, 3);
  assert.equal(stats.shelves.projects, 1);
  assert.equal(stats.shelves.tasks, 1);
  assert.equal(stats.shelves.archives, 1);
  assert.equal(stats.shelves.inbox, 0);
  assert.ok(stats.totalWords > 0);
  assert.ok(stats.totalTags >= 4);
});

test('buildNotesContextForRag finds relevant notes for query', () => {
  const { contextText, relevantNoteIds } = buildNotesContextForRag(mockNotes, 'How to configure Ollama?');
  assert.ok(relevantNoteIds.includes('note-1'));
  assert.ok(contextText.includes('Local Ollama Setup Guide'));
});

test('exportNotesToJson and parseNotesFromJson roundtrip successfully', () => {
  const json = exportNotesToJson(mockNotes);
  const parsed = parseNotesFromJson(json);
  assert.ok(parsed !== null);
  assert.equal(parsed?.length, 3);
  assert.equal(parsed?.[0].title, mockNotes[0].title);
});

test('parseNotesFromJson normalizes malformed imported notes instead of crashing', () => {
  const parsed = parseNotesFromJson(
    JSON.stringify([
      { id: 'note-minimal', title: 'Only required fields' },
      {
        id: 'note-partial',
        title: 'Partial note',
        content: 42,
        category: 'not-a-category',
        tags: ['#Ollama', 'ollama', 7, ' local-ai '],
        isPinned: 'yes',
        createdAt: 'yesterday',
      },
      { title: 'Missing id' },
      null,
    ])
  );

  assert.ok(parsed !== null);
  assert.equal(parsed?.length, 2);

  const minimal = parsed?.find((note) => note.id === 'note-minimal');
  assert.ok(minimal);
  assert.equal(minimal?.content, '');
  assert.equal(minimal?.category, 'inbox');
  assert.deepEqual(minimal?.tags, []);
  assert.equal(minimal?.isPinned, false);
  assert.ok((minimal?.createdAt ?? 0) > 0);

  const partial = parsed?.find((note) => note.id === 'note-partial');
  assert.ok(partial);
  assert.equal(partial?.content, '');
  assert.equal(partial?.category, 'inbox');
  assert.deepEqual(partial?.tags, ['ollama', 'local-ai']);
  assert.equal(partial?.isPinned, false);
  assert.equal(partial?.updatedAt, partial?.createdAt);
});

test('old shelves move: areas to projects, resources to archives, rulings to laws', () => {
  const notes = parseNotesFromJson(JSON.stringify([
    { id: 'a', title: 'A', category: 'areas', tags: [] },
    { id: 'r', title: 'R', category: 'resources', tags: [] },
    { id: 'l', title: 'L', category: 'resources', tags: ['ruling'] },
    { id: 'w', title: 'W', category: 'worlds', tags: [] },
    { id: 'x', title: 'X', category: 'nonsense', tags: [] },
  ]))!;
  assert.deepEqual(notes.map((n) => n.category), ['projects', 'archives', 'laws', 'worlds', 'inbox']);
});
