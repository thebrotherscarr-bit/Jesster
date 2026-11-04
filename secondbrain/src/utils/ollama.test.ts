import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
} from './ollama.ts';

test('DEFAULT constants are set correctly', () => {
  assert.equal(DEFAULT_OLLAMA_HOST, 'http://localhost:11434');
  assert.equal(DEFAULT_OLLAMA_MODEL, 'gpt-oss:20b');
});

