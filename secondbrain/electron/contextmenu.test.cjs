const test = require('node:test');
const assert = require('node:assert');
const { template } = require('./contextmenu.cjs');

const labels = (items) => items.map((i) => i.type || i.label);

test('selected text can be copied', () => {
  assert.deepEqual(labels(template({ selectionText: 'a note', editFlags: { canCopy: true } })), ['Copy']);
});

test('a text box has cut, copy, paste and select all, enabled as Electron says', () => {
  const items = template({ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true } });
  assert.deepEqual(labels(items), ['Cut', 'Copy', 'Paste', 'separator', 'Select all']);
  assert.equal(items.find((i) => i.label === 'Paste').enabled, true);
  assert.equal(items.find((i) => i.label === 'Cut').enabled, false);
});

test('a misspelled word offers fixes first', () => {
  const items = template({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tech'], editFlags: {} });
  assert.deepEqual(labels(items).slice(0, 3), ['the', 'tech', 'separator']);
  assert.deepEqual(items[0], { label: 'the', action: 'replace', word: 'the' });
});

test('a link can be copied, and opened only if it is web', () => {
  assert.deepEqual(labels(template({ linkURL: 'https://example.com' }, { openLink: true })), ['Copy link', 'Open link in browser', 'separator', 'Select all']);
  assert.deepEqual(labels(template({ linkURL: 'file:///C:/x' }, { openLink: true })), ['Copy link', 'separator', 'Select all']);
});

test('nothing selected still gives a menu, never an empty one', () => {
  assert.deepEqual(labels(template({})), ['Select all']);
  assert.deepEqual(labels(template(null)), ['Select all']);
});
