import test from 'node:test';
import assert from 'node:assert/strict';
import { Note } from '../types/index.ts';
import { fromKernel, isKernelId, kernelTimeToMs, planSync, signature } from './kernel.ts';

const note = (id: string, title = 'T', content = 'c'): Note => ({
  id, title, content, category: 'inbox', tags: [], isPinned: false, createdAt: 1, updatedAt: 1,
});

test('kernel %z timestamps parse', () => {
  assert.equal(kernelTimeToMs('2026-10-21T21:00:54+0000'), Date.UTC(2026, 9, 21, 21, 0, 54));
  assert.equal(kernelTimeToMs('2026-10-21T14:00:54-0700'), Date.UTC(2026, 9, 21, 21, 0, 54));
});

test('kernel notes map onto secondbrain notes', () => {
  const n = fromKernel({
    id: 'a', title: 'A', body: 'b', tags: ['x'], category: 'odd-shelf', pinned: true,
    created: '2026-01-01T00:00:00+0000', updated: '2026-01-02T00:00:00+0000', hash: 'h',
  });
  assert.equal(n.content, 'b');
  assert.equal(n.category, 'inbox');
  assert.equal(n.isPinned, true);
});

test('planSync creates, updates and removes only what changed', () => {
  const a = note('a'), b = note('b'), c = note('c');
  const synced = new Map([
    ['a', { sig: signature(a), hash: 'ha' }],
    ['b', { sig: signature(b), hash: 'hb' }],
    ['gone', { sig: '', hash: 'hg' }],
  ]);
  const ops = planSync(synced, [a, { ...b, content: 'changed' }, c]);
  assert.deepEqual(ops.map((o) => o.kind + ':' + (o.kind === 'remove' ? o.id : o.note.id)),
    ['update:b', 'create:c', 'remove:gone']);
  const upd = ops[0];
  assert.equal(upd.kind === 'update' && upd.base, 'hb');
});

test('secondbrain ids are valid kernel ids', () => {
  assert.ok(isKernelId('note-3f2c1a9e-1b2c-4d5e-8f90-123456789abc'));
  assert.ok(!isKernelId('Note With Spaces'));
});
