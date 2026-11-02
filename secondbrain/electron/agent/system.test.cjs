const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const system = require('./system.cjs');

const ports = { stewardPort: 43120, stewardMcpPort: 8000, appPort: 43110, doorPort: 8090, glassPort: 8091, ollamaPort: 11434 };

test("Steward's button reports each piece by its port, and is ready only with his service and the door", async () => {
  const up = new Set([43110, 8090, 11434]);
  const s = await system.status({ answering: async (p) => up.has(p), ports, models: async () => ['steward:1'] });
  const by = Object.fromEntries(s.pieces.map((p) => [p.id, p.up]));
  assert.deepEqual(by, { steward: false, 'steward-mcp': false, 'secondbrain-mcp': true, door: true, glass: false, ollama: true });
  assert.equal(s.ready, false, 'his service is down');
  assert.deepEqual(s.models, ['steward:1']);
  up.add(43120);
  assert.equal((await system.status({ answering: async (p) => up.has(p), ports, models: async () => [] })).ready, true);
  up.delete(8090);
  assert.equal((await system.status({ answering: async (p) => up.has(p), ports, models: async () => [] })).ready, false, 'the door is down');
});

test('what Steward uses: the tools and skill notes /mcp serves him, his file skills and his workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  fs.mkdirSync(path.join(dir, 'harness', 'steward', 'skills', 'code-review'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'harness', 'steward', 'skills', 'codebase-map'), { recursive: true });
  const answers = {
    'tools/list': { result: { tools: [{ name: 'search_notes' }, { name: 'git_commit' }] } },
    'resources/list': { result: { resources: [{ name: 'skills index' }, { name: 'flows-howto' }] } },
  };
  const u = await system.uses({ mcp: async (m) => answers[m], stewardDir: dir, shareOn: true });
  assert.deepEqual(u, { shareOn: true, tools: ['search_notes', 'git_commit'], skillNotes: ['flows-howto'], fileSkills: ['code-review', 'codebase-map'], workspace: dir });
});
