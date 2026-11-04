import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Note } from '../types/index.ts';
import { exportNotesToJson } from './notes.ts';
import { askAboutNote, initialNotes, notesShown, parseTags, removeNoteConfirmed, shelfCounts, shortDate } from './notesView.ts';

// The operator, 2026-11-04: "the notes tab makes sense if its organized and working properly, right now its a junky
// mess", and "steward is the note taker". Shelves with counts, a search, a plain list newest first, a reader with
// one Edit switch; the vault folder is the store.

const note = (id: string, category: string, updatedAt: number, extra: Partial<Note> = {}): Note => ({
  id,
  title: `Title ${id}`,
  content: `body of ${id}`,
  category: category as Note['category'],
  tags: [],
  isPinned: false,
  createdAt: 0,
  updatedAt,
  ...extra,
});

const notes = [
  note('a', 'projects', 100, { title: 'Steward plan', isPinned: true }),
  note('b', 'inbox', 300, { content: 'remember the router' }),
  note('c', 'projects', 200, { tags: ['harness'] }),
  note('d', 'laws', 50),
];

test('with a vault present the window starts with no starter notes', () => {
  const starter = [note('seed', 'inbox', 1)];
  assert.deepEqual(initialNotes(null, true, starter), [], 'the vault loads its own notes');
  assert.deepEqual(initialNotes('[]', true, starter), []);
  assert.deepEqual(initialNotes('not json', true, starter), []);
  assert.deepEqual(initialNotes(null, false, starter), starter, 'a browser with no vault still gets the starter notes');
  const kept = initialNotes(exportNotesToJson([notes[1]]), true, starter);
  assert.deepEqual(kept.map((n) => n.id), ['b'], 'what the window kept last time is still shown');
});

test('the shelves carry their counts, All first', () => {
  const counts = Object.fromEntries(shelfCounts(notes).map((s) => [s.id, s.count]));
  assert.equal(shelfCounts(notes)[0].id, 'all');
  assert.equal(counts.all, 4);
  assert.equal(counts.projects, 2);
  assert.equal(counts.inbox, 1);
  assert.equal(counts.laws, 1);
  assert.equal(counts.archives, 0);
});

test('the list is one shelf, narrowed by the search, newest first (a pin does not jump the order)', () => {
  assert.deepEqual(notesShown(notes, '', 'all').map((n) => n.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(notesShown(notes, '', 'projects').map((n) => n.id), ['c', 'a']);
  assert.deepEqual(notesShown(notes, 'router', 'all').map((n) => n.id), ['b'], 'search reads the text');
  assert.deepEqual(notesShown(notes, 'harness', 'all').map((n) => n.id), ['c'], 'and the tags');
  assert.deepEqual(notesShown(notes, 'steward', 'inbox'), [], 'within the shelf only');
  // a note on an old shelf is listed where it is counted
  const legacy = [note('e', 'areas', 10)];
  assert.deepEqual(notesShown(legacy, '', 'projects').map((n) => n.id), ['e']);
  assert.equal(shelfCounts(legacy).find((s) => s.id === 'projects')?.count, 1);
});

test('a delete asks first, and a no deletes nothing', () => {
  const asked: string[] = [];
  assert.equal(removeNoteConfirmed(notes, 'b', (m) => (asked.push(m), false)), null);
  assert.match(asked[0], /^Delete "Title b"\?/);
  assert.deepEqual(removeNoteConfirmed(notes, 'b', () => true)?.map((n) => n.id), ['a', 'c', 'd']);
  let called = false;
  assert.equal(removeNoteConfirmed(notes, 'missing', () => (called = true)), null);
  assert.equal(called, false, 'nothing to ask about a note that is not there');
});

test('short dates, tags typed on one line, and the Ask Steward message', () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  assert.match(shortDate(new Date(2026, 10, 4, 9, 5).getTime(), now), /^9:05\sAM$/);
  assert.equal(shortDate(new Date(2026, 10, 3).getTime(), now), 'Nov 3');
  assert.equal(shortDate(new Date(2025, 0, 2).getTime(), now), 'Jan 2, 2025');
  assert.deepEqual(parseTags(' a, #B  c,,a '), ['a', 'b', 'c']);
  assert.equal(askAboutNote({ id: 'x-1', title: 'Plan' }), 'About the note "Plan" (id x-1): ');
});

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the removed controls stay removed, and the tab is wired through these helpers', () => {
  const app = read('../App.tsx');
  const sidebar = read('../components/Sidebar.tsx');
  const list = read('../components/NotesList.tsx');
  const editor = read('../components/NoteEditor.tsx');
  const tab = [app, sidebar, list, editor].join('\n');
  // Reset-all and the JSON import/export duplicated the vault
  for (const gone of ['handleResetSeedNotes', 'onResetSeedNotes', 'handleExportNotes', 'handleImportNotes', 'accept=".json"', '>Reset<', '>Export<', '>Import<']) {
    assert.ok(!tab.includes(gone), `${gone} is gone`);
  }
  // the AI buttons answered with simulations when no model was there
  for (const gone of ['generateSimulatedResponse', 'queryOllama', 'Summarize', 'Action Items', 'Simulated Fallback', 'Offline Demo']) {
    assert.ok(!tab.includes(gone), `${gone} is gone`);
  }
  // one switch, read or edit; no split view; no separate mobile view switch
  assert.ok(!/'split'|'preview'|viewMode/.test(editor), 'no three-way view mode');
  assert.ok(!/mobileNotesView|onToggleMobileMenu/.test(app + read('../components/Header.tsx')), 'no mobile view switch');
  assert.equal((editor.match(/aria-pressed=\{editing\}/g) || []).length, 1, 'the one Edit switch');
  // the wires: starter notes only through initialNotes, deletes only through removeNoteConfirmed
  assert.match(app, /initialNotes\(saved, Boolean\(window\.secondbrainDesktop\?\.vault\), INITIAL_SEED_NOTES\)/);
  assert.equal((app.match(/INITIAL_SEED_NOTES/g) || []).length, 2, 'imported once, used once');
  assert.match(app, /removeNoteConfirmed\(notes, id, \(message\) => window\.confirm\(message\)\)/);
  assert.ok(!/setNotes\(\(prev\) => prev\.filter/.test(app), 'no delete that skips the question');
  assert.match(app, /notesShown\(notes, searchQuery, shelf\)/);
  assert.match(app, /shelfCounts\(notes\)/);
  // Ask Steward reaches the Agent tab's message box
  assert.match(app, /draft=\{agentDraft\}/);
  assert.match(read('../components/AgentView.tsx'), /if \(draft\) setInput\(draft\.text\)/);
  // long titles and text wrap or truncate instead of widening the window
  assert.match(editor, /markdown-body agent-md/);
  assert.match(list, /flex-1 min-w-0 truncate/);
});
