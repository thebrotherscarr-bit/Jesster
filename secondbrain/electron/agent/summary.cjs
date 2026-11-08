/**
 * The run's summary for the phone (Steward's ADR-0016, "never end silently", and ExecPlan 0005 M1): when a turn from
 * the phone or an automation ends, done, failed, denied or stopped, Jesster sends one short message saying what was
 * asked, what ran, what it changed, and how it ended.
 *
 * It is built from what the turn itself recorded (service.cjs ask): the tool calls Steward made (the 'tool' events of
 * every transport), the cards and how each was answered, and the turn's error. A plain answer with no tool, no card
 * and no error needs none: the answer is the end of that run.
 */

const { inWords: wait } = require('./cardwait.cjs');

const MAX_ASKED = 120;
const MAX_LIST = 8;
// a call whose name says it changes something: its path, file or flow is named under "Changed"
const CHANGES = /(write|edit|append|replace|create|delete|remove|save|commit|move|copy|install|upgrade|restart|control|flow_run|_run$|^run_)/i;
const TARGETS = ['path', 'file_path', 'file', 'filename', 'note', 'note_id', 'flow', 'flow_id', 'service', 'package', 'command'];
// how a card that ended the run was answered, in words (service.cjs answerApproval's answers; 'refused' is WhatsApp's)
const STOPS = { deny: 'you answered No', timeout: 'no answer in time (counted as No)', refused: 'refused here: it needs approval from the PC or Telegram' };

const short = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The message without its source line (service.cjs withSource puts it first, or last after an improve: word). */
function asked(text) {
  return short(String(text || '').replace(/^\[[^\]\n]*\]\n/, '').replace(/\n\n\[[^\]\n]*\]$/, ''), MAX_ASKED);
}

function list(items) {
  const uniq = [...new Set(items)];
  return uniq.length > MAX_LIST ? `${uniq.slice(0, MAX_LIST).join(', ')} and ${uniq.length - MAX_LIST} more` : uniq.join(', ');
}

/** What a changing call touched: the first of its target arguments, or its name. */
function target(call) {
  const a = call.args && typeof call.args === 'object' ? call.args : {};
  for (const k of TARGETS) if (typeof a[k] === 'string' && a[k].trim()) return short(a[k], 80);
  return call.name;
}

/** Whether a turn needs a summary: it ran a tool, raised a card, was refused something, failed or was stopped. */
function needed(run) {
  return Boolean(run && (run.calls.length || run.cards.length || run.error));
}

/**
 * The summary text. run: { text, calls: [{ name, args }], cards: [{ name, answer }], error, stopped, answer };
 * `cardWaitMs` names the card wait when a card timed out.
 */
function summarize(run, { cardWaitMs = 0 } = {}) {
  const lines = ['Summary'];
  lines.push(`Asked: ${asked(run.text) || '(nothing)'}`);
  const ran = run.calls.map((c) => c.name).filter(Boolean);
  lines.push(`Ran: ${ran.length ? list(ran) : 'nothing'}`);
  const changed = run.calls.filter((c) => CHANGES.test(c.name || '')).map(target);
  if (changed.length) lines.push(`Changed: ${list(changed)}`);
  // an improvement round's review (keep, drop, guidance) is not a card that stops the run
  const cards = run.cards.filter((c) => c.answer !== 'keep' && c.answer !== 'drop' && c.answer !== 'guidance');
  const stop = cards.find((c) => STOPS[c.answer]);
  if (run.stopped) lines.push('Result: stopped (/stop). Anything after the stop did not run.');
  else if (run.error) lines.push(`Result: failed: ${short(run.error, 300)}`);
  else if (stop) {
    const why = stop.answer === 'timeout' && cardWaitMs ? `no answer in ${wait(cardWaitMs)} (counted as No)` : STOPS[stop.answer];
    lines.push(`Result: stopped at the ${stop.name} card: ${why}.`);
    lines.push(`Done: ${ran.length ? list(ran) : 'nothing'}. Left: ${stop.name} and what the plan had after it; nothing after the card ran.`);
  } else lines.push(`Result: done${cards.length ? ` (${cards.length} card${cards.length === 1 ? '' : 's'} approved)` : ''}.`);
  return lines.join('\n');
}

module.exports = { summarize, needed, asked, CHANGES };
