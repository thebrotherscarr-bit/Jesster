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

test("Steward's MCP door starts like his service: mcp_app.py on 43121, from his folder, with its own log", async () => {
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
  assert.equal(await door.ensure(), 'http://127.0.0.1:43121');
  assert.deepEqual(started, [{ exe: path.join(dir, '.venv', 'Scripts', 'python.exe'), args: [path.join(...steward.MCP_SCRIPT)], cwd: dir, logs: ['steward-mcp.log', 'steward-mcp.log'] }]);
  assert.equal(await steward.service(opts).ensure(), 'http://127.0.0.1:43999');
  assert.equal(started[1].args[0], path.join('harness', 'steward', 'step04_production_ready', 'hosted.py'), 'his service is unchanged');
  up = true; // one already answering (started by hand) is used as it is
  assert.equal(await door.ensure(), 'http://127.0.0.1:43121');
  assert.equal(started.length, 2);
});

test('every Steward process SecondBrain starts is handed the share URL and key, only while sharing is on (ADR-0020)', async () => {
  const steward = require('./steward.cjs');
  const url = 'http://127.0.0.1:43110/mcp';
  assert.deepEqual(steward.shareEnv({ enabled: true, key: 'k1' }, url), { SECONDBRAIN_SHARE_URL: url, SECONDBRAIN_SHARE_KEY: 'k1' });
  assert.deepEqual(steward.shareEnv({ enabled: false, key: 'k1' }, url), {}, 'sharing off: nothing');
  assert.deepEqual(steward.shareEnv({ enabled: true, key: '' }, url), {}, 'no key: nothing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  for (const f of [['.venv', 'Scripts', 'python.exe'], ['harness', 'steward', 'step04_production_ready', 'hosted.py']]) {
    fs.mkdirSync(path.join(dir, ...f.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(dir, ...f), '');
  }
  const envs = [];
  const svc = steward.service({
    getConfig: () => ({ dir }),
    vaultDir: () => null,
    answering: async () => false,
    waitFor: async () => true,
    startOwned: (exe, args, cwd, env) => envs.push(env),
    childEnv: () => steward.shareEnv({ enabled: true, key: 'k2' }, url),
  });
  await svc.ensure();
  assert.equal(envs[0].SECONDBRAIN_SHARE_KEY, 'k2');
  assert.equal(envs[0].SECONDBRAIN_SHARE_URL, url);
  assert.equal(envs[0].STEWARD_PORT, '43120', 'the port is still his');
  assert.equal(envs[0].SECONDBRAIN_MCP_KEY, process.env.SECONDBRAIN_MCP_KEY, "his .env's name is never set from here");
  // main.cjs hands it to all three: his service, his MCP door and his AG-UI host
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /const stewardChildEnv = \(\) => steward\.shareEnv\(getSettings\(\)\.get\('share'\), `\$\{APP_ORIGIN\}\/mcp`\);/);
  assert.equal((main.match(/childEnv: stewardChildEnv,/g) || []).length, 3);
});

test("Steward's folder is Settings' first, then STEWARD_DIR, then worlds\\steward beside the notes folder (ADR-0020)", () => {
  const steward = require('./steward.cjs');
  const make = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
    fs.mkdirSync(path.join(dir, 'harness', 'steward', 'step04_production_ready'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'harness', 'steward', 'step04_production_ready', 'hosted.py'), '');
    return dir;
  };
  const fromSettings = make();
  const fromEnv = make();
  // this PC's layout: <ground>\worlds\notes is the vault, <ground>\worlds\steward is Steward
  const worlds = fs.mkdtempSync(path.join(os.tmpdir(), 'worlds-'));
  const beside = path.join(worlds, 'steward');
  fs.mkdirSync(path.join(beside, 'harness', 'steward', 'step04_production_ready'), { recursive: true });
  fs.writeFileSync(path.join(beside, 'harness', 'steward', 'step04_production_ready', 'hosted.py'), '');
  const vault = path.join(worlds, 'notes');
  assert.equal(steward.findSteward(fromSettings, vault, undefined, { STEWARD_DIR: fromEnv }), fromSettings, 'Settings wins');
  assert.equal(steward.findSteward('', vault, undefined, { STEWARD_DIR: fromEnv }), fromEnv, 'then STEWARD_DIR');
  assert.equal(steward.findSteward('', vault, undefined, {}), beside, 'then the folder beside the notes (today on this PC)');
  assert.equal(steward.findSteward('', null, undefined, { STEWARD_DIR: fromEnv }), fromEnv, 'a clone anywhere, with no vault layout');
  assert.equal(steward.findSteward('', null, undefined, { STEWARD_DIR: path.join(worlds, 'nothing') }), null, 'a STEWARD_DIR without Steward in it is passed over');
});

