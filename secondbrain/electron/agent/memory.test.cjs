const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('../vaultfs.cjs');
const { Registry } = require('./tools.cjs');
const memory = require('./memory.cjs');

const setup = () => {
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')));
  const reg = new Registry().add(memory.tools);
  return { vault, run: (name, a) => reg.run(name, a, { vault }) };
};

test('memory: add, replace, remove — kept as a pinned note and shown every turn', async () => {
  const { vault, run } = setup();
  await run('memory', { target: 'user', action: 'add', text: 'Prefers short answers' });
  await run('memory', { target: 'memory', action: 'add', text: 'Launch moved to the 14th' });
  assert.equal(await run('memory', { target: 'memory', action: 'add', text: 'Launch moved to the 14th' }), 'already remembered');
  await run('memory', { target: 'memory', action: 'replace', old_text: 'launch moved', text: 'Launch is on the 21st' });
  const note = vault.load().find((n) => n.id === 'agent-memory');
  assert.ok(note.isPinned && note.tags.includes('memory'));
  assert.equal(note.content, '- Launch is on the 21st');
  const x = memory.extras(vault).join('\n');
  assert.match(x, /Launch is on the 21st/);
  assert.match(x, /Prefers short answers/);
  await run('memory', { target: 'user', action: 'remove', old_text: 'short' });
  assert.equal(await run('memory', { target: 'user', action: 'read' }), '(empty)');
});

/** A vault held in memory: the cap test does not wait on the disk (a file the PC's scanner holds a moment). */
function memVault() {
  const notes = new Map();
  return {
    load: () => [...notes.values()].map((n) => ({ ...n })),
    get: (id) => (notes.has(id) ? { ...notes.get(id) } : null),
    save: (n) => void notes.set(n.id, { ...n }),
  };
}

test('memory has a size cap that forces consolidation', async () => {
  const vault = memVault();
  const reg = new Registry().add(memory.tools);
  const run = (name, a) => reg.run(name, a, { vault });
  // 39 entries of 100 characters and 38 line breaks: 3938 of 4000, each add said back
  for (let i = 0; i < 39; i++) {
    const r = await run('memory', { target: 'memory', action: 'add', text: `fact ${i} `.padEnd(100, 'x') });
    assert.equal(r, `Agent memory: ${i + 1} entries, ${(i + 1) * 100 + i}/4000 characters`, `add ${i}`);
  }
  const r = await run('memory', { target: 'memory', action: 'add', text: 'one too many '.padEnd(200, 'y') });
  assert.match(r.error, /would be 4139 characters \(limit 4000\)\. Consolidate/);
  assert.equal(vault.get('agent-memory').content.split('\n').length, 39, 'the refused add changed nothing');
});

test('memory never takes a note it cannot read for an empty one', async () => {
  const vault = memVault();
  const reg = new Registry().add(memory.tools);
  const run = (name, a) => reg.run(name, a, { vault });
  await run('memory', { target: 'memory', action: 'add', text: 'first' });
  await run('memory', { target: 'memory', action: 'add', text: 'second' });
  // the file is there and busy: load() skips it, get() says so
  const realLoad = vault.load;
  const realGet = vault.get;
  vault.load = () => realLoad().filter((n) => n.id !== 'agent-memory');
  vault.get = () => {
    throw new Error('the note agent-memory could not be read (EBUSY); nothing was changed');
  };
  const r = await run('memory', { target: 'memory', action: 'add', text: 'third' });
  assert.match(r.error, /could not be read/);
  vault.load = realLoad;
  vault.get = realGet;
  assert.equal(vault.get('agent-memory').content, '- first\n- second', 'both entries kept');
});

test("the vault's get: a note, null when there is none", () => {
  const { vault } = setup();
  assert.equal(vault.get('agent-memory'), null);
  vault.save({ id: 'agent-memory', title: 'Agent memory', content: '- a', tags: ['memory'], category: 'areas', isPinned: true, createdAt: 1, updatedAt: 1 });
  assert.equal(vault.get('agent-memory').content, '- a');
});

test('skills: save, improve, list, view, delete; shown as an index each turn', async () => {
  const { vault, run } = setup();
  await run('skill_save', { name: 'Weekly review', description: 'every Friday', instructions: '1. list projects' });
  const r = JSON.parse(await run('skill_save', { name: 'weekly review', description: 'every Friday afternoon', instructions: '1. list projects\n2. update todo' }));
  assert.equal(r.improved, true);
  assert.equal(vault.load().filter((n) => n.tags.includes('skill')).length, 1);
  assert.deepEqual(JSON.parse(await run('skills_list', {})), [{ name: 'Weekly review', description: 'every Friday afternoon' }]);
  assert.match(await run('skill_view', { name: 'Weekly Review' }), /2\. update todo/);
  assert.match(memory.extras(vault).join('\n'), /- Weekly review: every Friday afternoon/);
  await run('skill_delete', { name: 'weekly review' });
  assert.match((await run('skill_view', { name: 'weekly review' })).error, /no skill/);
});

test('an agentskills.io SKILL.md becomes a skill', () => {
  const n = memory.fromSkillMd('---\r\nname: pdf-summary\r\ndescription: "Summarize a PDF"\r\n---\r\n# Steps\r\n1. read it');
  assert.equal(n.id, 'skill-pdf-summary');
  assert.equal(memory.describeSkill(n), 'Summarize a PDF');
  assert.match(n.content, /# Steps\n1\. read it/);
  assert.equal(memory.fromSkillMd('no front matter'), null);
});

test('search_sessions only looks at past conversations', async () => {
  const { vault, run } = setup();
  vault.save({ id: 'session-1', title: 'Agent: launch talk', content: 'we discussed the launch', tags: ['agent-session'], category: 'archives', isPinned: false, createdAt: 1, updatedAt: 1 });
  vault.save({ id: 'n', title: 'launch plan', content: 'launch', tags: [], category: 'projects', isPinned: false, createdAt: 1, updatedAt: 1 });
  const hits = JSON.parse(await run('search_sessions', { query: 'launch' }));
  assert.deepEqual(hits.map((h) => h.id), ['session-1']);
});

test('through the agent service, the model sees memory and skills every turn', async () => {
  const http = require('http');
  const { AgentService } = require('./service.cjs');
  const { vault, run } = setup();
  await run('memory', { target: 'user', action: 'add', text: 'Name is Kyle' });
  await run('skill_save', { name: 'Daily digest', description: 'summarize the day', instructions: 'steps' });
  let system = '';
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      system = JSON.parse(b).messages[0].content;
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'hi Kyle' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const svc = new AgentService({
    getVault: () => vault,
    getModel: () => ({ host: `http://127.0.0.1:${server.address().port}`, model: 'm' }),
    extras: async () => memory.extras(vault),
  });
  svc.registry.add(memory.tools);
  const r = await svc.ask({ text: 'hello' });
  server.close();
  assert.equal(r.answer, 'hi Kyle');
  assert.match(system, /Name is Kyle/);
  assert.match(system, /Daily digest: summarize the day/);
  assert.ok(vault.load().some((n) => n.id === r.sessionId && n.tags.includes('agent-session')));
});
