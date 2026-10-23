const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const door = require('./index.cjs');
const { InnerDoor, TABLE } = require('./forward.cjs');

const CLIENT = { name: 'a client', service: false };
const OPERATOR = { name: 'operator', service: true };

function fakeInner() {
  const calls = [];
  return { calls, call: async (name, args) => (calls.push([name, args]), `ran ${name}`) };
}

test('the table is the Go door\'s 96, with its flags', () => {
  assert.equal(TABLE.length, 96);
  const by = Object.fromEntries(TABLE.map((t) => [t.name, t]));
  assert.ok(by.shell_run.serviceOnly && by.file_edit.serviceOnly && by.git_pr.serviceOnly);
  assert.deepEqual(by.git_branch.reads, ['list']);
  assert.deepEqual(by.secret_set.secrets, ['value']);
  assert.equal(by.suite_run.writes, false);
});

test('a forwarded write from a client is held in SecondBrain and never reaches the inner door', async () => {
  const inner = fakeInner();
  const reg = door.build([['research', fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'))]], { defaultProject: 'research', getInner: () => inner });
  assert.match(await reg.call('flow_run', { name: 'release' }, CLIENT), /^HELD: "flow_run" writes/);
  await assert.rejects(() => reg.call('shell_run', { shell: 'bash', command: 'ls' }, CLIENT), /operator's own hand/);
  assert.equal(inner.calls.length, 0, 'nothing was forwarded');
});

test('a forwarded read runs at once; the operator\'s call is forwarded with its world named', async () => {
  const inner = fakeInner();
  const reg = door.build([['research', fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'))]], { defaultProject: 'research', getInner: () => inner });
  assert.equal(await reg.call('rack_list', {}, CLIENT), 'ran rack_list');
  assert.equal(await reg.call('git_branch', { action: 'list' }, CLIENT), 'ran git_branch', 'a reading action is not held');
  assert.equal(await reg.call('shell_run', { shell: 'bash', command: 'ls', __caller: { service: true } }, OPERATOR), 'ran shell_run');
  assert.deepEqual(inner.calls[2], ['shell_run', { shell: 'bash', command: 'ls', project: 'research' }]);
});

test('the inner door is started with --auth and its own wire, and called as the operator', async () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-ground-'));
  fs.mkdirSync(path.join(g, 'atlas', 'line'), { recursive: true });
  fs.writeFileSync(path.join(g, 'atlas', 'line', 'atlas-mcp.exe'), '');
  const seen = [];
  const inner = new InnerDoor(g, {
    port: 1, // a port nothing answers on: the start check is skipped below
    fetchFn: async (url, init) => (seen.push([url, init]), { json: async () => ({ result: { content: [{ text: 'ok' }], isError: false } }) }),
  });
  inner.start = async () => {};
  assert.equal(await inner.call('rack_list', { project: 'research' }), 'ok');
  const [url, init] = seen[0];
  assert.equal(url, 'http://127.0.0.1:1/rpc');
  assert.equal(init.headers.Authorization, 'Bearer ' + inner.secret);
  assert.deepEqual(JSON.parse(init.body).params, { name: 'rack_list', arguments: { project: 'research' } });
  const args = inner.args();
  assert.ok(args.includes('--auth') && args.includes('--http') && args.includes(`research=${g.replace(/\\/g, '/')}`));
  assert.ok(!args.join(' ').includes(inner.secret), 'the wire is never on the command line');
});
