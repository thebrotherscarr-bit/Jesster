/**
 * The Agent tab over AG-UI (agui.cjs) against a fake AG-UI host: a small SSE server speaking the event shapes Steward's
 * ag_ui_app.py streams (MAF's agent_framework_ag_ui, ag-ui-protocol 0.1.x), through the real AG-UI client.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agui = require('./agui.cjs');

const THREAD = 'conv-1';

/** A fake AG-UI host: `script(body, n)` gives each run's events; every request body is kept in `seen`. */
function fakeHost(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': keepalive\n\n'); // MAF's endpoint sends these; they are not events
      const run = { threadId: body.threadId, runId: body.runId };
      for (const e of [{ type: 'RUN_STARTED', ...run }, ...script(body, seen.length), ...[]]) {
        const event = e.type === 'RUN_FINISHED' ? { ...run, ...e } : e;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/` })));
}

const words = (id, text, kind = 'TEXT_MESSAGE') =>
  kind === 'TEXT_MESSAGE'
    ? [{ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text }, { type: 'TEXT_MESSAGE_END', messageId: id }]
    : [
        { type: 'REASONING_START', messageId: id },
        { type: 'REASONING_MESSAGE_START', messageId: id, role: 'reasoning' },
        ...text.split(/(?<= )/).map((d) => ({ type: 'REASONING_MESSAGE_CONTENT', messageId: id, delta: d })),
        { type: 'REASONING_MESSAGE_END', messageId: id },
        { type: 'REASONING_END', messageId: id },
      ];

/** A card as ag_ui_app.py raises it: a request_info tool call, a CUSTOM request_info event, an interrupt outcome. */
function card(fc, checkpoint) {
  const call = `rq-${fc.name}`;
  return [
    { type: 'STEP_STARTED', stepName: 'approve' },
    { type: 'TOOL_CALL_START', toolCallId: call, toolCallName: 'request_info' },
    { type: 'TOOL_CALL_ARGS', toolCallId: call, delta: JSON.stringify({ request_id: call }) },
    { type: 'TOOL_CALL_END', toolCallId: call },
    { type: 'CUSTOM', name: 'request_info', value: { request_id: call } },
    { type: 'STEP_FINISHED', stepName: 'approve' },
    {
      type: 'RUN_FINISHED',
      outcome: { type: 'interrupt', interrupts: [{ id: call, reason: 'tool_call', toolCallId: call, metadata: { agent_framework: { function_call: { name: fc.name, arguments: JSON.stringify(fc.arguments) }, checkpoint_id: checkpoint } } }] },
    },
  ];
}

const PLAN = { name: 'approve_plan', arguments: { steps: ['Write x.py'] } };

test('a plain answer streams: his words as deltas and the answer, the history sent on the thread', async (t) => {
  const host = await fakeHost(() => [{ type: 'STEP_STARTED', stepName: 'route' }, { type: 'STEP_FINISHED', stepName: 'route' }, ...words('a1', 'Port 43122 is ', 'REASONING'), ...words('a2', 'AG-UI.'), { type: 'RUN_FINISHED' }]);
  t.after(() => host.server.close());
  const events = [];
  const r = await agui.turn({
    url: host.url,
    threadId: THREAD,
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', tool_calls: [] }, { role: 'assistant', content: 'hello' }, { role: 'assistant', content: "**Claude's check**\n\nfine" }],
    text: 'which port?',
    approve: () => assert.fail('no card'),
    onEvent: (e) => events.push(e),
  });
  assert.equal(r.answer, 'Port 43122 is \n\nAG-UI.');
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), r.answer, 'streamed as it came');
  assert.deepEqual(events[events.length - 1], { type: 'answer', text: r.answer });
  const [body] = host.seen;
  assert.equal(body.threadId, THREAD);
  assert.deepEqual(body.messages.map((m) => [m.role, m.content]), [['user', 'hi'], ['assistant', 'hello'], ['user', 'which port?']], 'what was said, not tool calls or checks');
  assert.equal(body.resume, undefined);
});

test("a plan card is the Agent tab's card, and Approve resumes from its checkpoint", async (t) => {
  const host = await fakeHost((body, n) => {
    if (n === 1) return [...words('p', 'I will write x.py.', 'REASONING'), ...card(PLAN, 'ck-1')];
    return [
      { type: 'TOOL_CALL_START', toolCallId: 'w1', toolCallName: 'file_access_write' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'w1', delta: '{"file_name": "x.py",' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'w1', delta: ' "content": "x = 1"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'w1' },
      { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 'w1', content: 'wrote x.py' },
      ...words('e', 'Wrote x.py.', 'REASONING'),
      { type: 'RUN_FINISHED' },
    ];
  });
  t.after(() => host.server.close());
  const cards = [];
  const events = [];
  const r = await agui.turn({
    url: host.url,
    threadId: THREAD,
    text: 'Write x.py.',
    approve: async (name, args, summary) => (cards.push({ name, args, summary }), true),
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(cards, [{ name: 'approve_plan', args: PLAN.arguments, summary: `approve_plan ${JSON.stringify(PLAN.arguments, null, 2)}` }]);
  assert.ok(!events.some((e) => e.type === 'tool' && e.name === 'request_info'), 'the card is not a tool line');
  const resume = host.seen[1];
  assert.equal(resume.threadId, THREAD, 'the same thread');
  assert.deepEqual(resume.resume, [{ interruptId: 'rq-approve_plan', status: 'resolved', payload: { approved: true } }]);
  assert.equal(resume.forwardedProps.checkpointId, 'ck-1');
  assert.deepEqual(resume.messages, [], 'a resume carries no new message');
  assert.deepEqual(r.calls, [{ name: 'file_access_write', arguments: { file_name: 'x.py', content: 'x = 1' }, call_id: 'w1', result: 'wrote x.py' }]);
  assert.deepEqual(events.filter((e) => e.type === 'tool' || e.type === 'result'), [
    { type: 'tool', name: 'file_access_write', args: { file_name: 'x.py', content: 'x = 1' } },
    { type: 'result', name: 'file_access_write', text: 'wrote x.py' },
  ]);
  assert.equal(r.answer, 'I will write x.py.\n\nWrote x.py.');
});

test('Deny resumes with approved false, and the run ends on his words', async (t) => {
  const host = await fakeHost((body, n) => (n === 1 ? card(PLAN, 'ck-2') : [...words('no', 'Not approved; nothing was changed.'), { type: 'RUN_FINISHED' }]));
  t.after(() => host.server.close());
  const r = await agui.turn({ url: host.url, threadId: THREAD, text: 'Write x.py.', approve: async () => false });
  assert.deepEqual(host.seen[1].resume[0].payload, { approved: false });
  assert.equal(host.seen.length, 2, 'the No ends the turn');
  assert.equal(r.answer, 'Not approved; nothing was changed.');
});

test('a card whose checkpoint is gone (his host restarted) is said plainly', async (t) => {
  const host = await fakeHost((body, n) =>
    n === 1 ? card(PLAN, 'ck-3') : [{ type: 'RUN_ERROR', message: "Could not load workflow checkpoint 'ck-3': checkpoint 'ck-3' was not found", code: 'WORKFLOW_CHECKPOINT_LOAD_FAILED' }],
  );
  t.after(() => host.server.close());
  await assert.rejects(agui.turn({ url: host.url, threadId: THREAD, text: 'Write x.py.', approve: async () => true }), (e) => e.message === agui.RESTARTED);
  // any other error is his own words; a host that is not there says so
  const other = await fakeHost(() => [{ type: 'RUN_ERROR', message: 'the model is not loaded' }]);
  t.after(() => other.server.close());
  await assert.rejects(agui.turn({ url: other.url, threadId: THREAD, text: 'hi', approve: async () => true }), /^Error: Steward: the model is not loaded$/);
  const gone = await fakeHost(() => []);
  await new Promise((r) => gone.server.close(r)); // a port nothing listens on now
  await assert.rejects(agui.turn({ url: gone.url, threadId: THREAD, text: 'hi', approve: async () => true }), /AG-UI host did not answer \(ECONNREFUSED\)/);
});

test("with agent.transport 'ag-ui' the Agent tab's turn goes over AG-UI, its card is the window's card, and the session keeps it", async (t) => {
  const { AgentService } = require('./service.cjs');
  const { Vault } = require('../vaultfs.cjs');
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'agui-')));
  const host = await fakeHost((body, n) => (n === 1 ? card(PLAN, 'ck-4') : [...words('d', 'Done.'), { type: 'RUN_FINISHED' }]));
  t.after(() => host.server.close());
  const responses = [];
  let transport = 'ag-ui';
  const cards = [];
  const service = new AgentService({
    getVault: () => vault,
    getModel: () => ({ backend: 'steward', transport }),
    steward: {
      ensure: async () => responses.push('ensure') && 'http://responses',
      turn: async () => (responses.push('turn'), { answer: 'over Responses', previous: 'r1', calls: [] }),
      agui: { ensure: async () => host.url, turn: agui.turn },
    },
    emit: (channel, e) => channel === 'agent:approval' && cards.push(e),
  });
  const asked = service.ask({ text: 'Write x.py.', sessionId: 's1' });
  while (!cards.length) await new Promise((r) => setTimeout(r, 5));
  assert.equal(cards[0].name, 'approve_plan');
  assert.deepEqual(service.cards().map((c) => c.id), [cards[0].id], 'on the Approvals shelf too');
  assert.ok(service.answerApproval(cards[0].id, true, false));
  const r = await asked;
  assert.equal(r.answer, 'Done.');
  assert.deepEqual(responses, [], "his Responses service was not used");
  assert.equal(host.seen[0].threadId, 's1', 'the thread is the conversation');
  assert.match(host.seen[0].messages.at(-1).content, /\[from the PC \(Agent tab\)\]\nWrite x\.py\./);
  assert.deepEqual(service.open('s1').messages.map((m) => [m.role, m.content]), [['user', 'Write x.py.'], ['assistant', 'Done.']]);
  // off (the default 'responses'): the same conversation goes to his service
  transport = 'responses';
  assert.equal((await service.ask({ text: 'and now?', sessionId: 's1' })).answer, 'over Responses');
  assert.deepEqual(responses, ['ensure', 'turn']);
});

test('the AG-UI host is started like his other two: its script, its port in STEWARD_AG_UI_PORT, its own log', async () => {
  const steward = require('./steward.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  fs.mkdirSync(path.join(dir, ...agui.SCRIPT.slice(0, -1)), { recursive: true });
  fs.writeFileSync(path.join(dir, ...agui.SCRIPT), '');
  fs.mkdirSync(path.join(dir, '.venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.venv', 'Scripts', 'python.exe'), '');
  const started = [];
  const svc = steward.service({
    getConfig: () => ({ dir }),
    vaultDir: () => null,
    answering: async () => false,
    waitFor: async () => true,
    startOwned: (exe, args, cwd, env, logs) => (started.push({ args, port: env.STEWARD_AG_UI_PORT, logs }), { pid: 1, exitCode: null }),
    script: agui.SCRIPT,
    port: agui.PORT,
    log: 'steward-ag-ui.log',
    portEnv: 'STEWARD_AG_UI_PORT',
  });
  assert.equal(await svc.ensure(), 'http://127.0.0.1:43122');
  assert.deepEqual(started, [{ args: [path.join(...agui.SCRIPT)], port: '43122', logs: ['steward-ag-ui.log', 'steward-ag-ui.log'] }]);
  // main.cjs wires it: the service, the shelf entry, the stop on quit and the keep-up behind the setting
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  for (const wire of ["portEnv: 'STEWARD_AG_UI_PORT'", "id: 'steward-ag-ui'", 'stopOnQuit(app, [stewardService, stewardMcp, stewardAgui])', 'keepUpEvery(stewardAgui, agui.PORT', 'agui: { ensure:', "transport === 'ag-ui'"]) {
    assert.ok(main.includes(wire), `main.cjs: ${wire}`);
  }
  assert.equal(require('../settings.cjs').DEFAULTS.agent.transport, 'responses', 'nothing switched by default');
});
