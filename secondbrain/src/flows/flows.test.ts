import test from 'node:test';
import assert from 'node:assert/strict';
import { Flow, order, fillTemplate, runFlow, flowToNoteBody, flowFromNoteBody, describe, BlockState } from './engine.ts';
import { makeRunners, parseTags, TAGGED } from './runners.ts';
import { STARTERS } from './starters.ts';
import { Note } from '../types/index.ts';

const at = (x: number, y = 0) => ({ x, y });

test('blocks run in wiring order, and a loop is refused', () => {
  const f: Flow = {
    nodes: [
      { id: 'c', type: 'output', position: at(600), data: {} },
      { id: 'a', type: 'input', position: at(0), data: { text: 'hi' } },
      { id: 'b', type: 'template', position: at(300), data: {} },
    ],
    edges: [{ id: '1', source: 'a', target: 'b' }, { id: '2', source: 'b', target: 'c' }],
  };
  assert.deepEqual(order(f).map((n) => n.id), ['a', 'b', 'c']);
  assert.equal(describe(f), 'input → template → output');
  f.edges.push({ id: '3', source: 'c', target: 'b' });
  assert.throws(() => order(f), /loop through b, c/);
});

test('templates fill {{input}}, {{input1}}… and {{date}}', () => {
  const t = fillTemplate('Q: {{input2}} | N: {{ input1 }} | all: {{input}} | {{date}} | {{input9}}.', ['notes', 'why?'], new Date(2026, 9, 22));
  assert.equal(t, 'Q: why? | N: notes | all: notes\n\nwhy? | 2026-10-22 | .');
});

test('a run carries text down the wires; inputs come in top-to-bottom order', async () => {
  const f: Flow = {
    nodes: [
      { id: 'low', type: 'input', position: at(0, 200), data: { text: 'second' } },
      { id: 'high', type: 'input', position: at(0, 0), data: { text: 'first' } },
      { id: 't', type: 'template', position: at(300), data: { text: '{{input1}} then {{input2}}' } },
    ],
    edges: [{ id: '1', source: 'low', target: 't' }, { id: '2', source: 'high', target: 't' }],
  };
  const seen: string[] = [];
  const s = await runFlow(f, makeRunners(deps([])), (id, st) => seen.push(`${id}:${st.status}`));
  assert.deepEqual(s.t, { ...(s.t as object), status: 'done', output: 'first then second' });
  assert.ok(seen.indexOf('t:running') > seen.indexOf('low:done'));
});

test('a failed block skips what comes after it, other branches carry on', async () => {
  const f: Flow = {
    nodes: [
      { id: 'n', type: 'note', position: at(0), data: { note: 'No such note' } },
      { id: 'o', type: 'output', position: at(300), data: {} },
      { id: 'i', type: 'input', position: at(0, 200), data: { text: 'fine' } },
      { id: 'o2', type: 'output', position: at(300, 200), data: {} },
    ],
    edges: [{ id: '1', source: 'n', target: 'o' }, { id: '2', source: 'i', target: 'o2' }],
  };
  const s = await runFlow(f, makeRunners(deps([])));
  assert.equal(s.n.status, 'error');
  assert.match((s.n as { error: string }).error, /no note called "No such note"/);
  assert.deepEqual(s.o, { status: 'skipped', reason: 'a block before it failed' });
  assert.equal((s.o2 as { output: string }).output, 'fine');
});

test('stopping a run skips the rest', async () => {
  const ctl = new AbortController();
  const f: Flow = {
    nodes: [
      { id: 'a', type: 'model', position: at(0), data: { text: 'x' } },
      { id: 'b', type: 'output', position: at(300), data: {} },
    ],
    edges: [{ id: '1', source: 'a', target: 'b' }],
  };
  const d = deps([]);
  d.askLocal = async () => {
    ctl.abort();
    return 'answer';
  };
  const s = await runFlow(f, makeRunners(d), undefined, { signal: ctl.signal });
  assert.equal(s.a.status, 'done');
  assert.deepEqual(s.b, { status: 'skipped', reason: 'stopped' });
});

const note = (id: string, title: string, content: string, extra: Partial<Note> = {}): Note => ({
  id, title, content, category: 'projects', tags: [], isPinned: false, createdAt: 1, updatedAt: 1, ...extra,
});

