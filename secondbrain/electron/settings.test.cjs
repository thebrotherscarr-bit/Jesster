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

// ---- Telegram's token from the ground's .env (TELEGRAM_STEWARDBOT_KEY) -----------------
const { telegramEffective } = require('./settings.cjs');
const { telegramEnvToken } = require('./atlasglass.cjs');
const FAKE_ENV = '111111:FAKE-env-token-zz9q';
function tempGround(envText) {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ground-'));
  fs.writeFileSync(path.join(g, 'manjuel.py'), '');
  if (envText !== undefined) fs.writeFileSync(path.join(g, '.env'), envText);
  return g;
}

test('the .env token is read from the ground the way findGround finds it; none without a ground or the name', () => {
  const g = tempGround(`OTHER=x\r\nTELEGRAM_STEWARDBOT_KEY=${FAKE_ENV}\r\n`);
  assert.equal(telegramEnvToken(g, null), FAKE_ENV);
  assert.equal(telegramEnvToken('', path.join(g, 'a', 'b')), FAKE_ENV, 'two up from the notes folder');
  assert.equal(telegramEnvToken(tempGround('OTHER=x\n'), null), '');
  assert.equal(telegramEnvToken(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-noground-')), null), '');
});

test('a token in Settings wins over the .env one', () => {
  const s = fresh();
  s.set('telegram', { token: '222222:SETTINGS-tok-abcd', enabled: true });
  const c = telegramEffective(s.get('telegram'), FAKE_ENV);
  assert.equal(c.token, '222222:SETTINGS-tok-abcd');
  assert.equal(c.from, 'settings');
});

test('with Settings empty the .env token is used, and Telegram is on without pressing anything', () => {
  const s = fresh();
  const c = telegramEffective(s.get('telegram'), FAKE_ENV);
  assert.equal(c.token, FAKE_ENV);
  assert.equal(c.from, 'env');
  assert.equal(c.enabled, true);
  // a settings file written before, with the default off and no token, is not an explicit off
  fs.writeFileSync(s.file, JSON.stringify({ telegram: { token: '', allowedChats: [], enabled: false } }));
  assert.equal(telegramEffective(new Settings(path.dirname(s.file)).get('telegram'), FAKE_ENV).enabled, true);
  // no token anywhere: off
  assert.equal(telegramEffective(fresh().get('telegram'), '').enabled, false);
});

test('an explicit off is kept, also across a restart', () => {
  const s = fresh();
  s.set('telegram', { enabled: false });
  assert.equal(telegramEffective(s.get('telegram'), FAKE_ENV).enabled, false);
  assert.equal(telegramEffective(new Settings(path.dirname(s.file)).get('telegram'), FAKE_ENV).enabled, false);
  assert.equal(s.public({ telegramEnv: FAKE_ENV }).telegram.enabled, false);
});

test('public() shows the .env token by its last four only, and never stores it', () => {
  const s = fresh();
  const p = s.public({ telegramEnv: FAKE_ENV });
  assert.equal(p.telegram.fromEnv, 'zz9q');
  assert.equal(p.telegram.token, '');
  assert.equal(p.telegram.enabled, true);
  const all = JSON.stringify(p);
  assert.ok(!all.includes(FAKE_ENV) && !all.includes('FAKE-env'), 'the value is not on the page');
  assert.ok(!fs.existsSync(s.file) || !fs.readFileSync(s.file, 'utf8').includes(FAKE_ENV), 'nor in settings.json');
  s.set('telegram', { token: '222222:SETTINGS-tok-abcd' });
  assert.equal(s.public({ telegramEnv: FAKE_ENV }).telegram.fromEnv, '', 'a Settings token: no .env hint');
});

test('main.cjs runs Telegram, its masked view and the report scrub on the .env token too', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /atlasGlass\.telegramEnvToken\(\(getSettings\(\)\.get\('atlas'\) \|\| \{\}\)\.ground, vaultDir\(\)\)/, 'the token is read from the ground findGround finds');
  assert.match(main, /gated\('telegram', telegramEffective\(getSettings\(\)\.get\('telegram'\), telegramEnv\(\)\)\)/, 'Telegram runs on the effective config');
  assert.match(main, /getConfig: telegramConfig,/, 'the bot reads it (start, the voice file fetch, the test message)');
  assert.equal((main.match(/getSettings\(\)\.public\(\{ telegramEnv: telegramEnv\(\) \}\)/g) || []).length, 2, 'settings:get and settings:set show its last four');
  assert.match(main, /\[st\.telegram\.token, telegramEnv\(\),/, 'and the report hides it');
});

test("the updater's repository is Settings' update.repo, read at every check, today's by default (ADR-0020)", () => {
  // updater.cjs takes `app` from Electron, which plain Node cannot load: a stand-in is put where require finds it
  const id = require.resolve('electron');
  const had = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: { app: { isPackaged: false } } };
  try {
    delete require.cache[require.resolve('./updater.cjs')];
    const updater = require('./updater.cjs');
    const { DEFAULTS } = require('./settings.cjs');
    assert.equal(DEFAULTS.update.repo, updater.REPO, 'the default is today\'s repository');
    assert.equal(updater.repo(), updater.REPO);
    let chosen = 'someone/fork';
    updater.useRepo(() => chosen);
    assert.equal(updater.repo(), 'someone/fork');
    assert.equal(updater.downloadPrefix(), 'https://github.com/someone/fork/releases/download/', 'downloads are held to it');
    chosen = 'https://evil.example/x';
    assert.equal(updater.repo(), updater.REPO, 'not owner/name: the default');
    chosen = '';
    assert.equal(updater.repo(), updater.REPO);
    updater.useRepo(null);
    // main.cjs hands Settings' update.repo over once, read at each check
    const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
    assert.match(main, /updater\.useRepo\(\(\) => \(getSettings\(\)\.get\('update'\) \|\| \{\}\)\.repo\);/);
    const src = fs.readFileSync(path.join(__dirname, 'updater.cjs'), 'utf8');
    assert.ok(!/\$\{REPO\}/.test(src), 'no URL is built from the constant');
  } finally {
    if (had) require.cache[id] = had;
    else delete require.cache[id];
    delete require.cache[require.resolve('./updater.cjs')];
  }
});
