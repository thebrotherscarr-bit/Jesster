import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTab } from './tabs.ts';

test('SecondBrain opens on the Agent in the desktop app, and on Notes without one', () => {
  assert.equal(defaultTab(true), 'agent');
  assert.equal(defaultTab(false), 'notes');
});
