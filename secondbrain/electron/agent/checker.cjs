/**
 * Claude's check of a Steward turn, live in the Agent tab (Kyle, 2026-10-29: "tie in the API from
 * Claude to be able to check the shit in real time without having to jump back and forth").
 *
 * After each Steward turn, the turn as it happened (the message, every tool Steward called with
 * what it returned, and his answer) goes to Claude with Steward's Charter. Claude says whether the
 * answer holds up against the tool results, what it claims that nothing showed, which rule it
 * broke, and the next step. The check is shown under the answer and kept in the session note.
 * It runs on the Claude key and model in Settings → Integrations, only while the switch in
 * Settings → Claude's check is on.
 */

const MAX_RESULT = 1500; // characters of each tool result shown to Claude
const MAX_ANSWER = 6000;

// whose system it is, as the prompts name him: Settings' owner (Steward ADR-0020), today's name the default
const OWNER = 'Kyle';

/** The check's instructions, naming the system's owner. */
const system = (owner = OWNER) => `You check the work of Steward, a small local agent, one turn at a time, for ${owner}, who owns the system.
You get Steward's Charter (what he is, what binds him), ${owner}'s message, every tool Steward called with what it returned, and Steward's answer.

Check, against the tool results only:
- Does each claim in the answer match what a tool actually returned? Name any claim nothing showed.
- Did a tool call fail, come back empty because it was called wrong, or get misused?
- Did Steward break a rule in his Charter (the gate, evidence, scope, keys, doing only what was asked)?
- Did he do what ${owner} asked?

Answer in at most 8 short lines, plain words, no preamble:
first line "Holds up." or "Problems:", then the points, then one line "Next:" with the single most useful next step.
If you cannot tell from the evidence, say so instead of guessing.`;
const SYSTEM = system();

function clip(text, n) {
  const s = String(text == null ? '' : text);
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s;
}

/** The turn, written out for Claude: the message, each tool call and its result, the answer. */
function transcript({ text, calls = [], answer = '' }, owner = OWNER) {
  const lines = [`## ${owner}'s message\n${text}`, '## What Steward did'];
  if (!calls.length) lines.push('(no tool calls)');
  calls.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.name} ${clip(JSON.stringify(c.arguments || {}), 600)}`);
    lines.push(`   returned: ${c.result === undefined ? '(no result recorded)' : clip(c.result, MAX_RESULT)}`);
  });
  lines.push(`## Steward's answer\n${clip(answer, MAX_ANSWER)}`);
  return lines.join('\n');
}

/**
 * One check. `chat` is integrations.chat; `config` is { key, model }; `charter` the Charter text; `owner` the name
 * the prompts give the system's owner (Settings' owner). Resolves the check text. Throws when there is no key or the
 * call fails.
 */
async function check({ chat, config, charter, turn, signal, owner = OWNER }) {
  const content = `${charter ? `## Steward's Charter\n${charter}\n\n` : ''}${transcript(turn, owner)}`;
  return chat({ provider: 'anthropic', key: config.key, model: config.model, system: system(owner), messages: [{ role: 'user', content }], signal });
}

module.exports = { check, transcript, system, SYSTEM, OWNER, MAX_RESULT };
