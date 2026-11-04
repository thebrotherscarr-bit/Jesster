const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CHANNELS_ON, channelOn, gated } = require('./channels.cjs');
const { Discord } = require('./agent/discord.cjs');

// the operator, 2026-11-04: "Telegram and Whatsapp, not Discord yet"
test('Telegram and WhatsApp are on; Discord is off', () => {
  assert.equal(channelOn('telegram'), true);
  assert.equal(channelOn('whatsapp'), true);
  assert.equal(channelOn('discord'), false);
  assert.ok(!CHANNELS_ON.includes('discord'));
});

test('while Discord is off its bot never starts, even with a token and enabled saved', async () => {
  let reached = false;
  const bot = new Discord({
    getConfig: () => gated('discord', { token: 'TOKEN', enabled: true, allowedUsers: [] }),
    agent: {},
    apiBase: 'http://127.0.0.1:9',
    WebSocket: function () {
      reached = true;
    },
  });
  const st = await bot.start();
  assert.equal(bot.running, false);
  assert.equal(st.running, false);
  assert.equal(reached, false, 'no connection is opened');
});

test('main.cjs reads Discord through the gate and starts it only when on', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /getConfig: \(\) => gated\('discord', getSettings\(\)\.get\('discord'\)\)/);
  for (const line of main.split(/\r?\n/).filter((l) => /setTimeout\(\(\) => getDiscord\(\)\.start\(\)|settingsListeners\.push\(.*restartDiscord/.test(l))) {
    assert.match(line, /channelOn\('discord'\)/, `ungated start: ${line.trim()}`);
  }
});

test('main.cjs reads WhatsApp through the gate, starts it only when on, and the Phone view shows it only when on', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /getConfig: \(\) => gated\('whatsapp', getSettings\(\)\.get\('whatsapp'\)\)/);
  const starts = main.split(/\r?\n/).filter((l) => /setTimeout\(\(\) => getWhatsApp\(\)\.start\(\)|settingsListeners\.push\(.*restartWhatsApp/.test(l));
  assert.equal(starts.length, 2, 'started with the app and on a settings change');
  for (const line of starts) assert.match(line, /channelOn\('whatsapp'\)/, `ungated start: ${line.trim()}`);
  const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PhoneView.tsx'), 'utf8');
  assert.match(view, /\{channelOn\('whatsapp'\) && <WhatsAppSection \/>\}/);
});
