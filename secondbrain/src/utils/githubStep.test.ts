import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, type RepoState, type PullRequest } from './githubStep.ts';

const base: RepoState = { world: 'w', is_repo: true, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changed: 0, untracked: 0, remote_allowed: true };
const pr = (checks: PullRequest['checks']): PullRequest => ({ number: 7, title: 'T', line: 'work', into: 'main', url: 'u', checks });

test('unsaved work comes first, wherever the checkout stands', () => {
  assert.equal(nextStep({ ...base, changed: 2, untracked: 1 }).label, 'Save 3 changes');
  assert.equal(nextStep({ ...base, branch: 'work', changed: 1, remote_allowed: false }).act, 'save', 'a save is local: the wall does not stop it');
});

test('on main: bring level when GitHub is ahead; saves only here go onto a line; level otherwise', () => {
  assert.deepEqual([nextStep({ ...base, behind: 2 }).act, nextStep({ ...base, behind: 2 }).label], ['pull', 'Bring level (2 saves on GitHub)']);
  assert.equal(nextStep({ ...base, ahead: 1 }).act, 'line');
  assert.equal(nextStep(base).label, 'Level with GitHub');
  assert.equal(nextStep({ ...base, behind: 1, remote_allowed: false }).act, 'none', 'nothing reaches GitHub through a shut wall');
});

test('on a line: send, bring level, open a PR, merge when green, and say why when not', () => {
  const line = { ...base, branch: 'work', upstream: 'origin/work' };
  assert.equal(nextStep({ ...line, upstream: undefined }).label, 'Send this line');
  assert.equal(nextStep({ ...line, ahead: 1 }).label, 'Send 1 save');
  assert.equal(nextStep({ ...line, behind: 1 }).act, 'pull');
  assert.equal(nextStep(line).act, 'pr');
  assert.equal(nextStep(line, [pr('passed')]).label, 'Merge #7');
  assert.equal(nextStep(line, [pr('pending')]).act, 'none');
  assert.match(nextStep(line, [pr('failed')]).label, /checks failed/);
  assert.equal(nextStep(line, [{ ...pr('passed'), line: 'other' }]).act, 'pr', "another line's pull request is not this one's");
});

test('nothing read, or not a repository, is said', () => {
  assert.equal(nextStep(null).act, 'none');
  assert.equal(nextStep({ world: 'w', is_repo: false }).label, 'Not a repository');
});