test("Steward's Python is the venv's Scripts\\python.exe, else its bin/python (a venv built off Windows; ADR-0020)", () => {
  const steward = require('./steward.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  const win = path.join(dir, '.venv', 'Scripts', 'python.exe');
  const posix = path.join(dir, '.venv', 'bin', 'python');
  assert.equal(steward.venvPython(dir), win, 'neither: the Windows path, for the error');
  fs.mkdirSync(path.dirname(posix), { recursive: true });
  fs.writeFileSync(posix, '');
  assert.equal(steward.venvPython(dir), posix, 'only bin/python: that one');
  fs.mkdirSync(path.dirname(win), { recursive: true });
  fs.writeFileSync(win, '');
  assert.equal(steward.venvPython(dir), win, 'Scripts\\python.exe wins, as today');
});

test("the Steward window's Stop ends the Python on his port and its tree, holds it, and Start or Restart brings it back", async () => {
  const steward = require('./steward.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  for (const f of [['.venv', 'Scripts', 'python.exe'], steward.MCP_SCRIPT]) {
    fs.mkdirSync(path.join(dir, ...f.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(dir, ...f), '');
  }
  let up = true;
  let owner = { pid: 4242, name: 'python.exe' };
  const killed = [];
  const started = [];
  const door = steward.service({
    getConfig: () => ({ dir }),
    vaultDir: () => null,
    answering: async () => up,
    waitFor: async (port, ms, probe, gone) => (gone ? !up : up),
    startOwned: (exe, args) => {
      started.push(args[0]);
      up = true;
      return { pid: 99, exitCode: null };
    },
    portOwner: () => owner,
    killTree: (pid) => {
      killed.push(pid);
      up = false;
    },
    script: steward.MCP_SCRIPT,
    port: steward.MCP_PORT,
  });
  await door.stop();
  assert.deepEqual(killed, [4242], 'the Python listening on 43121, and its tree');
  assert.equal(door.held(), true);
  assert.equal(await steward.keepUp(door, false), false, 'a stop by the user is not undone by the status check');
  await door.start();
  assert.equal(door.held(), false);
  assert.deepEqual(started, [path.join(...steward.MCP_SCRIPT)]);
  up = false;
  assert.equal(await steward.keepUp(door, false), true, 'found down and not stopped: started again');
  await door.restart();
  assert.deepEqual(killed.slice(-2), [4242, 99], 'restart stops the listener and the child it started, then starts');
  assert.equal(up, true);
  // another program on the port (one SecondBrain did not start) is never killed, and the stop says so
  const other = steward.service({
    getConfig: () => ({ dir }),
    vaultDir: () => null,
    answering: async () => true,
    waitFor: async (port, ms, probe, gone) => !gone,
    startOwned: () => ({ pid: 1, exitCode: null }),
    portOwner: () => ({ pid: 7, name: 'ComfyUI.exe' }),
    killTree: (pid) => killed.push(pid),
    script: steward.MCP_SCRIPT,
    port: steward.MCP_PORT,
  });
  killed.length = 0;
  await assert.rejects(other.stop(), /still answers/);
  assert.deepEqual(killed, [], 'a program that is not his is never killed');
});

test("SecondBrain quitting stops Steward's two services it started, each with its process tree; one started by hand is left", async () => {
  const steward = require('./steward.cjs');
  const { EventEmitter } = require('events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  for (const f of [['.venv', 'Scripts', 'python.exe'], ['harness', 'steward', 'step04_production_ready', 'hosted.py'], steward.MCP_SCRIPT]) {
    fs.mkdirSync(path.join(dir, ...f.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(dir, ...f), '');
  }
  const killed = [];
  const up = new Set();
  const make = (port, script, launcher, python) =>
    steward.service({
      getConfig: () => ({ dir }),
      vaultDir: () => null,
      answering: async (p) => up.has(p),
      waitFor: async (p, ms, probe, gone) => (gone ? !up.has(p) : up.has(p)),
      startOwned: () => {
        up.add(port);
        return { pid: launcher, exitCode: null };
      },
      // the venv launcher's real Python is the one on the port
      portOwner: (p) => (up.has(p) ? { pid: python, name: 'python.exe' } : null),
      killTree: (pid) => {
        killed.push(pid);
        if (pid === python) up.delete(port);
      },
      script,
      port,
    });
  const svc = make(43120, undefined, 10, 11);
  const mcp = make(43121, steward.MCP_SCRIPT, 20, 21);
  await svc.ensure();
  await mcp.ensure();
  assert.equal(svc.pid(), 10);
  assert.match(svc.started(), /^\d{4}-\d\d-\d\dT/);
  const app = new EventEmitter();
  steward.stopOnQuit(app, [svc, mcp]);
  app.emit('before-quit');
  assert.deepEqual(killed, [11, 10, 21, 20], 'the Python on each port and the launcher, each by its tree, before quit goes on');
  assert.equal(svc.pid(), null);
  // a Steward started by hand (SecondBrain holds no child of it) outlives SecondBrain
  killed.length = 0;
  const byHand = make(43120, undefined, 30, 31);
  up.add(43120);
  await byHand.ensure();
  steward.stopOnQuit(app, [byHand]);
  app.emit('before-quit');
  assert.deepEqual(killed, []);
});

/**
 * keepUpEvery's tests run on a virtual clock (node:test's mock timers: setInterval, setTimeout and Date), advanced one
 * millisecond at a time with the promises each step starts settled before the next. They had run on the real clock,
 * counting starts inside a 120 ms window of 5 ms intervals and 2 ms sleeps, and failed two release builds on GitHub's
 * Windows runner ("a crashed start is retried (1)", 2026-11-05 and 2026-11-06) while passing in pull request checks:
 * Windows wakes a timer on its ~15.6 ms system tick (a 2 ms setTimeout measured 15.5 ms at the median on the
 * operator's PC), so a busy runner fitted only one start into the window. On the virtual clock every run is the same.
 */
function virtualClock(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  return async (ms) => {
    for (let i = 0; i < ms; i++) {
      t.mock.timers.tick(1);
      // setImmediate is not mocked: it runs once every promise the tick started has settled
      await new Promise((r) => setImmediate(r));
    }
  };
}

test('keepUpEvery brings a service back when its port is down, never one the user stopped', async (t) => {
  const { keepUpEvery } = require('./steward.cjs');
  const advance = virtualClock(t);
  let held = false;
  let ensured = 0;
  let up = false;
  const svc = { held: () => held, ensure: async () => { ensured++; up = true; } };
  const timer = keepUpEvery(svc, 43121, async () => up, 5);
  await advance(40);
  assert.strictEqual(ensured, 1, 'started once, then found up');
  up = false;
  held = true;
  await advance(30);
  assert.strictEqual(ensured, 1, 'a service the user stopped stays stopped');
  clearInterval(timer);
});

test('keepUpEvery never starts a second copy while the first is still starting; a crashed or hung start is retried', async (t) => {
  const steward = require('./steward.cjs');
  const advance = virtualClock(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  for (const f of [['.venv', 'Scripts', 'python.exe'], steward.MCP_SCRIPT]) {
    fs.mkdirSync(path.join(dir, ...f.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(dir, ...f), '');
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const make = (start, extra = {}) => {
    const st = { up: false, spawned: 0, killed: [] };
    const svc = steward.service({
      getConfig: () => ({ dir }),
      vaultDir: () => null,
      answering: async () => st.up,
      waitFor: async (port, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (st.up) return true;
          await sleep(2);
        }
        return st.up;
      },
      startOwned: () => {
        st.spawned++;
        return start(st);
      },
      killTree: (pid) => st.killed.push(pid),
      script: steward.MCP_SCRIPT,
      port: steward.MCP_PORT,
      wait: 15,
      ...extra,
    });
    const timer = steward.keepUpEvery(svc, steward.MCP_PORT, async () => st.up, 5);
    return { st, timer };
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    // mcp_app.py loading its tools: the port comes up after several intervals and past the first wait
    const slow = make((st) => {
      setTimeout(() => (st.up = true), 80);
      return { pid: 1, exitCode: null };
    }, { startLimit: 1000 });
    await advance(150);
    clearInterval(slow.timer);
    assert.strictEqual(slow.st.up, true);
    assert.strictEqual(slow.st.spawned, 1, 'one start, waited for; no second copy on the port');
    assert.deepEqual(slow.st.killed, []);
    // a start that crashed (its child exited) is tried again
    const crash = make(() => {
      const c = { pid: 2, exitCode: null };
      setTimeout(() => (c.exitCode = 1), 3);
      return c;
    });
    await advance(120);
    clearInterval(crash.timer);
    assert.ok(crash.st.spawned >= 2, `a crashed start is retried (${crash.st.spawned})`);
    // one alive but still not answering past the start limit is ended, then started again
    const hung = make(() => ({ pid: 3, exitCode: null }), { startLimit: 40 });
    await advance(150);
    clearInterval(hung.timer);
    assert.ok(hung.st.spawned >= 2, `a hung start is retried (${hung.st.spawned})`);
    assert.ok(hung.st.killed.includes(3), 'the hung one is ended first');
  } finally {
    console.error = quiet;
  }
});

test("main.cjs keeps Steward's MCP door up from the main process", () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /steward\.keepUpEvery\(stewardMcp, steward\.MCP_PORT,/);
});

test("main.cjs hands Steward's three services to stopOnQuit", () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /steward\.stopOnQuit\(app, \[stewardService, stewardMcp, stewardAgui\]\)/);
});

test("a conversation keeps Steward's thread across a restart", async () => {
  const { threads } = require('./steward.cjs');
  const { AgentService } = require('./service.cjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'threads-')), 'steward-threads.json');
  const vault = vaultWith([]);
  const seen = [];
  const steward = {
    ensure: async () => 'http://steward',
    turn: async ({ previous }) => {
      seen.push(previous);
      return { answer: 'ok', previous: `r${seen.length}`, calls: [] };
    },
  };
  const model = () => ({ backend: 'steward' });
  const first = new AgentService({ getVault: () => vault, getModel: model, steward, threads: threads(file) });
  const { sessionId } = await first.ask({ text: 'read the ADR note and report' });
  await first.ask({ text: 'and the next one', sessionId });
  // a new service is what SecondBrain has after a restart
  const second = new AgentService({ getVault: () => vault, getModel: model, steward, threads: threads(file) });
  await second.ask({ text: "what's on my watchlist?", sessionId });
  assert.deepEqual(seen, [undefined, 'r1', 'r2']);
});

test("the tab sends Steward's workflow only the text, and his text streams", async () => {
  const { turn } = require('./steward.cjs');
  const bodies = [];
  const events = [];
  const stream = async (url, body, signal, onFrame) => {
    bodies.push(body);
    onFrame({ type: 'response.output_text.delta', delta: 'Plan: ' });
    onFrame({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' });
    return { id: 'r1', status: 'completed', output: [] };
  };
  await turn({ base: 'http://steward', text: 'fix the test', previous: 'r0', approve: async () => true, stream, onEvent: (e) => events.push(e) });
  assert.deepEqual(bodies[0], { input: 'fix the test', stream: true, previous_response_id: 'r0' }, 'no response_format, no metadata.agent_mode');
  assert.deepEqual(events.slice(0, 2), [{ type: 'delta', text: 'Plan: ' }, { type: 'thinking', text: 'thinking' }]);
});

test("an improve conversation names the loop on every request, and its review goes back as function_call_output", async () => {
  const { turn } = require('./steward.cjs');
  const bodies = [];
  const events = [];
  const answers = [
    { id: 'r1', status: 'completed', output: [{ type: 'function_call', name: 'request_info', call_id: 'c1', arguments: JSON.stringify({ request_id: 'c1', request: { prompt: "Reply 'keep', 'drop', or guidance", attempt: 1, passed: true } }) }] },
    { id: 'r2', status: 'completed', output: [{ type: 'message', content: [{ text: 'Decision: keep' }] }] },
  ];
  const stream = async (url, body) => {
    bodies.push(body);
    return answers[bodies.length - 1];
  };
  const asked = [];
  const metadata = { steward_workflow: 'improve' };
  const r = await turn({ base: 'http://steward', text: 'improve: the plan comes back as prose', approve: async () => true, review: async (q) => (asked.push(q), 'keep'), metadata, stream, onEvent: (e) => events.push(e) });
  assert.deepEqual(bodies[0].metadata, metadata);
  assert.deepEqual(bodies[1], { input: [{ type: 'function_call_output', call_id: 'c1', output: 'keep' }], stream: true, metadata, previous_response_id: 'r1' });
  assert.equal(asked[0].passed, true, 'the review gets the request the loop sent');
  assert.equal(r.answer, 'Decision: keep');
  assert.ok(!events.some((e) => e.type === 'tool' && e.name === 'request_info'), 'the question is not shown as a tool call');
});

test('a conversation that starts with "improve:" sends the loop on every turn, and a message at the review is its guidance', async () => {
  const { AgentService } = require('./service.cjs');
  const vault = vaultWith([]);
  const sent = [];
  const replies = [];
  const steward = {
    ensure: async () => 'http://steward',
    turn: async ({ text, metadata, review }) => {
      sent.push({ text, metadata });
      if (text.startsWith('improve:')) replies.push(await review({ prompt: 'keep or drop', attempt: 1, passed: true }));
      return { answer: 'ok', previous: `r${sent.length}`, calls: [] };
    },
  };
  const cards = [];
  const done = [];
  const service = new AgentService({
    getVault: () => vault,
    getModel: () => ({ backend: 'steward' }),
    steward,
    emit: (channel, e) => {
      if (channel === 'agent:approval') cards.push(e);
      if (channel === 'agent:event' && e.type === 'done') done.push(e);
    },
  });
  const first = service.ask({ text: 'improve: the plan comes back as prose' });
  while (!cards.length) await new Promise((r) => setImmediate(r));
  assert.equal(cards[0].kind, 'review');
  const typed = await service.ask({ text: 'also keep the steps short', sessionId: cards[0].sessionId });
  assert.equal(typed.answeredReview, true);
  await first;
  assert.deepEqual(replies, ['also keep the steps short'], 'typed at the review: its guidance, not a drop');
  await service.ask({ text: 'and now the commit message', sessionId: cards[0].sessionId });
  assert.deepEqual(sent.map((s) => s.metadata), [{ steward_workflow: 'improve' }, { steward_workflow: 'improve' }]);
  const plain = new AgentService({ getVault: () => vault, getModel: () => ({ backend: 'steward' }), steward, emit: () => {} });
  await plain.ask({ text: 'fix the test' });
  assert.equal(sent[sent.length - 1].metadata, undefined, 'other conversations are untouched');
});

test('a message sent while a card waits answers it No, then goes to Steward next', async () => {
  const { AgentService } = require('./service.cjs');
  const vault = vaultWith([]);
  const asked = [];
  const answers = [];
  const steward = {
    ensure: async () => 'http://steward',
    turn: async ({ text: sent, approve }) => {
      const text = sent.startsWith('[') ? sent.slice(sent.indexOf(']') + 2) : sent; // the source line withSource adds
      asked.push(text);
      if (text === 'fix the test') answers.push(await approve('approve_plan', { plan: '1. fix' }, 'approve_plan'));
      return { answer: 'ok', previous: `r${asked.length}`, calls: [] };
    },
  };
  const cards = [];
  const done = [];
  const service = new AgentService({
    getVault: () => vault,
    getModel: () => ({ backend: 'steward' }),
    steward,
    emit: (channel, e) => {
      if (channel === 'agent:approval') cards.push(e);
      if (channel === 'agent:event' && e.type === 'done') done.push(e);
    },
  });
  const first = service.ask({ text: 'fix the test' });
  while (!cards.length) await new Promise((r) => setImmediate(r));
  const r = await service.ask({ text: 'no, only read it', sessionId: cards[0].sessionId });
  assert.equal(r.queued, true);
  await first;
  while (!done.length) await new Promise((r) => setImmediate(r));
  assert.deepEqual(answers, [false], 'the waiting card is answered No');
  assert.deepEqual(asked, ['fix the test', 'no, only read it'], 'the message goes to Steward next');
  assert.equal(done.length, 1, 'the tab stays busy until the second turn ends');
});

test('Steward is reached over AG-UI by default; its host down, the turn falls back to Responses with one console line', async () => {
  const { AgentService } = require('./service.cjs');
  const { stewardTransport } = require('../settings.cjs');
  assert.equal(stewardTransport({}), 'ag-ui');
  assert.equal(stewardTransport({ transport: 'responses' }), 'ag-ui', 'the old default written back is not a choice');
  assert.equal(stewardTransport({ transport: 'responses', transportChosen: true }), 'responses');
  const vault = vaultWith([]);
  const used = [];
  const logged = [];
  let down = false;
  let model = { backend: 'steward' };
  const service = new AgentService({
    getVault: () => vault,
    getModel: () => model,
    log: (line) => logged.push(line),
    steward: {
      ensure: async () => 'http://responses',
      turn: async () => (used.push('responses'), { answer: 'over Responses', previous: 'r1', calls: [] }),
      agui: {
        ensure: async () => {
          if (down) throw new Error('did not answer on port 43122');
          return 'http://agui/';
        },
        turn: async ({ url, text }) => (used.push(`ag-ui ${url}`), { answer: `over AG-UI: ${text.split('\n')[0].slice(0, 24)}`, calls: [] }),
      },
    },
  });
  assert.equal((await service.ask({ text: 'hi' })).answer, 'over AG-UI: [from the PC (Agent tab)');
  assert.equal((await service.ask({ text: 'hi', source: 'telegram' })).answer.startsWith('over AG-UI'), true, 'the phone too');
  assert.equal((await service.ask({ text: 'go', source: 'automation', automation: 'Startup', save: false })).answer.startsWith('over AG-UI'), true, 'and automations');
  down = true;
  assert.equal((await service.ask({ text: 'hi' })).answer, 'over Responses');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /AG-UI host \(43122\) is down \(did not answer on port 43122\); this turn goes over Responses \(43120\)/);
  model = { backend: 'steward', transport: 'responses', transportChosen: true };
  down = false;
  assert.equal((await service.ask({ text: 'hi' })).answer, 'over Responses', 'Responses when he chose it');
  assert.deepEqual(used, ['ag-ui http://agui/', 'ag-ui http://agui/', 'ag-ui http://agui/', 'responses', 'responses']);
});
