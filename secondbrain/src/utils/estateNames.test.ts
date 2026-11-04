import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Kyle, 2026-11-04: "the apps are declared as such. ie: Agent is Agent: Steward in secondbrain. Secondbrain app named
// Jesster. Atlas in secondbrain becomes Open Aurora." Display names only: the app's internal name, its userData folder
// (where the notes live) and the updater's asset stay SecondBrain.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the estate names show where he looks; the identifiers stay', () => {
  assert.match(read('../../index.html'), /<title>Jesster/);
  assert.match(read('../components/Header.tsx'), /Agent: Steward/);
  assert.match(read('../components/AtlasButton.tsx'), /Open Aurora/);
  const pkg = JSON.parse(read('../../package.json'));
  assert.equal(pkg.name.toLowerCase().includes('secondbrain'), true, 'the package name stays (userData, updates)');
  assert.match(read('../../electron/updater.cjs'), /SecondBrain-win32-x64\.zip/, "the updater's asset stays");
});
