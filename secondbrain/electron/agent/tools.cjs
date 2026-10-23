/**
 * The agent's tools. Each is { name, description, parameters (JSON Schema),
 * run(args, ctx) → string | object, risky? }. Risky tools ask the user first
 * (ctx.approve). ctx carries the vault and anything a tool group needs.
 *
 * Groups register themselves: core (notes, todo, web, time) here; memory and
 * skills, schedules, MCP, delegation and the terminal add theirs.
 */
const crypto = require('crypto');
const { htmlText } = require('../vaultfs.cjs');

const MAX_RESULT = 12000; // characters handed back to the model per call

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'note';
}

function clip(text, n = MAX_RESULT) {
  text = String(text ?? '');
  return text.length > n ? `${text.slice(0, n)}\n…(${text.length - n} more characters)` : text;
}

const STOP = new Set('a an and are as at be by did do does for from had has have how i in is it its me my of on or so that the this to was we were what when where which who why will with you your'.split(' '));

function terms(q) {
  return (String(q || '').toLowerCase().match(/[a-z0-9]{2,}/g) || []).filter((t) => !STOP.has(t));
}

/** Notes ranked for a query: title and tags weigh most, body hits are damped by length. */
function rank(notes, query, limit = 8) {
  const ts = terms(query);
  const scored = notes.map((n) => {
    const title = n.title.toLowerCase();
    const tags = n.tags.join(' ');
    const body = (n.content || '').toLowerCase();
    let score = 0;
    for (const t of ts) {
      if (title.includes(t)) score += 5;
      if (tags.includes(t)) score += 3;
      const hits = body.split(t).length - 1;
      score += hits / (1 + body.length / 3000);
    }
    return { n, score };
  });
  return scored
    .filter((s) => s.score > 0 || !ts.length)
    .sort((a, b) => b.score - a.score || b.n.updatedAt - a.n.updatedAt)
    .slice(0, limit)
    .map((s) => s.n);
}

function snippet(n, query) {
  const body = (n.content || '').replace(/\s+/g, ' ');
  const t = terms(query)[0];
  const i = t ? body.toLowerCase().indexOf(t) : -1;
  const start = Math.max(0, i - 80);
  return (start ? '…' : '') + body.slice(start, start + 240);
}

function find(ctx, id) {
  const n = ctx.vault.load().find((x) => x.id === id);
  if (!n) throw new Error(`no note with id "${id}" (use search_notes or list_notes to find ids)`);
  return n;
}

const CATEGORIES = ['projects', 'areas', 'resources', 'archives', 'inbox'];

