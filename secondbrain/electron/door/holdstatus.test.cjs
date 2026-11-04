const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const door = require('./index.cjs');
const atlas = require('../atlas.cjs');
const { Registry, core } = require('../agent/tools.cjs');
const { Vault } = require('../vaultfs.cjs');

// hold_status (registry.cjs), served by the app's door (index.cjs register): a seat learns how its held call
// ended -- waiting, approved with what the call answered, denied, or expired -- from the door's own holds log.

function ground() {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'door-hs-'));
  fs.writeFileSync(path.join(g, 'manjuel.py'), '');
  fs.writeFileSync(path.join(g, 'AGENTS.md'), 'the line');
  fs.mkdirSync(path.join(g, 'atlas'));
  fs.writeFileSync(path.join(g, 'atlas', 'AGENTS.md'), 'atlas line');
  return g;
}

function app(g) {
  const handlers = {};
  const d = door.register({
    atlas: { useDoor: () => {} },
    ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) },
    guard: () => {},
    getSettings: () => ({ get: () => ({ ground: g }) }),
    vaultDir: () => '',
  });
  return { d, handlers };
}

const idOf = (held) => held.match(/parked as (hold_\S+)/)[1];

test('hold_status: Steward, over /mcp, sees his held call wait, then how it ended -- approved with its answer, or denied', async () => {
  const g = ground();
  const { d, handlers } = app(g);
  const vault = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'door-hs-vault-')));
  const rpc = (id, method, params) => atlas.handleMcp({ jsonrpc: '2.0', id, method, params }, { registry: new Registry().add(core), ctx: { vault }, door: d });
  const status = async (id) => {
    const r = await rpc(9, 'tools/call', { name: 'hold_status', arguments: { id } });
    assert.equal(r.result.isError, false);
    return r.result.content[0].text;
  };
  try {
    const listed = (await rpc(1, 'tools/list')).result.tools.map((t) => t.name);
    assert.ok(listed.includes('hold_status'), 'served to Steward beside the other door tools');
    const held = (await rpc(2, 'tools/call', { name: 'remember', arguments: { text: 'keep this' } })).result.content[0].text;
    assert.match(held, /^HELD: "remember"/);
    const id = idOf(held);
    const waiting = JSON.parse(await status(id));
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.tool, 'remember');
    assert.ok(waiting.held, 'when it was parked');
    assert.equal(JSON.parse((await d.call('hold_list', {}, door.OPERATOR)).text).held.length, 1, 'asking parked nothing more');

    const ran = await handlers['door:answer']({}, id, 'approve');
    assert.match(ran.text, /^Approved/);
    const approved = JSON.parse(await status(id));
    assert.equal(approved.state, 'approved');
    assert.ok(approved.answered);
    assert.ok(approved.result && ran.text.includes(approved.result.trim()), 'the answer the call gave, from the holds log');

    const second = idOf((await d.call('remember', { text: 'not this' })).text);
    await handlers['door:answer']({}, second, 'deny');
    const denied = JSON.parse(await status(second));
    assert.equal(denied.state, 'denied');
    assert.equal(denied.result, undefined);

    assert.match(await status('hold_0_0_nothing'), /^Refused: no hold called hold_0_0_nothing is known/);
    assert.match(await status(''), /^Refused: name the hold/);
    const other = (await d.call('hold_status', { id }, { name: 'k-other', service: false })).text;
    assert.match(other, /^Refused: no hold called/, "another seat does not see this seat's holds");
    assert.equal(JSON.parse((await d.call('hold_status', { id }, door.OPERATOR)).text).state, 'approved', 'the operator sees any');
  } finally {
    d.stop();
  }
});

test('hold_status: a hold the door dropped on a restart reads expired, never waiting', async () => {
  const g = ground();
  const first = app(g);
  const id = idOf((await first.d.call('remember', { text: 'lost' })).text);
  first.d.stop();
  const again = app(g);
  try {
    const s = JSON.parse((await again.d.call('hold_status', { id })).text);
    assert.equal(s.state, 'expired');
    assert.match(s.note, /restarted/);
  } finally {
    again.d.stop();
  }
});
