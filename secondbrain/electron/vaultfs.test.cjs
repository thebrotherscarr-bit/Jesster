const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Vault, parseFile, renderFile, safeId, importFile, docxText } = require('./vaultfs.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vaultfs-'));

/** A minimal .docx: a zip holding word/document.xml. */
function makeDocx(xml) {
  const name = Buffer.from('word/document.xml');
  const data = zlib.deflateRawSync(Buffer.from(xml));
  const raw = Buffer.from(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdStart = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

test('a note survives the round trip through its file', () => {
  const n = {
    id: 'note-1', title: 'Plan: "ship it"', content: 'body\n\nmore', category: 'projects',
    tags: ['a', 'b'], isPinned: true, createdAt: Date.UTC(2026, 0, 2, 3, 4, 5), updatedAt: Date.UTC(2026, 0, 3),
  };
  const back = parseFile(renderFile(n), 'note-1', 0);
  assert.deepEqual(back, n);
});

test('files written by the notes kernel read the same way', () => {
  const raw = '---\nid: k\ntitle: "From the kernel"\ncategory: areas\npinned: false\ntags: [x]\n' +
    'created: 2026-10-21T21:00:54+0000\nupdated: 2026-10-21T14:00:54-0700\n---\n\nhello';
  const n = parseFile(raw, 'k', 0);
  assert.equal(n.title, 'From the kernel');
  assert.equal(n.category, 'projects', 'an old shelf is read as its new one');
  assert.equal(n.updatedAt, Date.UTC(2026, 9, 21, 21, 0, 54));
  assert.equal(n.content, 'hello');
});

test('a plain text file with no header is still a note', () => {
  const n = parseFile('just words', 'plain', 1000);
  assert.equal(n.content, 'just words');
  assert.equal(n.createdAt, 1000);
});

test('the vault saves, loads and moves removed notes to .trash', () => {
  const dir = tmp();
  const v = new Vault(dir);
  v.save({ id: 'a', title: 'A', content: 'x', category: 'inbox', tags: [], isPinned: false, createdAt: 1, updatedAt: 2 });
  fs.writeFileSync(path.join(dir, 'Not An Id.md'), 'ignored');
  assert.deepEqual(v.load().map((n) => n.id), ['a']);
  v.remove('a');
  assert.equal(v.load().length, 0);
  assert.equal(fs.readdirSync(path.join(dir, '.trash')).length, 1);
  assert.throws(() => v.save({ id: '../escape', title: 't' }));
});

test('unsafe ids get a fresh file-safe one', () => {
  assert.equal(safeId('note-ok', 't'), 'note-ok');
  assert.match(safeId('Bad Id/..', 'My Title'), /^my-title-[0-9a-f]{6}$/);
});

test('documents from the PC become notes', () => {
  const dir = tmp();
  const md = path.join(dir, 'Meeting notes.md');
  fs.writeFileSync(md, '# Standup\r\n\r\nwe shipped');
  const r = importFile(md, 5);
  assert.equal(r.note.title, 'Standup');
  assert.match(r.note.content, /we shipped/);
  assert.deepEqual(r.note.tags, ['imported', 'md']);
  assert.match(r.note.id, /^doc-meeting-notes-[0-9a-f]{6}$/);

  const py = path.join(dir, 'tool.py');
  fs.writeFileSync(py, 'print(1)\n');
  assert.match(importFile(py).note.content, /```python\nprint\(1\)\n```/);

  const html = path.join(dir, 'page.html');
  fs.writeFileSync(html, '<html><style>x{}</style><h1>Title</h1><p>Tom &amp; Jerry</p></html>');
  const h = importFile(html).note;
  assert.equal(h.title, 'Title');
  assert.match(h.content, /Tom & Jerry/);

  const bin = path.join(dir, 'data.txt');
  fs.writeFileSync(bin, Buffer.from([1, 0, 2]));
  assert.equal(importFile(bin).why, 'looks like a binary file');
  const pdf = path.join(dir, 'a.pdf');
  fs.writeFileSync(pdf, '%PDF');
  assert.match(importFile(pdf).why, /PDF/);
});

test('Word documents: paragraphs, headings and lists', () => {
  const xml = '<w:document><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly plan</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Ship the </w:t></w:r><w:r><w:t>vault &amp; search</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>first item</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  assert.equal(docxText(makeDocx(xml)), '# Quarterly plan\nShip the vault & search\n- first item');
  const dir = tmp();
  const f = path.join(dir, 'Plan.docx');
  fs.writeFileSync(f, makeDocx(xml));
  const n = importFile(f).note;
  assert.equal(n.title, 'Quarterly plan');
  assert.deepEqual(n.tags, ['imported', 'docx']);
});

test('old shelves are moved on disk once, touching only the category line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shelves-'));
  const file = (id, cat, tags, body) =>
    fs.writeFileSync(path.join(dir, `${id}.md`), `---\r\nid: ${id}\r\ntitle: "${id}"\r\ncategory: ${cat}\r\npinned: false\r\ntags: [${tags}]\r\ncreated: 2026-01-01T00:00:00+0000\r\nupdated: 2026-01-02T00:00:00+0000\r\n---\r\n\r\n${body}`);
  file('a', 'areas', '', 'category: areas stays in the body');
  file('r', 'resources', 'chat', 'x');
  file('l', 'resources', 'ruling', 'x');
  file('t', 'tasks', '', 'x');
  const v = new Vault(dir);
  const shelf = Object.fromEntries(v.load().map((n) => [n.id, n.category]));
  assert.deepEqual(shelf, { a: 'projects', l: 'laws', r: 'archives', t: 'tasks' });
  const a = fs.readFileSync(path.join(dir, 'a.md'), 'utf8');
  assert.match(a, /\r\ncategory: projects\r\n/);
  assert.match(a, /updated: 2026-01-02T00:00:00\+0000/);
  assert.match(a, /category: areas stays in the body$/);
  const before = fs.statSync(path.join(dir, 't.md')).mtimeMs;
  v.load();
  assert.equal(fs.statSync(path.join(dir, 't.md')).mtimeMs, before, 'a note on a current shelf is not rewritten');
});
