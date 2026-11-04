import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_SCOPE, approvalWord, canAlways, whereWord } from './approvals.ts';

test('Always is offered on an Agent-tab tool card only: never a review, never a door hold', () => {
  assert.equal(canAlways({ plane: 'agent' }), true);
  assert.equal(canAlways({ plane: 'agent', kind: 'review' }), false);
  assert.equal(canAlways({ plane: 'door' }), false);
  assert.match(ALWAYS_SCOPE, /until SecondBrain restarts/);
});

test("a policy row's approval, in words", () => {
  assert.equal(approvalWord('always'), 'always asks');
  assert.equal(approvalWord('never'), 'never asks');
  assert.equal(approvalWord('rule'), 'asks by a rule');
});

test('where a card came from', () => {
  const card = { plane: 'agent' as const, id: 'a', tool: 't', sessionId: 's1', summary: '', args: {}, at: 0 };
  assert.equal(whereWord(card), 'Agent tab · s1');
  assert.equal(whereWord(card, { s1: 'Agent: fix the test' }), 'Agent tab · fix the test');
  const hold = { plane: 'door' as const, id: 'h', tool: 'git_push', project: 'research', caller: 'steward', when: '', args: {}, at: 0 };
  assert.equal(whereWord(hold), 'the door · research · asked by steward');
});
