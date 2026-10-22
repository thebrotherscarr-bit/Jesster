import { Note, NoteCategory } from '../types/index.ts';
import { buildNotesContextForRag } from '../utils/notes.ts';
import { shelfOf } from '../utils/shelves.ts';
import { Runners } from './engine.ts';
import '../types/desktop.ts';

export interface RunnerDeps {
  notes: () => Note[];
  /** add the note, or replace the one with its id */
  upsertNote: (n: Note) => void;
  /** the local model: prompt in, text out */
  askLocal: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Claude / ChatGPT / Gemini through Integrations */
  askCloud?: (provider: string, prompt: string, signal?: AbortSignal) => Promise<string>;
  newId: () => string;
  now?: () => number;
}

const SEARCH_DEFAULT = 4;
const STOP = new Set('the and for are was what when where which who why how this that with from have has had did does not you your our its into about there their them then than'.split(' '));

function findNote(notes: Note[], ref: string): Note | undefined {
  const r = ref.trim().toLowerCase();
  return notes.find((n) => n.id === ref.trim()) || notes.find((n) => n.title.trim().toLowerCase() === r);
}

/** What each block does in the app. */
export function makeRunners(d: RunnerDeps): Runners {
  const now = d.now || Date.now;
  return {
    input: ({ node }) => String(node.data.text || ''),

    note: ({ node, fill }) => {
      const ref = fill(String(node.data.note || '{{input}}'));
      const n = findNote(d.notes(), ref);
      if (!n) throw new Error(`no note called "${ref}"`);
      return `# ${n.title}\n\n${n.content}`;
    },

    search: ({ node, inputs, fill }) => {
      const q = fill(inputs.length ? '{{input}}' : String(node.data.text || '')).trim();
      if (!q) throw new Error('nothing to search for: wire text in, or type words in the block');
      // only notes that match a word (the shared helper pads with recent notes)
      const terms = q.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\w-]/g, '')).filter((w) => w.length > 2 && !STOP.has(w));
      const hits = d.notes().filter((n) => {
        const hay = `${n.title}\n${n.tags.join(' ')}\n${n.content}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
      if (!hits.length) return '';
      return buildNotesContextForRag(hits, q, Number(node.data.limit) || SEARCH_DEFAULT).contextText;
    },

    model: async ({ node, fill, signal }) => {
      const prompt = fill(String(node.data.text || '{{input}}'));
      const who = String(node.data.model || 'local');
      if (who === 'local') return d.askLocal(prompt, signal);
      if (!d.askCloud) throw new Error('Claude, ChatGPT and Gemini run in the desktop app (Integrations)');
      return d.askCloud(who, prompt, signal);
    },

    template: ({ node, fill }) => fill(String(node.data.text || '{{input}}')),

    save: ({ node, fill }) => {
      const body = fill('{{input}}');
      const title = fill(String(node.data.note || 'Flow output {{date}}')).trim() || 'Flow output';
      const tags = String(node.data.tags || 'flow-output')
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#/, '').toLowerCase())
        .filter(Boolean);
      const shelf: NoteCategory = shelfOf(node.data.shelf || 'inbox', tags);
      const t = now();
      const have = node.data.mode === 'append' ? findNote(d.notes(), title) : undefined;
      if (have) {
        d.upsertNote({ ...have, content: `${have.content.trimEnd()}\n\n${body}`, updatedAt: t });
      } else {
        d.upsertNote({ id: d.newId(), title, content: body, category: shelf, tags, isPinned: false, createdAt: t, updatedAt: t });
      }
      return body;
    },

    output: ({ fill }) => fill('{{input}}'),
  };
}
