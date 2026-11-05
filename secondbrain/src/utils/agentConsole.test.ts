import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CHATS_OPEN_KEY, CONSOLE_OPEN_KEY, CONSOLE_SHELVES, MOVED_TO_CONSOLE, TOP_BAR, barStatus, historyRow, keepPanel, mcpServers, panelOpen, versusBaseline } from './agentConsole.ts';

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
  for (const section of ['AtlasSection', 'TerminalSection', 'BrowserSection', 'ComputerSection', 'CheckSection', 'McpSection', 'AutomationsSection'])
    assert.match(panel, new RegExp(`<${section} />`), `${section} moved from Settings to the console`);
  const settings = read('../components/SettingsModal.tsx');
  for (const section of ['TelegramSection', 'AtlasSection', 'TerminalSection', 'McpSection']) assert.ok(!settings.includes(section), `${section} is not also in Settings`);
  // Telegram's setup is the Phone view's (2026-11-04)
  assert.match(read('../components/PhoneView.tsx'), /<TelegramSection \/>/);
});

test('the removed pages and windows are gone', () => {
  for (const f of ['FlowsView', 'GitHubView', 'GitHubPanels', 'AskBrainView', 'QuickCaptureModal', 'ServicesModal', 'StewardButton', 'OllamaSetupModal', 'IntegrationsModal'])
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

// The operator, 2026-11-04: "this entire left bar of old chats, that can be folded just like the console". Both
// panels fold from the header's one line, each remembered under its own key, open the first time.
test('the chats bar and the console fold from the header, each remembered', () => {
  const kept = new Map<string, string>();
  const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  assert.notEqual(CHATS_OPEN_KEY, CONSOLE_OPEN_KEY);
  for (const key of [CHATS_OPEN_KEY, CONSOLE_OPEN_KEY]) {
    assert.equal(panelOpen(store, key), true, 'open the first time');
    keepPanel(store, key, false);
    assert.equal(panelOpen(store, key), false, 'closed stays closed');
    keepPanel(store, key, true);
    assert.equal(panelOpen(store, key), true);
  }
  keepPanel(store, CHATS_OPEN_KEY, false);
  assert.equal(panelOpen(store, CONSOLE_OPEN_KEY), true, 'one panel does not fold the other');
  const broken = { getItem: () => { throw new Error('no storage'); }, setItem: () => { throw new Error('no storage'); } };
  assert.equal(panelOpen(broken, CHATS_OPEN_KEY), true);
  assert.doesNotThrow(() => keepPanel(broken, CHATS_OPEN_KEY, false));
  assert.equal(panelOpen(undefined, CHATS_OPEN_KEY), true);

  const view = read('../components/AgentView.tsx');
  for (const [state, show, key, label] of [['chatsOpen', 'showChats', 'CHATS_OPEN_KEY', 'Chats'], ['consoleOpen', 'showConsole', 'CONSOLE_OPEN_KEY', 'Console']]) {
    assert.ok(view.includes(`useState(() => panelOpen(store(), ${key}))`), `${label}: read from its key`);
    assert.ok(view.includes(`keepPanel(store(), ${key}, on)`), `${label}: kept under its key`);
    assert.match(view, new RegExp(String.raw`onClick=\{\(\) => ${show}\(!${state}\)\}\s*aria-pressed=\{${state}\}`), `${label}: its header toggle`);
    assert.match(view, new RegExp(String.raw`/> ${label}\s*</button>`), `${label}: the toggle is named`);
  }
  assert.match(view, /\{consoleOpen && <AgentConsole /, 'folded, the console is gone');
  assert.ok(view.indexOf('/> Chats') < view.indexOf('/> Console'), 'Chats on the left, Console on the right');
  assert.match(view, /\{chatsOpen && \(\s*<aside aria-label="Chats"/, 'folded, the bar is gone and the conversation takes the width');
  // a clean bar: one New chat, titles truncated with the whole title as the tooltip, nothing else
  const bar = view.slice(view.indexOf('<aside aria-label="Chats"'), view.indexOf('</aside>'));
  assert.equal((bar.match(/<button\b/g) || []).length, 2, 'New chat and the row button only');
  assert.match(bar, /New chat/);
  assert.match(bar, /truncate[^"]*`\}\s*title=\{s\.title/);
});

test("the bar is the small set whole on its two newest runs and the newest steps run passing; the Evals shelf shows it and a run's progress", () => {
  const r = (set: string, passed: number, total: number, ts: string) => ({ set, passed, total, ts });
  // newest first, as the shelf reads the history
  const met = [r('steps', 3, 3, '6'), r('small', 3, 3, '5'), r('small', 3, 3, '4'), r('small', 1, 3, '3')];
  assert.equal(barStatus(met).met, true);
  assert.deepEqual(barStatus(met).small.map((s) => s.ts), ['5', '4']);
  assert.equal(barStatus([r('steps', 3, 3, '6'), r('small', 3, 3, '5'), r('small', 2, 3, '4')]).met, false, 'one small short is not the bar');
  assert.equal(barStatus([r('steps', 1, 3, '6'), r('small', 3, 3, '5'), r('small', 3, 3, '4')]).met, false, 'the steps run must pass');
  assert.equal(barStatus([r('small', 3, 3, '5'), r('small', 3, 3, '4')]).met, false, 'no steps run yet');
  assert.equal(barStatus([r('steps', 3, 3, '6'), r('small', 3, 3, '5')]).met, false, 'one small run is not two in a row');
  assert.equal(barStatus([r('steps', 0, 0, '6'), r('small', 0, 0, '5'), r('small', 0, 0, '4')]).met, false, 'nothing scored is no pass');
  assert.deepEqual(barStatus([]), { small: [], steps: null, met: false });

  const pane = read('../components/AgentConsole.tsx');
  assert.match(pane, /<BarLine history=\{value\.history\} \/>/, 'the Evals shelf shows the bar');
  assert.match(pane, /data-eval-bar/);
  assert.match(pane, /r\.progress\.map\(/, "each run shows its progress lines");
});
