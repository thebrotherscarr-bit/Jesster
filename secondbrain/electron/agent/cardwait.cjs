/**
 * The card wait: how long a Steward card waits for the operator before it counts as No. One value for every place a
 * card can be answered away from the PC: Telegram's and Discord's buttons, an automation's cards and a card raised
 * from outside (service.cjs askCard, SecondBrain's approval_ask). The Agent tab's own cards wait for ever: he is at
 * the PC.
 *
 * The operator, 2026-11-08: "30 minutes" (it was 10 minutes; ExecPlan 0005 had proposed 60).
 */
const CARD_WAIT_MS = 30 * 60 * 1000;

/** A wait in words: minutes, or seconds under one minute (a test's short wait). */
function inWords(ms) {
  const m = Math.round(ms / 60000);
  if (m >= 1) return `${m} minute${m === 1 ? '' : 's'}`;
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? '' : 's'}`;
}

/** How a card that nobody answered reads in the chat once its buttons are gone. */
function timedOut(ms) {
  return `No answer in ${inWords(ms)}: denied`;
}

module.exports = { CARD_WAIT_MS, inWords, timedOut };
