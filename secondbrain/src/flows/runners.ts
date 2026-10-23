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
  /** the archive digger (Settings → Archive): its sources and one dig */
  archive?: {
    sources: (change?: { add?: string }) => Promise<string[]>;
    dig: () => Promise<unknown>;
  };
  /** the door's git tools as a flow asks them (door:flow): reads and bringing level run, other writes wait for him */
  git?: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

/** The git block's acts (plan-github-shelf, G3): a door tool and its arguments, from the block's text. */
export const GIT_ACTS: Record<string, { label: string; call: (text: string) => [string, Record<string, unknown>] }> = {
  status: { label: 'Status (asks GitHub)', call: () => ['git', { fetch: 'yes' }] },
  level: { label: 'Bring level (fast-forward)', call: () => ['git_pull', {}] },
  save: { label: 'Save (text: the message)', call: (t) => ['git_commit', { message: t }] },
  send: { label: 'Send the line', call: () => ['git_push', {}] },
  line: { label: 'Start a line (text: its name)', call: (t) => ['git_branch', { action: 'new', name: t }] },
  switch: { label: 'Switch line (text: its name)', call: (t) => ['git_branch', { action: 'switch', name: t }] },
  main: { label: 'Back to main', call: () => ['git_branch', { action: 'switch', name: 'main' }] },
  pr: { label: 'Open a pull request', call: () => ['git_pr', { action: 'open' }] },
  prs: { label: 'Pull requests and their checks', call: () => ['git_pr', { action: 'list' }] },
  merge: { label: 'Merge when green (text: the line; blank: this one)', call: (t) => ['git_pr', { action: 'merge', line: t, wait: '30' }] },
  mark: { label: 'Cut a version mark (text: v1.2.3)', call: (t) => ['git_tag', { action: 'cut', name: t, message: 'Version ' + t.replace(/^v/, '') }] },
  sendmark: { label: 'Send a version mark (text: v1.2.3)', call: (t) => ['git_tag', { action: 'send', name: t }] },
};

export const GIT_REPOS: { project: string; label: string }[] = [
  { project: 'secondbrain', label: 'SecondBrain' },
  { project: 'research', label: 'Manjuel' },
  { project: 'atlas', label: 'Atlas' },
];

/** The tag a note gets once the Tag notes block has tagged it, so the next run moves on. */
export const TAGGED = 'tagged';
const TAG_DEFAULT = 10;

/** Tags out of a model's reply: words or short phrases, lowercased, hyphenated, at most eight. */
export function parseTags(reply: string): string[] {
  const line = reply.replace(/```[\s\S]*?```/g, ' ').split('\n').find((l) => /[a-z]/i.test(l)) || '';
  return [
    ...new Set(
      line
        .replace(/^(tags?|keywords?)\s*:/i, '')
        .split(/[,;|]/)
        .map((t) => t.trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-'))
        .filter((t) => t.length > 1 && t.length <= 30),
    ),
  ].slice(0, 8);
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

    // A git act on one repository, through the door. A write that waits for him, or a refusal, stops the flow and says why.
    git: async ({ node, fill }) => {
      if (!d.git) throw new Error('git blocks run in the SecondBrain desktop app');
      const project = String(node.data.repo || 'secondbrain');
      const act = GIT_ACTS[String(node.data.action || 'status')];
      if (!act) throw new Error(`no git act "${String(node.data.action)}"`);
      let text = fill(String(node.data.text ?? '{{input}}')).trim();
      if (node.data.action === 'merge' && !text) {
        const st = await d.git('git', { project });
        text = (JSON.parse(st.text || '{}') as { branch?: string }).branch || '';
      }
      const [name, args] = act.call(text);
      const r = await d.git(name, { project, ...args });
      if (r.isError || /^(Refused|Sending refused|Fetching refused)/.test(r.text)) throw new Error(r.text);
      if (/^HELD/.test(r.text)) throw new Error(`waiting on you in GitHub → Waiting on you: ${name} on ${project}`);
      return `${project}: ${r.text}`;
    },

    // Dig the archive: the digger reads its sources into notes, only what changed since the last dig.
    dig: async ({ node }) => {
      if (!d.archive) throw new Error('the archive digger runs in the SecondBrain desktop app');
      const path = String(node.data.path || '').trim();
      if (path) await d.archive.sources({ add: path });
      const out = (await d.archive.dig()) as { sources?: { path: string; created?: number; updated?: number; unchanged?: number; files?: number; failed?: string[] }[] };
      const lines = (out.sources || []).map(
        (s) => `${s.path}: ${s.created || 0} new, ${s.updated || 0} changed, ${s.unchanged || 0} unchanged${s.failed && s.failed.length ? `, ${s.failed.length} unreadable` : ''}`,
      );
      return lines.length ? `Dug:\n${lines.join('\n')}` : 'Dug: no sources yet (add one in the block or in Settings → Archive)';
    },

    // Tag notes: a batch of the notes not tagged yet, each given tags by the model, then marked `tagged`.
    tag: async ({ node, signal }) => {
      const only = String(node.data.tags || '').split(/[\s,]+/).map((t) => t.replace(/^#/, '').toLowerCase()).filter(Boolean);
      const limit = Math.max(1, Number(node.data.limit) || TAG_DEFAULT);
      const who = String(node.data.model || 'local');
      const todo = d
        .notes()
        .filter((n) => !n.tags.includes(TAGGED) && !n.tags.includes('flow') && (!only.length || only.some((t) => n.tags.includes(t))))
        .slice(0, limit);
      if (!todo.length) return `Everything${only.length ? ` tagged ${only.join(' or ')}` : ''} is tagged.`;
      const done: string[] = [];
      for (const n of todo) {
        if (signal?.aborted) break;
        const prompt =
          'Give 3 to 6 short topic tags for this note: lowercase, a word or two each, separated by commas, nothing else.\n\n' +
          `Title: ${n.title}\n\n${n.content.slice(0, 3000)}`;
        const reply = who === 'local' ? await d.askLocal(prompt, signal) : d.askCloud ? await d.askCloud(who, prompt, signal) : '';
        const add = parseTags(reply).filter((t) => !n.tags.includes(t));
        const fresh = notesNow(d, n.id) || n;
        d.upsertNote({ ...fresh, tags: [...fresh.tags, ...add, TAGGED], updatedAt: now() });
        done.push(`${n.title}: ${add.join(', ') || '(no new tags)'}`);
      }
      return `Tagged ${done.length}:\n${done.join('\n')}`;
    },
  };
}

/** The note as it stands now (a block before may have changed it). */
function notesNow(d: RunnerDeps, id: string): Note | undefined {
  return d.notes().find((n) => n.id === id);
}
