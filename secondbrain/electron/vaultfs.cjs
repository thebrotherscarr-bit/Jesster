/**
 * Notes as files, for the desktop app.
 *
 * Every note is one Markdown file, <id>.md, in a folder you can open in
 * Explorer — the same format the notes kernel writes (notes/kernel.py), so the
 * desktop app, the kernel, the CLI and agents can all share one folder.
 *
 *   ---
 *   id: note-…
 *   title: "…"
 *   category: inbox
 *   pinned: false
 *   tags: [a, b]
 *   created: 2026-10-21T22:00:00+0000
 *   updated: 2026-10-21T22:00:00+0000
 *   ---
 *
 *   body
 *
 * Also: turning documents from anywhere on the PC into notes (text, Markdown,
 * Word .docx, HTML, code). Node's standard library only.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CATEGORIES = ['projects', 'areas', 'resources', 'archives', 'inbox'];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_IMPORT = 5 * 1024 * 1024;
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.text', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
  '.ini', '.cfg', '.toml', '.rtf',
]);
const CODE_EXT = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx', '.py': 'python',
  '.ps1': 'powershell', '.sh': 'bash', '.bat': 'bat', '.cmd': 'bat', '.cs': 'csharp', '.java': 'java',
  '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.css': 'css', '.sql': 'sql',
};
const SUPPORTED = [...TEXT_EXT, ...Object.keys(CODE_EXT), '.docx', '.html', '.htm'];

// ---------------------------------------------------------------- times --

function stamp(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const local = new Date(ms + off * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(Math.trunc(off / 60))}${pad(off % 60)}`;
}

function toMs(s, fallback) {
  const t = Date.parse(String(s || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(t) ? t : fallback;
}

// ------------------------------------------------------- note <-> file --

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'note';
}

function parseFile(raw, id, mtimeMs) {
  let meta = {};
  let body = raw;
  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const text = raw.replace(/\r\n/g, '\n');
    const end = text.indexOf('\n---', 4);
    if (end !== -1) {
      body = text.slice(end + 4).replace(/^\n+/, '');
      for (const line of text.slice(4, end).split('\n')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        let v = line.slice(i + 1).trim();
        if (k === 'tags') {
          v = v.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        } else if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
          try {
            v = JSON.parse(v);
          } catch {
            v = v.slice(1, -1);
          }
        }
        meta[k] = v;
      }
    }
  }
  const created = toMs(meta.created, mtimeMs);
  return {
    id,
    title: meta.title || id.replace(/-/g, ' '),
    content: body,
    category: CATEGORIES.includes(meta.category) ? meta.category : 'inbox',
    tags: Array.isArray(meta.tags) ? meta.tags.map((t) => t.toLowerCase()) : [],
    isPinned: String(meta.pinned).toLowerCase() === 'true',
    createdAt: created,
    updatedAt: toMs(meta.updated, created),
  };
}

function renderFile(n) {
  const title = JSON.stringify(String(n.title || '').replace(/\n/g, ' '));
  return (
    `---\nid: ${n.id}\ntitle: ${title}\ncategory: ${n.category || 'inbox'}\n` +
    `pinned: ${n.isPinned ? 'true' : 'false'}\ntags: [${(n.tags || []).join(', ')}]\n` +
    `created: ${stamp(n.createdAt || Date.now())}\nupdated: ${stamp(n.updatedAt || Date.now())}\n---\n\n` +
    `${n.content || ''}`
  );
}

/** A file name for a note id the app made; anything unsafe gets a fresh id. */
function safeId(id, title) {
  if (ID.test(id)) return id;
  return `${slug(title)}-${crypto.randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------- vault --

class Vault {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!ID.test(id)) throw new Error(`not a note id: ${id}`);
    return path.join(this.dir, `${id}.md`);
  }

  load() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.md')) continue;
      const id = name.slice(0, -3);
      if (!ID.test(id)) continue;
      const p = path.join(this.dir, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        out.push(parseFile(fs.readFileSync(p, 'utf8'), id, st.mtimeMs));
      } catch {
        /* a file mid-write by another program: next load picks it up */
      }
    }
    return out;
  }

  save(note) {
    const p = this.file(note.id);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, renderFile(note), 'utf8');
    fs.renameSync(tmp, p);
  }

  /** Removed notes are moved aside into .trash, never destroyed. */
  remove(id) {
    const p = this.file(id);
    if (!fs.existsSync(p)) return;
    const trash = path.join(this.dir, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(p, path.join(trash, `${id}.${Date.now()}.md`));
  }
}

// ------------------------------------------------- documents -> notes --

/** The bytes of one entry in a zip (a .docx is a zip). */
function zipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`zip method ${method} not supported`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** The text of a Word document, a paragraph per line, headings as #. */
function docxText(buf) {
  const xml = zipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('no word/document.xml inside');
  const paras = [];
  for (const m of xml.toString('utf8').matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const heading = /<w:pStyle w:val="(?:Heading|heading)(\d)"/.exec(p);
    const list = /<w:numPr[\s/>]/.test(p);
    let text = '';
    for (const r of p.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      text += r[0] === '<w:tab/>' ? '\t' : r[0] === '<w:br/>' ? '\n' : decodeEntities(r[1]);
    }
    if (!text.trim()) {
      paras.push('');
      continue;
    }
    paras.push(heading ? `${'#'.repeat(Number(heading[1]))} ${text}` : list ? `- ${text}` : text);
  }
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function htmlText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One document from the PC as a note (not saved yet), or { skipped, why }.
 * `now` is injectable for tests.
 */
function importFile(file, now = Date.now()) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, path.extname(file));
  const st = fs.statSync(file);
  if (!st.isFile()) return { skipped: file, why: 'not a file' };
  if (st.size > MAX_IMPORT) return { skipped: file, why: 'over 5 MB' };
  if (ext === '.pdf') return { skipped: file, why: 'PDF is not supported yet' };
  if (!SUPPORTED.includes(ext)) return { skipped: file, why: `${ext || 'no extension'} is not a document type this reads` };
  const buf = fs.readFileSync(file);
  let content;
  let title = base;
  if (ext === '.docx') content = docxText(buf);
  else if (ext === '.html' || ext === '.htm') content = htmlText(buf.toString('utf8'));
  else {
    if (buf.includes(0)) return { skipped: file, why: 'looks like a binary file' };
    const text = buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    if (ext === '.md' || ext === '.markdown') {
      const n = parseFile(text, 'x', st.mtimeMs);
      content = n.content;
      if (text.startsWith('---') && n.title !== 'x') title = n.title;
    } else if (CODE_EXT[ext]) {
      content = '```' + CODE_EXT[ext] + '\n' + text.replace(/\n+$/, '') + '\n```';
    } else {
      content = text;
    }
  }
  const h1 = /^#\s+(.+)$/m.exec(content || '');
  if (h1 && title === base) title = h1[1].trim();
  const id = `doc-${slug(base).slice(0, 40)}-${crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 6)}`;
  return {
    note: {
      id,
      title,
      content: `> imported from \`${file}\`\n\n${content || ''}`,
      category: 'resources',
      tags: ['imported', ext.slice(1)],
      isPinned: false,
      createdAt: st.mtimeMs || now,
      updatedAt: now,
    },
  };
}

module.exports = { Vault, parseFile, renderFile, safeId, importFile, docxText, htmlText, zipEntry, stamp, SUPPORTED };