function deps(notes: Note[]) {
  const saved: Note[] = [];
  let n = 0;
  const d = {
    notes: () => [...notes, ...saved],
    upsertNote: (x: Note) => {
      const i = saved.findIndex((s) => s.id === x.id);
      if (i >= 0) saved[i] = x;
      else {
        const j = notes.findIndex((s) => s.id === x.id);
        if (j >= 0) notes[j] = x;
        else saved.push(x);
      }
    },
    askLocal: async (p: string) => `local saw: ${p}`,
    askCloud: async (who: string, p: string) => `${who} saw: ${p.length} chars`,
    newId: () => `note-flow-${++n}`,
    now: () => 1000,
    saved,
  };
  return d;
}

test('the starter "Ask with my notes" searches, asks the model with both inputs, and shows the answer', async () => {
  const d = deps([note('a', 'Archive digger', 'The archive digger still needs voice memos.'), note('b', 'Lunch', 'tacos')]);
  const flow = STARTERS[0].flow;
  const states: Record<string, BlockState> = await runFlow(flow, makeRunners(d), undefined, { now: new Date(2026, 9, 22) });
  const out = states.o as { output: string };
  assert.equal(states.o.status, 'done');
  assert.match(out.output, /local saw: Answer from these notes only/);
  assert.match(out.output, /Archive digger/);
  assert.match(out.output, /Question: What is left to do on the archive digger\?/);
  assert.doesNotMatch(out.output, /tacos/);
});

test('the starter "Daily digest" saves a note, and a cloud model is used when picked', async () => {
  const d = deps([note('c', 'steward — 2026-10-22', 'capture 2026-10-22 drove the build', { tags: ['capture'] })]);
  const flow = structuredClone(STARTERS[1].flow);
  flow.nodes[1].data.model = 'anthropic';
  const s = await runFlow(flow, makeRunners(d), undefined, { now: new Date(2026, 9, 22) });
  assert.equal(s.v.status, 'done', JSON.stringify(s));
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0].title, 'Digest 2026-10-22');
  assert.deepEqual(d.saved[0].tags, ['digest']);
  assert.equal(d.saved[0].category, 'inbox');
  assert.match(d.saved[0].content, /^anthropic saw: \d+ chars$/);
});

test('save can append to an existing note by title', async () => {
  const d = deps([note('log', 'Flow log', 'line 1')]);
  const f: Flow = {
    nodes: [
      { id: 'i', type: 'input', position: at(0), data: { text: 'line 2' } },
      { id: 's', type: 'save', position: at(300), data: { note: 'Flow log', mode: 'append' } },
    ],
    edges: [{ id: '1', source: 'i', target: 's' }],
  };
  await runFlow(f, makeRunners(d));
  assert.equal(d.notes().find((n) => n.id === 'log')!.content, 'line 1\n\nline 2');
  assert.equal(d.saved.length, 0);
});

