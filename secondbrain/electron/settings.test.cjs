const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('./settings.cjs');

const fresh = () => new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-mask-')));

test('saving the masked token back keeps the real one', () => {
  const s = fresh();
  s.set('telegram', { token: '123456:REAL-abcd', enabled: false });
  const mask = s.public().telegram.token;
  s.set('telegram', { token: mask, enabled: true });
  assert.equal(s.get('telegram').token, '123456:REAL-abcd');
  assert.equal(s.get('telegram').enabled, true, 'the rest of the patch still lands');
  assert.equal(new Settings(path.dirname(s.file)).get('telegram').token, '123456:REAL-abcd', 'and on disk');
});

test('a token pasted onto the mask is refused; the stored one is kept', () => {
  const s = fresh();
  s.set('telegram', { token: '123456:REAL-abcd' });
  s.set('telegram', { token: s.public().telegram.token + '999:NEW-wxyz', enabled: true });
  assert.equal(s.get('telegram').token, '123456:REAL-abcd');
});

test('saving a new token replaces it', () => {
  const s = fresh();
  s.set('telegram', { token: '123456:REAL-abcd' });
  s.set('telegram', { token: '999:NEW-wxyz' });
  assert.equal(s.get('telegram').token, '999:NEW-wxyz');
  assert.equal(s.public().telegram.token, '••••••wxyz');
});

test('every masked secret is guarded: Discord, the share key, the integrations keys', () => {
  const s = fresh();
  s.set('discord', { token: 'DISCORD-1234' });
  s.set('share', { key: 'SHARE-5678' });
  s.set('integrations', { anthropic: { key: 'sk-ant-9012' }, openai: { key: 'sk-oa-3456' }, google: { key: 'g-7890' } });
  const p = s.public();
  s.set('discord', { token: p.discord.token });
  s.set('share', { key: p.share.key, enabled: true });
  s.set('integrations', { anthropic: { key: p.integrations.anthropic.key }, openai: { key: p.integrations.openai.key }, google: { key: p.integrations.google.key } });
  assert.equal(s.get('discord').token, 'DISCORD-1234');
  assert.equal(s.get('share').key, 'SHARE-5678');
  assert.equal(s.get('share').enabled, true);
  assert.equal(s.get('integrations').anthropic.key, 'sk-ant-9012');
  assert.equal(s.get('integrations').anthropic.model, 'claude-opus-5-5', 'merging keeps the model');
  assert.equal(s.get('integrations').openai.key, 'sk-oa-3456');
  assert.equal(s.get('integrations').google.key, 'g-7890');
});
