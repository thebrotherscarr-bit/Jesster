/**
 * The phone channels that are switched on (the operator, 2026-11-04: "Telegram and Whatsapp, not Discord yet").
 * channels.json is the one list, read here by the main process and by the page (src/utils/channels.ts); add
 * 'whatsapp' when it lands and 'discord' to bring Discord back. A channel that is off never starts its bot.
 */
const { on } = require('./channels.json');

const CHANNELS_ON = Object.freeze([...on]);
const channelOn = (name) => CHANNELS_ON.includes(name);

/** A channel's settings as its bot reads them: `enabled` is false while the channel is off. */
function gated(name, cfg) {
  return channelOn(name) ? cfg : { ...(cfg || {}), enabled: false };
}

module.exports = { CHANNELS_ON, channelOn, gated };