test('a flow is kept in a note and read back the same', () => {
  const f = STARTERS[0].flow;
  const body = flowToNoteBody(f, 'Ask my notes a question.');
  assert.match(body, /^Ask my notes a question\.\n\n```flow\n/);
  assert.deepEqual(flowFromNoteBody(body), f);
  assert.equal(flowFromNoteBody('no flow here'), null);
  assert.equal(flowFromNoteBody('```flow\n{bad\n```'), null);
});

const anote = (id: string, tags: string[], content = 'text'): Note => ({ id, title: id, content, category: 'archives', tags, isPinned: false, createdAt: 1, updatedAt: 1 });

test("tags are read out of a model's reply: lowercased, hyphenated, at most eight", () => {
  assert.deepEqual(parseTags('Tags: Game Design, #Rimtera, voxel engine; ROCm'), ['game-design', 'rimtera', 'voxel-engine', 'rocm']);
  assert.deepEqual(parseTags('a, b, c'), []);
});

test('Tag notes tags the next batch, marks each tagged, and moves on next run', async () => {
  let notes = [anote('a', ['archive']), anote('b', ['archive']), anote('c', ['other']), anote('d', ['archive', TAGGED])];
  const asked: string[] = [];
  const r = makeRunners({
    notes: () => notes,
    upsertNote: (n) => (notes = notes.map((x) => (x.id === n.id ? n : x))),
    askLocal: async (p) => (asked.push(p), 'Atlas, door design'),
    newId: () => 'x',
  });
  const run = () => r.tag!({ node: { id: 't', type: 'tag', position: at(0), data: { tags: 'archive', limit: 1 } }, inputs: [], fill: (s) => s });
  assert.match(await run(), /^Tagged 1:\na: atlas, door-design/);
  assert.deepEqual(notes.find((n) => n.id === 'a')!.tags, ['archive', 'atlas', 'door-design', TAGGED]);
  assert.match(await run(), /^Tagged 1:\nb:/);
  assert.equal(await run(), 'Everything tagged archive is tagged.');
  assert.ok(!notes.find((n) => n.id === 'c')!.tags.includes(TAGGED), 'a note outside the filter is left alone');
  assert.equal(asked.length, 2);
});

test('Dig the archive adds the folder as a source and reports what changed', async () => {
  const added: string[] = [];
  const dir = String.raw`C:\Archive`;
  const r = makeRunners({
    notes: () => [],
    upsertNote: () => {},
    askLocal: async () => '',
    newId: () => 'x',
    archive: {
      sources: async (c) => (c && c.add ? (added.push(c.add), added) : added),
      dig: async () => ({ sources: [{ path: dir, created: 3, updated: 1, unchanged: 7 }] }),
    },
  });
  const out = await r.dig!({ node: { id: 'd', type: 'dig', position: at(0), data: { path: dir } }, inputs: [], fill: (s) => s });
  assert.deepEqual(added, [dir]);
  assert.equal(out, `Dug:\n${dir}: 3 new, 1 changed, 7 unchanged`);
  const none = makeRunners({ notes: () => [], upsertNote: () => {}, askLocal: async () => '', newId: () => 'x' });
  await assert.rejects(async () => none.dig!({ node: { id: 'd', type: 'dig', position: at(0), data: {} }, inputs: [], fill: (s) => s }), /desktop app/);
});

test('the starter "Dig and tag the archive" repeats every 10 minutes, and the repeat is kept in its note', () => {
  const s = STARTERS.find((x) => x.name === 'Dig and tag the archive')!;
  assert.equal(describe(s.flow), 'dig → tag → output');
  assert.equal(flowFromNoteBody(flowToNoteBody(s.flow))!.every, 10);
  assert.equal(flowFromNoteBody(flowToNoteBody({ nodes: [], edges: [] }))!.every, undefined);
});

test('the git block asks the door as a flow: an act and its text; a write waiting on him or a refusal stops the flow', async () => {
  const asked: [string, Record<string, unknown>][] = [];
  const answers: Record<string, string> = { git: '{"branch":"work"}', git_commit: 'HELD: "git_commit" writes', git_pr: 'Merged pull request #7', git_pull: 'Refused: there is unsaved work here.' };
  const r = makeRunners({
    notes: () => [],
    upsertNote: () => {},
    askLocal: async () => '',
    newId: () => 'x',
    git: async (name, args) => (asked.push([name, args]), { text: answers[name] || 'ok', isError: false }),
  });
  const run = (data: Record<string, unknown>, input = '') => r.git!({ node: { id: 'g', type: 'git', position: at(0), data }, inputs: input ? [input] : [], fill: (s) => s.replace('{{input}}', input) });
  assert.equal(await run({ repo: 'atlas', action: 'merge', text: '' }), 'atlas: Merged pull request #7');
  assert.deepEqual(asked.slice(-1)[0], ['git_pr', { project: 'atlas', action: 'merge', line: 'work', wait: '30' }], 'a blank line is the one the checkout stands on');
  await assert.rejects(async () => run({ repo: 'secondbrain', action: 'save' }, 'the message'), /waiting on you in GitHub/);
  assert.deepEqual(asked.slice(-1)[0], ['git_commit', { project: 'secondbrain', message: 'the message' }]);
  await assert.rejects(async () => run({ repo: 'research', action: 'level' }), /^Error: Refused: there is unsaved work/);
  assert.equal(describe(STARTERS.find((s) => s.name === 'Keep everything level')!.flow), 'git → git → git → template → output');
});
