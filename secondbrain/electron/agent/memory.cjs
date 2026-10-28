/**
 * Memory, skills and session search: the Hermes-style learning loop, kept
 * as ordinary notes so the user can read and edit everything the agent
 * "knows".
 *
 *   memory       note id agent-memory  — facts, decisions, lessons learned
 *   about you    note id user-profile  — who the user is, how they like things
 *   skills       notes tagged skill    — reusable procedures (agentskills.io
 *                                        SKILL.md compatible: name, description,
 *                                        instructions)
 *
 * Both memory notes are put in front of the model every turn; they have a
 * size cap, so the agent must consolidate instead of piling up.
 */
const { rank, slug, clip } = require('./tools.cjs');

const LIMIT = { memory: 4000, user: 2500 };
const IDS = { memory: 'agent-memory', user: 'user-profile' };
const TITLES = { memory: 'Agent memory', user: 'About you' };

function load(vault, id) {
  return vault.load().find((n) => n.id === id);
}

function entries(note) {
  return (note?.content || '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
}

function saveEntries(vault, target, list, old) {
  const now = Date.now();
  vault.save({
    id: IDS[target],
    title: TITLES[target],
    content: list.map((e) => `- ${e}`).join('\n'),
    tags: ['memory'],
    category: 'areas',
    isPinned: true,
    createdAt: old?.createdAt || now,
    updatedAt: now,
  });
}

// ---- skills -------------------------------------------------------------

function skillId(name) {
  return `skill-${slug(name)}`;
}

/** A skill note: title is the name; first line "> description"; then the instructions. */
function skillNote(name, description, instructions, old) {
  const now = Date.now();
  return {
    id: old?.id || skillId(name),
    title: old?.title || name, // improving a skill keeps its name
    content: `> ${String(description).replace(/\n/g, ' ').trim()}\n\n${String(instructions).trim()}`,
    tags: ['skill'],
    category: 'resources',
    isPinned: false,
    createdAt: old?.createdAt || now,
    updatedAt: now,
  };
}

function describeSkill(n) {
  const m = /^>\s*(.+)$/m.exec(n.content || '');
  return m ? m[1].trim() : (n.content || '').replace(/\s+/g, ' ').slice(0, 120);
}

function skills(vault) {
  return vault.load().filter((n) => n.tags.includes('skill')).sort((a, b) => a.title.localeCompare(b.title));
}

/** An agentskills.io SKILL.md (front matter name/description + body) as a skill note. */
function fromSkillMd(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  if (!meta.name) return null;
  return skillNote(meta.name, meta.description || '', m[2]);
}

// ---- tools --------------------------------------------------------------

const tools = [
  {
    name: 'memory',
    description:
      "Your long-term memory, shown to you at the start of every conversation. target 'memory' for facts, decisions and lessons; 'user' for who the user is and how they like things. action add (text), replace (old_text → text), remove (old_text), read. Keep entries short; when full, consolidate.",
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['memory', 'user'] },
        action: { type: 'string', enum: ['add', 'replace', 'remove', 'read'] },
        text: { type: 'string' },
        old_text: { type: 'string' },
      },
      required: ['target', 'action'],
    },
    run: ({ target, action, text, old_text }, ctx) => {
      if (!IDS[target]) throw new Error("target is 'memory' or 'user'");
      const old = load(ctx.vault, IDS[target]);
      const list = entries(old);
      const findOld = () => {
        const i = list.findIndex((e) => e.toLowerCase().includes(String(old_text || '').toLowerCase()));
        if (!old_text || i < 0) throw new Error('no entry contains that old_text');
        return i;
      };
      if (action === 'read') return list.length ? list.map((e) => `- ${e}`).join('\n') : '(empty)';
      if (action === 'add') {
        if (!text) throw new Error('add needs text');
        if (list.some((e) => e.toLowerCase() === text.toLowerCase())) return 'already remembered';
        list.push(text.replace(/\n/g, ' ').trim());
      } else if (action === 'replace') {
        list[findOld()] = String(text || '').replace(/\n/g, ' ').trim();
      } else if (action === 'remove') {
        list.splice(findOld(), 1);
      }
      const size = list.join('\n').length;
      if (size > LIMIT[target]) {
        throw new Error(`${TITLES[target]} would be ${size} characters (limit ${LIMIT[target]}). Consolidate: replace or remove older entries first.`);
      }
      saveEntries(ctx.vault, target, list, old);
      ctx.touched?.(IDS[target]);
      return `${TITLES[target]}: ${list.length} entries, ${size}/${LIMIT[target]} characters`;
    },
  },
  {
    name: 'search_sessions',
    description: 'Search your past conversations with the user (saved sessions). Use when the user refers to something discussed before.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    run: ({ query, limit = 5 }, ctx) =>
      rank(ctx.vault.load().filter((n) => n.tags.includes('agent-session')), query, Math.min(limit, 10)).map((n) => ({
        id: n.id,
        title: n.title,
        when: new Date(n.updatedAt).toISOString().slice(0, 16),
        excerpt: clip(n.content, 1500),
      })),
  },
  {
    name: 'skills_list',
    description: 'List your saved skills (reusable procedures) with their descriptions.',
    parameters: { type: 'object', properties: {} },
    run: (_a, ctx) => skills(ctx.vault).map((n) => ({ name: n.title, description: describeSkill(n) })),
  },
  {
    name: 'skill_view',
    description: 'Open a skill to follow its instructions.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: ({ name }, ctx) => {
      const n = skills(ctx.vault).find((s) => s.title.toLowerCase() === String(name).toLowerCase() || s.id === skillId(name));
      if (!n) throw new Error(`no skill named "${name}" (see skills_list)`);
      return n.content;
    },
  },
  {
    name: 'skill_save',
    description:
      'Create a skill, or improve an existing one (same name): a reusable, step-by-step procedure for a kind of task. Save one after finishing a complex task that is likely to come up again, or when a skill you used needed fixing.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string', description: 'one line: when to use it' },
        instructions: { type: 'string', description: 'the steps, in Markdown' },
      },
      required: ['name', 'description', 'instructions'],
    },
    run: ({ name, description, instructions }, ctx) => {
      const old = skills(ctx.vault).find((s) => s.title.toLowerCase() === String(name).toLowerCase());
      const note = skillNote(name, description, instructions, old);
      ctx.vault.save(note);
      ctx.touched?.(note.id);
      return { saved: note.id, improved: Boolean(old) };
    },
  },
  {
    name: 'skill_delete',
    description: 'Delete a skill that is wrong or no longer useful (it goes to the vault trash).',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: ({ name }, ctx) => {
      const n = skills(ctx.vault).find((s) => s.title.toLowerCase() === String(name).toLowerCase());
      if (!n) throw new Error(`no skill named "${name}"`);
      ctx.vault.remove(n.id);
      return { deleted: n.id };
    },
  },
];

/** What goes in front of the model every turn: memory, the user, the skills index. */
function extras(vault) {
  const mem = entries(load(vault, IDS.memory));
  const user = entries(load(vault, IDS.user));
  const sk = skills(vault);
  return [
    `## Your memory (${mem.join('\n').length}/${LIMIT.memory} chars)\n${mem.length ? mem.map((e) => `- ${e}`).join('\n') : '(empty)'}`,
    `## About the user (${user.join('\n').length}/${LIMIT.user} chars)\n${user.length ? user.map((e) => `- ${e}`).join('\n') : '(nothing yet)'}`,
    sk.length
      ? `## Your skills (open one with skill_view before doing that kind of task)\n${sk.map((n) => `- ${n.title}: ${describeSkill(n)}`).join('\n')}`
      : '## Your skills\n(none yet)',
    'Learning loop: when you learn a durable fact, a preference, or a lesson, save it with the memory tool. After a complex task likely to recur, save a skill with skill_save; if a skill you followed was wrong or incomplete, improve it.',
  ];
}

module.exports = { tools, extras, skills, fromSkillMd, skillNote, describeSkill, LIMIT, IDS };
