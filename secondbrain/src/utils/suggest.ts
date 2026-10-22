import { Note } from '../types/index.ts';

/**
 * Suggested questions for Ask Brain, from what is in front of the user: the
 * notes the last answer drew on, or before any question, the notes worked on
 * most recently. The local model words them when it is there; until then (or
 * without it) they are made from the notes' own titles.
 */

const QUIET = new Set(['chat', 'capture', 'archive', 'distilled', 'inbox']);

/** The notes to suggest from: the last answer's sources, else recent work. */
export function suggestionNotes(notes: Note[], sources: Note[] = [], limit = 6): Note[] {
  if (sources.length) return sources.slice(0, limit);
  return notes
    .filter((n) => n.category !== 'archives' && !n.tags.some((t) => t === 'archive' || t === 'distilled'))
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** Questions made from titles and tags, no model needed. */
export function titleQuestions(notes: Note[], count = 4): string[] {
  const out: string[] = [];
  const add = (q: string) => {
    if (!out.includes(q)) out.push(q);
  };
  const forms = [
    (t: string) => `What's the latest on ${t}?`,
    (t: string) => `What's still open in ${t}?`,
    (t: string) => `What did I decide about ${t}, and why?`,
    (t: string) => `How does ${t} connect to my other work?`,
  ];
  notes.forEach((n, i) => {
    const t = n.title.replace(/^(archive|file|git):\s*/i, '').trim();
    if (t) add(forms[i % forms.length](t.length > 60 ? `${t.slice(0, 57)}…` : t));
  });
  const tags = [...new Set(notes.flatMap((n) => n.tags).filter((t) => !QUIET.has(t)))];
  if (tags.length > 1) add(`What ties together ${tags.slice(0, 3).join(', ')}?`);
  return out.slice(0, count);
}

/** The prompt that asks the model for questions about these notes. */
export function suggestionPrompt(notes: Note[], count = 4): string {
  const list = notes
    .map((n) => `- ${n.title}${n.tags.length ? ` [${n.tags.slice(0, 5).join(', ')}]` : ''}: ${n.content.replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  return (
    `These are the notes I am working with right now:\n\n${list}\n\n` +
    `Write ${count} short questions (under 14 words each) that I would ask my notes next about this work. ` +
    `Make them specific to these notes. One question per line, no numbering, nothing else.`
  );
}

/** The model's reply as clean questions. */
export function parseSuggestions(text: string, count = 4): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["“]|["”]$/g, '').trim())
    .filter((l) => l.length > 8 && l.length < 160 && /\?$/.test(l))
    .slice(0, count);
}
