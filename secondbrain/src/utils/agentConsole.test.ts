import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CONSOLE_SHELVES, MOVED_TO_CONSOLE, TOP_BAR, historyRow, mcpServers, versusBaseline } from './agentConsole.ts';

// The operator, 2026-11-04: "there is a lot of clutter in the top bar", and the rulings after it (Flows, Capture,
// Import files, GitHub, Ask Brain, Services, Integrations and + New note leave the top bar; Steward's controls go to
// the Agent tab's console). The top bar's buttons are exactly TOP_BAR, and every control that moved is in the console.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const marks = (text: string, attr: string) => [...text.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((m) => m[1]);

test('the top bar carries the app-wide buttons and nothing else', () => {
  const header = read('../components/Header.tsx');
  const atlas = read('../components/AtlasButton.tsx');
  assert.deepEqual([...marks(header, 'data-topbar'), ...marks(atlas, 'data-topbar')].sort(), [...TOP_BAR].sort());
  // every button in the bar is one of them: a new, unmarked button turns this red
  assert.equal((header.match(/<button\b/g) || []).length, marks(header, 'data-topbar').length);
  for (const gone of ['StewardButton', 'ServicesButton', 'onOpenIntegrations', 'onOpenQuickCapture', 'onCreateNewNote', 'importFiles', "'flows'", "'github'", "'ask'", 'InboxSyncButton'])
    assert.ok(!header.includes(gone), `${gone} is no longer in the top bar`);
});

test('every control that left the top bar stands in the console', () => {
  const view = read('../components/AgentView.tsx');
  assert.match(view, /<AgentConsole /, 'the Agent tab renders the console');
  for (const m of MOVED_TO_CONSOLE) {
    assert.ok(CONSOLE_SHELVES.some((s) => s.id === m.shelf), `${m.control}: its shelf exists`);
    assert.ok(marks(read(`../components/${m.file}`), 'data-console').includes(m.control), `${m.control} is in ${m.file}`);
  }
  const panel = read('../components/AgentConsole.tsx');
  for (const shelf of ['ServersShelf', 'ApprovalsShelf']) assert.match(panel, new RegExp(`<${shelf} />`), `${shelf} is on the console, once`);
  for (const section of ['TelegramSection', 'AtlasSection', 'TerminalSection', 'BrowserSection', 'ComputerSection', 'CheckSection', 'McpSection', 'AutomationsSection'])
    assert.match(panel, new RegExp(`<${section} />`), `${section} moved from Settings to the console`);
  const settings = read('../components/SettingsModal.tsx');
  for (const section of ['TelegramSection', 'AtlasSection', 'TerminalSection', 'McpSection']) assert.ok(!settings.includes(section), `${section} is not also in Settings`);
});

test('the removed pages and windows are gone', () => {
  for (const f of ['FlowsView', 'GitHubView', 'GitHubPanels', 'AskBrainView', 'QuickCaptureModal', 'ServicesModal', 'StewardButton'])
    assert.equal(existsSync(new URL(`../components/${f}.tsx`, import.meta.url)), false, `${f}.tsx`);
  const app = read('../App.tsx');
  for (const gone of ['FlowsView', 'AskBrainView', 'QuickCaptureModal', 'ServicesModal', 'StewardModal', 'handleCreateNewNote']) assert.ok(!app.includes(gone), gone);
  assert.ok(!read('../components/NotesList.tsx').includes('onCreateNote'), 'Steward writes new notes');
});

test("Steward's MCP servers are read from his tool policy's sources", () => {
  const policy = {
    state: 'ok' as const,
    file: 'f',
    ts: null,
    tools: [
      { name: 'git', source: 'mcp:door', approval: 'never' as const },
      { name: 'git_pr', source: 'mcp:door', approval: 'always' as const },
      { name: 'read_note', source: 'mcp:secondbrain', approval: 'never' as const },
      { name: 'run_shell', source: 'shell', approval: 'always' as const },
    ],
  };
  assert.deepEqual(mcpServers(policy), [
    { name: 'door', tools: 2 },
    { name: 'secondbrain', tools: 1 },
  ]);
  assert.deepEqual(mcpServers(null), []);
  assert.deepEqual(mcpServers({ state: 'absent', file: null }), []);
});

test('an eval run reads against its set baseline', () => {
  const base = { small: { checks: 10, of: 14 } };
  assert.equal(versusBaseline({ set: 'small', checksPassed: 8, checksTotal: 14 }, base), 'below');
  assert.equal(versusBaseline({ set: 'small', checksPassed: 10, checksTotal: 14 }, base), 'at');
  assert.equal(versusBaseline({ set: 'small', checksPassed: 12, checksTotal: 14 }, base), 'above');
  assert.equal(versusBaseline({ set: 'small', checksPassed: 12, checksTotal: 20 }, base), '', 'another number of checks is not compared');
  assert.equal(versusBaseline({ set: 'large', checksPassed: 1, checksTotal: 1 }, base), '');
});

test('an answered card reads the same from either plane', () => {
  assert.deepEqual(historyRow({ id: 'a', name: 'run_shell', allow: true, always: false, summary: 'ls', answeredAt: 5 }, 0), { key: 'a', tool: 'run_shell', decision: 'allowed', at: 5, detail: 'ls' });
  assert.equal(historyRow({ id: 'b', tool: 'git_push', decision: 'deny', when: '2026-11-04T00:00:00Z', args: { x: 1 } }, 1).decision, 'deny');
  // The shape approvals.cjs's history() stores: { id, tool, summary, answer, where, time }.
  const stored = historyRow({ id: 'c', tool: 'service_control', summary: 'restart steward', answer: 'allow', where: 'telegram', time: '2026-11-04T19:00:00.000Z' }, 2);
  assert.equal(stored.decision, 'allow (telegram)');
  assert.equal(stored.at, Date.parse('2026-11-04T19:00:00.000Z'));
  assert.equal(historyRow({ allow: false }, 2).decision, 'denied');
  assert.equal(historyRow(null, 3).key, '3');
});