const core = [
  {
    name: 'search_notes',
    description: "Search the user's notes (titles, tags and text). Returns ids, titles and a snippet. Use before answering anything about the user's work.",
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    run: ({ query, limit = 8 }, ctx) =>
      rank(ctx.vault.load(), query, Math.min(limit, 20)).map((n) => ({ id: n.id, title: n.title, tags: n.tags, snippet: snippet(n, query) })),
  },
  {
    name: 'read_note',
    description: 'Read one note in full by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }, ctx) => {
      const n = find(ctx, id);
      return { id: n.id, title: n.title, category: n.category, tags: n.tags, content: clip(n.content) };
    },
  },
  {
    name: 'list_notes',
    description: 'List notes, newest first, optionally filtered by category (projects, areas, resources, archives, inbox) or tag.',
    parameters: { type: 'object', properties: { category: { type: 'string' }, tag: { type: 'string' }, limit: { type: 'integer' } } },
    run: ({ category, tag, limit = 25 }, ctx) =>
      ctx.vault
        .load()
        .filter((n) => (!category || n.category === category) && (!tag || n.tags.includes(tag)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, Math.min(limit, 100))
        .map((n) => ({ id: n.id, title: n.title, category: n.category, tags: n.tags })),
  },
  {
    name: 'write_note',
    description: 'Create a note, or replace an existing note (give its id). Content is Markdown. Category is one of projects, areas, resources, archives, inbox.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'existing note id to replace; omit to create' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        category: { type: 'string' },
      },
      required: ['title', 'content'],
    },
    run: ({ id, title, content, tags, category }, ctx) => {
      const now = Date.now();
      const old = id ? ctx.vault.load().find((x) => x.id === id) : null;
      const note = {
        id: old ? old.id : `${slug(title)}-${crypto.randomBytes(3).toString('hex')}`,
        title,
        content,
        tags: (tags || old?.tags || []).map((t) => String(t).replace(/^#/, '').toLowerCase()),
        category: CATEGORIES.includes(category) ? category : old?.category || 'inbox',
        isPinned: old?.isPinned || false,
        createdAt: old?.createdAt || now,
        updatedAt: now,
      };
      ctx.vault.save(note);
      ctx.touched?.(note.id);
      return { saved: note.id, created: !old };
    },
  },
  {
    name: 'append_to_note',
    description: 'Add text to the end of an existing note.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
    run: ({ id, text }, ctx) => {
      const n = find(ctx, id);
      ctx.vault.save({ ...n, content: `${n.content.replace(/\s+$/, '')}\n\n${text}`, updatedAt: Date.now() });
      ctx.touched?.(n.id);
      return { appended: n.id };
    },
  },
  {
    name: 'todo',
    description: "The user's todo list (one note, id 'todo'). action: list, add (text), done (index or text), remove (index or text).",
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'add', 'done', 'remove'] }, text: { type: 'string' }, index: { type: 'integer' } },
      required: ['action'],
    },
    run: ({ action, text, index }, ctx) => {
      const now = Date.now();
      const old = ctx.vault.load().find((x) => x.id === 'todo');
      const lines = (old?.content || '').split('\n').filter((l) => /^- \[[ x]\] /.test(l));
      const pick = () => {
        const i = Number.isInteger(index) ? index - 1 : lines.findIndex((l) => l.toLowerCase().includes(String(text || '').toLowerCase()));
        if (i < 0 || i >= lines.length) throw new Error('no such todo item');
        return i;
      };
      if (action === 'add') {
        if (!text) throw new Error('add needs text');
        lines.push(`- [ ] ${text}`);
      } else if (action === 'done') {
        const i = pick();
        lines[i] = lines[i].replace('- [ ]', '- [x]');
      } else if (action === 'remove') {
        lines.splice(pick(), 1);
      }
      if (action !== 'list') {
        ctx.vault.save({
          id: 'todo', title: 'Todo', content: lines.join('\n'), tags: ['todo'], category: 'areas', isPinned: true,
          createdAt: old?.createdAt || now, updatedAt: now,
        });
        ctx.touched?.('todo');
      }
      return lines.map((l, i) => `${i + 1}. ${l.slice(2)}`).join('\n') || '(empty)';
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a web page (http/https) and return its readable text.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async ({ url }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs');
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 SecondBrain' }, signal: AbortSignal.timeout(20000) });
      const type = r.headers.get('content-type') || '';
      const body = await r.text();
      return clip(`${r.status} ${url}\n\n${type.includes('html') ? htmlText(body) : body}`);
    },
  },
  {
    name: 'web_search',
    description: 'Search the web (DuckDuckGo). Returns titles, links and snippets; use web_fetch to read a result.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }) => {
      const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 SecondBrain' },
        signal: AbortSignal.timeout(20000),
      });
      const html = await r.text();
      const out = [];
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      for (const m of html.matchAll(re)) {
        let link = m[1];
        const u = /uddg=([^&]+)/.exec(link);
        if (u) link = decodeURIComponent(u[1]);
        out.push({ title: htmlText(m[2]), url: link, snippet: htmlText(m[3] || '') });
        if (out.length >= 8) break;
      }
      return out.length ? out : `no results (status ${r.status})`;
    },
  },
  {
    name: 'current_time',
    description: "The current date and time on the user's PC.",
    parameters: { type: 'object', properties: {} },
    run: () => new Date().toString(),
  },
];

class Registry {
  constructor() {
    this.tools = new Map();
  }

  add(list) {
    for (const t of list) this.tools.set(t.name, t);
    return this;
  }

  remove(prefix) {
    for (const k of [...this.tools.keys()]) if (k.startsWith(prefix)) this.tools.delete(k);
  }

  schemas(only) {
    return [...this.tools.values()]
      .filter((t) => !only || only.includes(t.name))
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }

  async run(name, args, ctx) {
    const t = this.tools.get(name);
    if (!t) return { error: `no tool "${name}"` };
    if (t.risky && ctx.approve) {
      const ok = await ctx.approve(name, args, t.describe ? t.describe(args) : JSON.stringify(args));
      if (!ok) return { error: 'the user declined this action' };
    }
    try {
      const out = await t.run(args || {}, ctx);
      return typeof out === 'string' ? clip(out) : clip(JSON.stringify(out, null, 1));
    } catch (e) {
      return { error: e.message };
    }
  }
}

module.exports = { Registry, core, rank, clip, slug };
