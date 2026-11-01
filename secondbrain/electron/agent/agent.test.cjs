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

test("Steward's turn is streamed: tool calls, results and text reach the tab as they happen", async () => {
  const { turn } = require('./steward.cjs');
  const bodies = [];
  const frame = (type, data) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...data })}\r\n\r\n`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.setHeader('Content-Type', 'text/event-stream');
      if (bodies.length === 1) {
        res.write(frame('response.output_item.done', { item: { id: 'c1', type: 'function_call', name: 'read_note', call_id: 'k1', arguments: '{"id":"a"}' } }));
        res.write(frame('response.output_item.done', { item: { id: 'o1', type: 'function_call_output', call_id: 'k1', output: 'note a' } }));
        res.write(frame('response.output_item.done', { item: { id: 'p1', type: 'mcp_approval_request', name: 'git_commit', arguments: '{"message":"x"}' } }));
        res.end(frame('response.completed', { response: { id: 'r1', status: 'completed', output: [] } }));
      } else {
        res.write(frame('response.reasoning_summary_text.delta', { delta: 'Approved, ' }));
        res.write(frame('response.reasoning_summary_text.delta', { delta: 'so report it.' }));
        res.write(frame('response.output_text.delta', { delta: 'Com' }));
        res.write(frame('response.output_text.delta', { delta: 'mitted.' }));
        const msg = { id: 'm1', type: 'message', content: [{ type: 'output_text', text: 'Committed.' }] };
        res.write(frame('response.output_item.done', { item: msg }));
        res.end(frame('response.completed', { response: { id: 'r2', status: 'completed', output: [msg] } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const events = [];
  const r = await turn({ base: `http://127.0.0.1:${server.address().port}`, text: 'commit it', previous: null, approve: async () => true, onEvent: (e) => events.push(e) });
  server.close();
  assert.equal(r.answer, 'Committed.');
  assert.equal(r.previous, 'r2');
  assert.deepEqual(events.map((e) => e.type), ['tool', 'result', 'thinking', 'thinking', 'delta', 'delta', 'answer']);
  assert.equal(events.filter((e) => e.type === 'thinking').map((e) => e.text).join(''), 'Approved, so report it.');
  assert.equal(r.calls[0].result, 'note a');
  assert.ok(bodies.every((b) => b.stream === true), 'every request asks for a stream');
  assert.deepEqual(bodies[1].input, [{ type: 'mcp_approval_response', approval_request_id: 'p1', approve: true }]);
});

test("Steward's MCP door starts like his service: mcp_app.py on 8000, from his folder, with its own log", async () => {
  const steward = require('./steward.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  for (const f of [['.venv', 'Scripts', 'python.exe'], ['harness', 'steward', 'step04_production_ready', 'hosted.py'], steward.MCP_SCRIPT]) {
    fs.mkdirSync(path.join(dir, ...f.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(dir, ...f), '');
  }
  const started = [];
  let up = false;
  const opts = {
    getConfig: () => ({ dir, port: 43999 }),
    vaultDir: () => null,
    answering: async () => up,
    waitFor: async () => true,
    startOwned: (exe, args, cwd, env, logs) => started.push({ exe, args, cwd, logs }),
  };
  const door = steward.service({ ...opts, script: steward.MCP_SCRIPT, port: steward.MCP_PORT, log: 'steward-mcp.log' });
  assert.equal(await door.ensure(), 'http://127.0.0.1:8000');
  assert.deepEqual(started, [{ exe: path.join(dir, '.venv', 'Scripts', 'python.exe'), args: [path.join(...steward.MCP_SCRIPT)], cwd: dir, logs: ['steward-mcp.log', 'steward-mcp.log'] }]);
  assert.equal(await steward.service(opts).ensure(), 'http://127.0.0.1:43999');
  assert.equal(started[1].args[0], path.join('harness', 'steward', 'step04_production_ready', 'hosted.py'), 'his service is unchanged');
  up = true; // one already answering (started by hand) is used as it is
  assert.equal(await door.ensure(), 'http://127.0.0.1:8000');
  assert.equal(started.length, 2);
});

test("a conversation keeps Steward's thread and mode across a restart", async () => {
  const { threads } = require('./steward.cjs');
  const { AgentService } = require('./service.cjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'threads-')), 'steward-threads.json');
  const vault = vaultWith([]);
  const seen = [];
  const steward = {
    ensure: async () => 'http://steward',
    turn: async ({ previous, responseFormat, switchTo }) => {
      seen.push({ previous, planning: Boolean(responseFormat), switchTo });
      return { answer: 'ok', previous: `r${seen.length}`, calls: seen.length === 2 ? [{ name: 'mode_set', arguments: { mode: 'plan' } }] : [] };
    },
  };
  const model = () => ({ backend: 'steward' });
  const first = new AgentService({ getVault: () => vault, getModel: model, steward, threads: threads(file) });
  // a new conversation starts in plan mode, as Steward does (Steward #22)
  const { sessionId } = await first.ask({ text: 'read the ADR note and report' });
  // the plan card's Approve: Steward is told to switch, and the turn is not asked for a plan
  await first.ask({ text: 'Approve and switch to execute mode', sessionId, mode: 'execute' });
  // a new service is what SecondBrain has after a restart; his mode_set('plan') was kept
  const second = new AgentService({ getVault: () => vault, getModel: model, steward, threads: threads(file) });
  await second.ask({ text: "what's on my watchlist?", sessionId });
  assert.deepEqual(seen, [
    { previous: undefined, planning: true, switchTo: null },
    { previous: 'r1', planning: false, switchTo: 'execute' },
    { previous: 'r2', planning: true, switchTo: null },
  ]);
});

test("an Approve's mode reaches Steward's service as metadata.agent_mode", async () => {
  const { turn } = require('./steward.cjs');
  const bodies = [];
  const stream = async (url, body) => {
    bodies.push(body);
    return { id: 'r1', status: 'completed', output: [] };
  };
  await turn({ base: 'http://steward', text: 'Approve and switch to execute mode', previous: 'r0', approve: async () => true, stream, switchTo: 'execute' });
  await turn({ base: 'http://steward', text: 'hello', previous: 'r1', approve: async () => true, stream });
  assert.deepEqual(bodies[0].metadata, { agent_mode: 'execute' });
  assert.equal(bodies[1].metadata, undefined);
});
