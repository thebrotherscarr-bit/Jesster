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

test('memory has a size cap that forces consolidation', async () => {
  const { run } = setup();
  for (let i = 0; i < 39; i++) await run('memory', { target: 'memory', action: 'add', text: `fact ${i} `.padEnd(100, 'x') });
  const r = await run('memory', { target: 'memory', action: 'add', text: 'one too many '.padEnd(200, 'y') });
  assert.match(r.error, /Consolidate/);
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
