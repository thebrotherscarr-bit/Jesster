import { Flow } from './engine.ts';

/** Flows to start from: New flow offers these. */
export const STARTERS: { name: string; about: string; flow: Flow }[] = [
  {
    name: 'Ask with my notes',
    about: 'A question, the notes that match it, the local model answering from them.',
    flow: {
      nodes: [
        { id: 'q', type: 'input', position: { x: 0, y: 80 }, data: { text: 'What is left to do on the archive digger?' } },
        { id: 's', type: 'search', position: { x: 300, y: 0 }, data: { limit: 4 } },
        { id: 'm', type: 'model', position: { x: 600, y: 80 }, data: { model: 'local', text: 'Answer from these notes only, and name the notes you used.\n\nNotes:\n{{input1}}\n\nQuestion: {{input2}}' } },
        { id: 'o', type: 'output', position: { x: 900, y: 80 }, data: {} },
      ],
      edges: [
        { id: 'q-s', source: 'q', target: 's' },
        { id: 's-m', source: 's', target: 'm' },
        { id: 'q-m', source: 'q', target: 'm' },
        { id: 'm-o', source: 'm', target: 'o' },
      ],
    },
  },
  {
    name: 'Daily digest',
    about: "Today's capture notes, summed up by the local model, saved as a note.",
    flow: {
      nodes: [
        { id: 's', type: 'search', position: { x: 0, y: 40 }, data: { text: 'capture {{date}}', limit: 6 } },
        { id: 'm', type: 'model', position: { x: 300, y: 40 }, data: { model: 'local', text: "Sum up today's work from these capture notes: what got done, what was decided, what is left open.\n\n{{input}}" } },
        { id: 'v', type: 'save', position: { x: 600, y: 40 }, data: { note: 'Digest {{date}}', mode: 'create', shelf: 'inbox', tags: 'digest' } },
      ],
      edges: [
        { id: 's-m', source: 's', target: 'm' },
        { id: 'm-v', source: 'm', target: 'v' },
      ],
    },
  },
  {
    name: 'Dig and tag the archive',
    about: "Every 10 minutes while open: dig what changed in the digger's sources (Settings → Archive) into notes, then tag the next batch of untagged notes with the local model.",
    flow: {
      every: 10,
      nodes: [
        { id: 'd', type: 'dig', position: { x: 0, y: 40 }, data: { path: '' } },
        { id: 't', type: 'tag', position: { x: 300, y: 40 }, data: { model: 'local', limit: 10, tags: '' } },
        { id: 'o', type: 'output', position: { x: 600, y: 40 }, data: {} },
      ],
      edges: [
        { id: 'd-t', source: 'd', target: 't' },
        { id: 't-o', source: 't', target: 'o' },
      ],
    },
  },
  { name: 'Empty', about: 'Start from nothing.', flow: { nodes: [], edges: [] } },
];
