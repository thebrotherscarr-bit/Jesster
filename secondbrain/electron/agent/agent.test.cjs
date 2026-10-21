const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Vault } = require('../vaultfs.cjs');
const { Registry, core } = require('./tools.cjs');
const { runTurn, saveSession, messagesFromNote } = require('./agent.cjs');

/** A fake Ollama: answers from a script of replies, records what it was sent. */
function fakeOllama(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const b = JSON.parse(body);
      seen.push(b);
      const reply = script(b, seen.length);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: { role: 'assistant', ...reply } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, host: `http://127.0.0.1:${server.address().port}` })));
}

const call = (name, a) => ({ tool_calls: [{ function: { name, arguments: a } }], content: '' });

function vaultWith(notes) {
  const v = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-')));
  for (const n of notes) v.save({ category: 'projects', tags: [], isPinned: false, createdAt: 1, updatedAt: 1, ...n });
  return v;
}

test('the agent searches notes, reads one, and answers from it', async () => {
  const vault = vaultWith([
    { id: 'launch', title: 'Launch plan', content: 'We launch on Friday the 14th.' },
    { id: 'other', title: 'Groceries', content: 'eggs' },
  ]);
  const o = await fakeOllama((b, n) => {
    if (n === 1) return call('search_notes', { query: 'launch date' });
    if (n === 2) return call('read_note', { id: JSON.parse(b.messages.at(-1).content)[0].id });
    return { content: `Friday the 14th, per ${JSON.parse(b.messages.at(-1).content).title}.` };
  });
  const events = [];
  const messages = [{ role: 'user', content: 'when do we launch?' }];
  const answer = await runTurn({ host: o.host, model: 'gpt-oss:20b', messages, registry: new Registry().add(core), ctx: { vault }, onEvent: (e) => events.push(e.type) });
  o.server.close();
  assert.equal(answer, 'Friday the 14th, per Launch plan.');
  assert.deepEqual(events, ['step', 'tool', 'result', 'step', 'tool', 'result', 'step', 'answer']);
  assert.ok(o.seen[0].tools.some((t) => t.function.name === 'web_search'), 'tools are offered');
  assert.equal(o.seen[0].messages[0].role, 'system');
  assert.equal(o.seen[1].messages.at(-1).role, 'tool');
});

test('notes and todos written by the agent are real files', async () => {
  const vault = vaultWith([]);
  const o = await fakeOllama((b, n) =>
    n === 1 ? call('write_note', { title: 'Idea', content: 'build the agent', tags: ['#Idea'] })
      : n === 2 ? call('todo', { action: 'add', text: 'ship build 13' })
        : n === 3 ? call('todo', { action: 'done', index: 1 })
          : { content: 'done' }
  );
  await runTurn({ host: o.host, model: 'm', messages: [{ role: 'user', content: 'x' }], registry: new Registry().add(core), ctx: { vault } });
  o.server.close();
  const notes = vault.load();
  const idea = notes.find((n) => n.title === 'Idea');
  assert.deepEqual(idea.tags, ['idea']);
  assert.match(notes.find((n) => n.id === 'todo').content, /- \[x\] ship build 13/);
});

test('tool errors go back to the model instead of crashing the turn', async () => {
  const vault = vaultWith([]);
  const o = await fakeOllama((b, n) => (n === 1 ? call('read_note', { id: 'missing' }) : n === 2 ? call('nope', {}) : { content: b.messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' | ') }));
  const answer = await runTurn({ host: o.host, model: 'm', messages: [{ role: 'user', content: 'x' }], registry: new Registry().add(core), ctx: { vault } });
  o.server.close();
  assert.match(answer, /no note with id "missing"/);
  assert.match(answer, /no tool "nope"/);
});

test('risky tools wait for the user, and a refusal is reported', async () => {
  const vault = vaultWith([]);
  let asked = null;
  const reg = new Registry().add([{ name: 'danger', description: 'd', parameters: { type: 'object', properties: {} }, risky: true, run: () => 'ran' }]);
  const o = await fakeOllama((b, n) => (n === 1 ? call('danger', { x: 1 }) : { content: b.messages.at(-1).content }));
  const answer = await runTurn({ host: o.host, model: 'm', messages: [{ role: 'user', content: 'x' }], registry: reg, ctx: { vault, approve: async (name, a) => { asked = [name, a]; return false; } } });
  o.server.close();
  assert.deepEqual(asked, ['danger', { x: 1 }]);
  assert.equal(answer, 'Error: the user declined this action');
});

test('a step limit ends a runaway loop', async () => {
  const o = await fakeOllama(() => call('current_time', {}));
  const answer = await runTurn({ host: o.host, model: 'm', messages: [{ role: 'user', content: 'x' }], registry: new Registry().add(core), ctx: { vault: vaultWith([]) }, maxSteps: 3 });
  o.server.close();
  assert.match(answer, /stopped after 3 steps/);
});

test('a missing Ollama is said plainly', async () => {
  await assert.rejects(
    runTurn({ host: 'http://127.0.0.1:9', model: 'm', messages: [{ role: 'user', content: 'x' }], registry: new Registry().add(core), ctx: { vault: vaultWith([]) } }),
    /Is Ollama running/
  );
});

test('sessions are saved as notes and can be continued', () => {
  const vault = vaultWith([]);
  const messages = [
    { role: 'user', content: 'when do we launch?' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_notes', arguments: { query: 'launch' } } }] },
    { role: 'tool', tool_name: 'search_notes', content: '[]' },
    { role: 'assistant', content: 'Friday.' },
  ];
  const note = saveSession(vault, 'session-1', messages);
  assert.deepEqual(note.tags, ['agent-session', 'app']);
  assert.match(note.content, /used `search_notes`/);
  assert.deepEqual(messagesFromNote(vault.load()[0]), [
    { role: 'user', content: 'when do we launch?' },
    { role: 'assistant', content: 'Friday.' },
  ]);
});
