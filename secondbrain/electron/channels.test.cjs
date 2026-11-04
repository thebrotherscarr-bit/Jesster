const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CHANNELS_ON, channelOn, gated } = require('./channels.cjs');
const { Discord } = require('./agent/discord.cjs');

// the operator, 2026-11-04: "Telegram and Whatsapp, not Discord yet"
test('Telegram is on; Discord is off', () => {
  assert.equal(channelOn('telegram'), true);
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
