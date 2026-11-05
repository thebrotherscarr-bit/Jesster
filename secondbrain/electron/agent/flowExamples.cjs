/**
 * The Flows shelf's built-in examples (the operator, 2026-11-05: "I don't have a way to create my own flows or any of
 * the evals built up with examples yet"): one eval flow per eval set in Steward's harness/steward/evals/*.yaml, and two
 * plain recipes. Each is an ordinary schedule tagged "example", with no "when" (it runs only on Run now; Set up
 * schedules it), so he can run, duplicate, change or delete it like his own.
 *
 * Seeded once: each example has a key, and the keys already seeded are kept in <vault>/.secondbrain/flow-examples.json.
 * An example is added only if its key was never seeded and no schedule has its name; a deleted example does not come
 * back, and nothing of his is ever overwritten. An eval set that appears later is seeded when it first appears.
 */
const fs = require('fs');
const path = require('path');

// sets that take hours (the aider polyglot exercises, each a whole workflow run): badged "night", and Run now by day
// asks first
const NIGHT_SETS = ['aider-py'];

const EVAL_SUMMARIZE =
  "Say in a few lines whether the eval set met its bar: the result line, the cases that failed and why, and anything that looks like the harness rather than the model.";

/** The eval example for one set ({ name, tier } from estate.evalSets). */
function evalExample(set) {
  return {
    key: `eval:${set.name}`,
    name: `Eval: ${set.name}`,
    backend: 'steward',
    prompt: '',
    steps: [{ step: 'eval_start', sets: [set.name], runs: 1 }, 'eval_wait', 'eval_bars'],
    summarize: EVAL_SUMMARIZE,
    deliver: ['note'],
    tags: ['example', 'eval', ...(set.tier ? [set.tier] : [])],
    ...(NIGHT_SETS.includes(set.name) ? { night: true } : {}),
  };
}

const RECIPES = [
  {
    key: 'recipe:repo-drift',
    name: 'Repo drift check',
    backend: 'steward',
    prompt: '',
    steps: ['versions', 'repo_log'],
    summarize: 'Say which repositories are behind or ahead of origin/main or have uncommitted changes, and what landed on main since the last run. Keep it short.',
    deliver: ['note'],
    tags: ['example'],
  },
  {
    key: 'recipe:shipped-week',
    name: 'What shipped this week',
    backend: 'steward',
    prompt: '',
    steps: ['merged_prs', 'releases'],
    summarize: 'Write what shipped: the merged pull requests grouped by repository, and the releases, each in one plain line.',
    deliver: ['note'],
    tags: ['example'],
  },
];

/** Every example for these eval sets: an eval flow per set, then the recipes. */
function examples(sets) {
  return [...(sets || []).map(evalExample), ...RECIPES];
}

function seededFile(vaultDir) {
  return path.join(vaultDir, '.secondbrain', 'flow-examples.json');
}

function readSeeded(vaultDir) {
  try {
    const j = JSON.parse(fs.readFileSync(seededFile(vaultDir), 'utf8'));
    return Array.isArray(j.seeded) ? j.seeded.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Add the examples not seeded before and not named like one of his: { added: [names] }. `schedules` is a Schedules
 * (schedules.cjs), `vaultDir` the vault's folder, `sets` the eval sets ([] when Steward's folder is not found: the
 * eval examples then wait until it is).
 */
function seedExamples({ schedules, vaultDir, sets }) {
  const before = readSeeded(vaultDir);
  const seeded = new Set(before);
  const names = new Set(schedules.all().map((s) => String(s.name).toLowerCase()));
  const added = [];
  for (const ex of examples(sets)) {
    if (seeded.has(ex.key)) continue;
    seeded.add(ex.key);
    if (names.has(ex.name.toLowerCase())) continue; // his own by that name: left as it is
    const { key, ...spec } = ex;
    schedules.add({ ...spec, when: '' });
    names.add(ex.name.toLowerCase());
    added.push(ex.name);
  }
  if (seeded.size === before.length) return { added };
  fs.mkdirSync(path.dirname(seededFile(vaultDir)), { recursive: true });
  fs.writeFileSync(seededFile(vaultDir), JSON.stringify({ seeded: [...seeded].sort() }, null, 2));
  return { added };
}

module.exports = { NIGHT_SETS, RECIPES, evalExample, examples, seedExamples, seededFile, readSeeded };
