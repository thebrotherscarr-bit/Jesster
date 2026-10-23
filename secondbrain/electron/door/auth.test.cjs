const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('./auth.cjs');
const { build } = require('./index.cjs');

const GLASS = { name: 'glass', service: true };
const CLIENT = { name: 'seat', service: false };

test('the KDF is the Go door\'s, byte for byte (tests/fixtures/auth_vectors.json kdf_example)', () => {
  assert.equal(auth.kdf('atl_abababababababababababababababab', '00000000000000000000000000000000'), '32eb098ff16fc1c8b48b12a51b28d40b726e2efaee2058995f3d57eb3dafb435');
  assert.equal(auth.ITERS, 210000);
  assert.equal(auth.DOMAIN, 'atlas-auth-v1');
});

test('keys: minted once, verified, listed without hashes, scoped, revoked; re-proof once the store has one', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'door-auth-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'door-auth2-'));
  const reg = build([['w', home], ['atlas', other]], { defaultProject: 'w' });
  assert.equal(await reg.call('auth_key_list', {}, CLIENT), 'no live keys — the gate stands open (bootstrap)');
  assert.match(await reg.call('auth_key_create', { name: 'council' }, CLIENT), /^HELD: "auth_key_create"/);
  const minted = await reg.call('auth_key_create', { name: 'council' }, GLASS);
  const [, kid, key] = minted.match(/^MINTED (k-[0-9a-f]{8}) for "council" on "w" — copy it now, it never shows again\n(atl_[0-9a-f]{32})$/);
  const stored = fs.readFileSync(path.join(home, 'state', 'auth.json'), 'utf8');
  assert.ok(!stored.includes(key), 'only the hash and salt persist');
  assert.equal(await reg.call('auth_verify', { key }, CLIENT), `VERIFIED ${kid} on "w" · tenants [w]`);
  await assert.rejects(reg.call('auth_verify', { key: 'atl_' + '0'.repeat(32) }, CLIENT), /unknown or revoked key/);
  assert.match(await reg.call('auth_key_list', {}, CLIENT), new RegExp(`KEYS on "w" — 1 live:\\n  ${kid} "council" · tenants \\[w\\] · minted `));
  await assert.rejects(reg.call('auth_key_create', { name: 'second' }, GLASS), /names a live key — possession re-proved/);
  await assert.rejects(reg.call('auth_key_scope', { id: kid, tenants: 'w,mars', key }, GLASS), /"mars" is not a carried tenant/);
  assert.equal(await reg.call('auth_key_scope', { id: kid, tenants: 'w,atlas', key }, GLASS), `SCOPED ${kid} "council" on "w" — it carries [w,atlas] now; the move is in the audit line`);
  const parked = await reg.call('auth_key_revoke', { id: kid, key }, CLIENT);
  const id = parked.match(/parked as (hold_\S+)/)[1];
  const shown = JSON.parse(await reg.call('hold_list', {}, GLASS)).held.find((h) => h.id === id).args;
  assert.equal(shown.key, '[withheld: a secret; the parked call keeps it]');
  assert.match(await reg.call('hold_answer', { id, decision: 'approve' }, GLASS), new RegExp(`REVOKED ${kid} on "w" — folded, kept for audit`));
  assert.equal(await reg.call('auth_key_list', {}, CLIENT), 'no live keys — the gate stands open (bootstrap)');
  const audit = fs
    .readFileSync(path.join(home, 'state', 'auth_audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).action);
  assert.deepEqual(audit, ['create', 'scope', 'revoke']);
});
