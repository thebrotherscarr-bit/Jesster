import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOllamaBrainPrompt,
  generateSimulatedResponse,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
} from './ollama.ts';

test('DEFAULT constants are set correctly', () => {
  assert.equal(DEFAULT_OLLAMA_HOST, 'http://localhost:11434');
  assert.equal(DEFAULT_OLLAMA_MODEL, 'gpt-oss:20b');
});

test('buildOllamaBrainPrompt formats prompts for all 5 modes', () => {
  const askPrompt = buildOllamaBrainPrompt('ask', 'Sample Note Content', 'What is the goal?');
  assert.ok(askPrompt.prompt.includes('User Question: "What is the goal?"'));
  assert.ok(askPrompt.prompt.includes('Sample Note Content'));
  assert.ok(askPrompt.system.includes('Second Brain'));

  const summarizePrompt = buildOllamaBrainPrompt('summarize', 'Sample Note Content');
  assert.ok(summarizePrompt.prompt.includes('Executive Summary'));

  const actionsPrompt = buildOllamaBrainPrompt('action_items', 'Sample Note Content');
  assert.ok(actionsPrompt.prompt.includes('Extract every action item'));

  const connectPrompt = buildOllamaBrainPrompt('connect', 'Sample Note Content');
  assert.ok(connectPrompt.prompt.includes('Core Conceptual Pillars'));

  const expandPrompt = buildOllamaBrainPrompt('expand', 'Sample Note Content');
  assert.ok(expandPrompt.prompt.includes('Act as a thought partner'));
});

test('generateSimulatedResponse generates valid non-empty responses for all modes', () => {
  const askResp = generateSimulatedResponse('ask', 'Notes content', 'How to test?');
  assert.ok(askResp.includes('Second Brain Synthesis'));

  const sumResp = generateSimulatedResponse('summarize', 'Notes content');
  assert.ok(sumResp.includes('Executive Distillation'));

  const actResp = generateSimulatedResponse('action_items', 'Notes content');
  assert.ok(actResp.includes('- [ ]'));

  const connResp = generateSimulatedResponse('connect', 'Notes content');
  assert.ok(connResp.includes('#secondbrain'));

  const expResp = generateSimulatedResponse('expand', 'Notes content');
  assert.ok(expResp.includes('Thought Partner Expansion'));
});
