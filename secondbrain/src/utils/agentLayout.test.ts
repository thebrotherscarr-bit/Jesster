import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Kyle, 2026-11-04: a long line in the Agent tab pushed Stop and Send off the side of the window. The tab's
// messages wrap (index.css .agent-md: there is no typography plugin, so a <pre> never wrapped) and every flex
// container down to the input row may shrink below its content (min-w-0); the input row's buttons never shrink.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the Agent tab wraps long lines and code instead of widening the window', () => {
  const css = read('../index.css');
  assert.match(css, /\.agent-md\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.agent-md pre\s*\{[^}]*white-space:\s*pre-wrap/);
  const view = read('../components/AgentView.tsx');
  assert.equal((view.match(/className="agent-md /g) || []).length, 2, "his replies and Claude's check use .agent-md");
  assert.match(view, /<div className="flex flex-1 min-w-0 min-h-0">/, 'the tab may shrink below its content');
  assert.match(view, /flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden/, 'the message pane may shrink');
  assert.match(view, /flex-1 min-w-0 resize-none/, 'the message box may shrink');
  for (const label of ['Stop', 'Send']) assert.match(view, new RegExp(`aria-label="${label}" className="shrink-0 `));
  assert.match(read('../App.tsx'), /activeTab === 'agent' \? 'flex flex-1 min-w-0 min-h-0'/);
});
