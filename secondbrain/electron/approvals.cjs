/**
 * The Approvals shelf: every open card in one queue, newest first, and which of Steward's tools ask (the note
 * plan-secondbrain-services-page-servers-m-42e7bf).
 *
 * Two planes hold cards. The Agent tab's (service.cjs cards(): Steward's approval requests and the improvement
 * loop's reviews) and the door's holds (hold_list, read as the operator, as HoldsDock and the GitHub shelf read
 * them). This only reads them: a card is answered where it always was (agent:approve, door:call hold_answer).
 *
 * Steward's tool policy is his file, storage/tool-policy.json in his folder; SecondBrain reads it and nothing else
 * there, and never writes it.
 */
const fs = require('fs');
const path = require('path');

const POLICY_FILE = ['storage', 'tool-policy.json'];
const APPROVALS = ['always', 'never', 'rule'];

/**
 * One queue of open cards. `cards()` is the agent service's; `holds()` is the door's hold_list answer
 * ({ text, isError }). Each item is { plane: 'agent' | 'door', id, tool, at, ... }; a door that cannot be read
 * leaves the agent's cards standing and says why in `doorError`.
 */
async function queue({ cards, holds }) {
  const items = [];
  for (const c of cards() || []) {
    items.push({ plane: 'agent', id: c.id, tool: c.name, sessionId: c.sessionId, summary: c.summary, args: c.args || {}, at: Number(c.at) || 0, ...(c.kind ? { kind: c.kind } : {}) });
  }
  let doorError = '';
  try {
    const r = await holds();
    if (r.isError) throw new Error(r.text);
    const parsed = JSON.parse(r.text);
    for (const h of parsed.held || []) {
      items.push({ plane: 'door', id: h.id, tool: h.tool, project: h.project, caller: h.caller, when: h.when, args: h.args || {}, at: Date.parse(h.when) || 0 });
    }
  } catch (e) {
    doorError = `The door's cards could not be read: ${e.message}`;
  }
  items.sort((a, b) => b.at - a.at);
  return doorError ? { items, doorError } : { items };
}

/**
 * Steward's tool policy, read from `dir` (his folder, steward.cjs findSteward). { state: 'absent' } when there is no
 * folder or no file, { state: 'malformed', error } when it is not the shape he writes, else { state: 'ok', ts, tools }.
 */
function readPolicy(dir) {
  if (!dir) return { state: 'absent', file: null };
  const file = path.join(dir, ...POLICY_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'absent', file };
    return { state: 'malformed', file, error: e.message };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { state: 'malformed', file, error: `not JSON: ${e.message}` };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tools)) return { state: 'malformed', file, error: 'it has no "tools" list' };
  const tools = [];
  for (const [i, t] of doc.tools.entries()) {
    if (!t || typeof t.name !== 'string' || !t.name) return { state: 'malformed', file, error: `tool ${i + 1} has no name` };
    if (!APPROVALS.includes(t.approval)) return { state: 'malformed', file, error: `${t.name}: approval is "${t.approval}", not always, never or rule` };
    tools.push({ name: t.name, source: typeof t.source === 'string' ? t.source : '', approval: t.approval, ...(typeof t.notes === 'string' && t.notes ? { notes: t.notes } : {}) });
  }
  return { state: 'ok', file, ts: doc.ts == null ? null : String(doc.ts), tools };
}

module.exports = { queue, readPolicy, POLICY_FILE, APPROVALS };
