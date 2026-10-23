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
  {
    name: 'Keep everything level',
    about: 'Every 10 minutes while open: each repository that is clean and on its line is brought level with GitHub (fast-forward only), and each says where it stands.',
    flow: {
      every: 10,
      nodes: [
        { id: 'a', type: 'git', position: { x: 0, y: 0 }, data: { repo: 'secondbrain', action: 'level', text: '' } },
        { id: 'b', type: 'git', position: { x: 0, y: 140 }, data: { repo: 'research', action: 'level', text: '' } },
        { id: 'c', type: 'git', position: { x: 0, y: 280 }, data: { repo: 'atlas', action: 'level', text: '' } },
        { id: 't', type: 'template', position: { x: 320, y: 140 }, data: { text: '{{input1}}\n\n{{input2}}\n\n{{input3}}\n\nManjuel moved: restart required. Atlas moved: press its Update. SecondBrain moved: its Update.' } },
        { id: 'o', type: 'output', position: { x: 640, y: 140 }, data: {} },
      ],
      edges: [
        { id: 'a-t', source: 'a', target: 't' },
        { id: 'b-t', source: 'b', target: 't' },
        { id: 'c-t', source: 'c', target: 't' },
        { id: 't-o', source: 't', target: 'o' },
      ],
    },
  },
  {
    name: 'Save and send',
    about: "Type what the save is: SecondBrain's work is saved on its line, sent, and a pull request opened for it (that one waits for your Approve in GitHub).",
    flow: {
      nodes: [
        { id: 'i', type: 'input', position: { x: 0, y: 40 }, data: { text: '' } },
        { id: 's', type: 'git', position: { x: 260, y: 40 }, data: { repo: 'secondbrain', action: 'save', text: '{{input}}' } },
        { id: 'p', type: 'git', position: { x: 520, y: 40 }, data: { repo: 'secondbrain', action: 'send', text: '' } },
        { id: 'r', type: 'git', position: { x: 780, y: 40 }, data: { repo: 'secondbrain', action: 'pr', text: '' } },
        { id: 'o', type: 'output', position: { x: 1040, y: 40 }, data: {} },
      ],
      edges: [
        { id: 'i-s', source: 'i', target: 's' },
        { id: 's-p', source: 's', target: 'p' },
        { id: 'p-r', source: 'p', target: 'r' },
        { id: 'r-o', source: 'r', target: 'o' },
      ],
    },
  },
  {
    name: 'Land a pull request',
    about: 'When its checks pass, the pull request of the line SecondBrain stands on is merged on GitHub (on your Approve), the checkout goes back to main, and main is brought level.',
    flow: {
      nodes: [
        { id: 'm', type: 'git', position: { x: 0, y: 40 }, data: { repo: 'secondbrain', action: 'merge', text: '' } },
        { id: 'b', type: 'git', position: { x: 260, y: 40 }, data: { repo: 'secondbrain', action: 'main', text: '' } },
        { id: 'l', type: 'git', position: { x: 520, y: 40 }, data: { repo: 'secondbrain', action: 'level', text: '' } },
        { id: 'o', type: 'output', position: { x: 780, y: 40 }, data: {} },
      ],
      edges: [
        { id: 'm-b', source: 'm', target: 'b' },
        { id: 'b-l', source: 'b', target: 'l' },
        { id: 'l-o', source: 'l', target: 'o' },
      ],
    },
  },
  {
    name: 'Start a piece of work',
    about: 'Type a name: a new line of work from where SecondBrain stands.',
    flow: {
      nodes: [
        { id: 'i', type: 'input', position: { x: 0, y: 40 }, data: { text: '' } },
        { id: 'l', type: 'git', position: { x: 260, y: 40 }, data: { repo: 'secondbrain', action: 'line', text: '{{input}}' } },
        { id: 'o', type: 'output', position: { x: 520, y: 40 }, data: {} },
      ],
      edges: [
        { id: 'i-l', source: 'i', target: 'l' },
        { id: 'l-o', source: 'l', target: 'o' },
      ],
    },
  },
  {
    name: 'Repo health',
    about: "Each repository's state, asked of GitHub, summed up by the local model and saved as a dated note.",
    flow: {
      nodes: [
        { id: 'a', type: 'git', position: { x: 0, y: 0 }, data: { repo: 'secondbrain', action: 'status', text: '' } },
        { id: 'b', type: 'git', position: { x: 0, y: 140 }, data: { repo: 'research', action: 'status', text: '' } },
        { id: 'c', type: 'git', position: { x: 0, y: 280 }, data: { repo: 'atlas', action: 'status', text: '' } },
        { id: 'm', type: 'model', position: { x: 320, y: 140 }, data: { model: 'local', text: 'Three repositories as git reports them. Say for each: its line, unsaved work, saves not sent, saves to take from GitHub, and what to do next.\n\n{{input}}' } },
        { id: 'v', type: 'save', position: { x: 640, y: 140 }, data: { note: 'Repo health {{date}}', mode: 'create', shelf: 'inbox', tags: 'git, repo-health' } },
      ],
      edges: [
        { id: 'a-m', source: 'a', target: 'm' },
        { id: 'b-m', source: 'b', target: 'm' },
        { id: 'c-m', source: 'c', target: 'm' },
        { id: 'm-v', source: 'm', target: 'v' },
      ],
    },
  },
  {
    name: 'Cut a release mark',
    about: "Type the version (v1.2.3): the mark is cut on Atlas's main, where it must equal the declared version, then sent (both on your Approve).",
    flow: {
      nodes: [
        { id: 'i', type: 'input', position: { x: 0, y: 0 }, data: { text: '' } },
        { id: 'c', type: 'git', position: { x: 260, y: 80 }, data: { repo: 'atlas', action: 'mark', text: '{{input}}' } },
        { id: 's', type: 'git', position: { x: 520, y: 40 }, data: { repo: 'atlas', action: 'sendmark', text: '{{input1}}' } },
        { id: 'o', type: 'output', position: { x: 780, y: 40 }, data: {} },
      ],
      edges: [
        { id: 'i-c', source: 'i', target: 'c' },
        { id: 'i-s', source: 'i', target: 's' },
        { id: 'c-s', source: 'c', target: 's' },
        { id: 's-o', source: 's', target: 'o' },
      ],
    },
  },
  { name: 'Empty', about: 'Start from nothing.', flow: { nodes: [], edges: [] } },
];
