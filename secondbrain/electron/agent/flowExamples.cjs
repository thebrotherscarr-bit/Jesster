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

// No set is badged "night" and no Run now asks first by day (ADR-0009, 2026-11-05: "run it whenever i say. day or
// night or whenever, its my system. same as any eval.").

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

// ---- one-time fixes to saved flows ----------------------------------------------------------------------------------

/**
 * 2026-11-08: the eval examples seeded while AG-UI was the default carry `transport: 'ag-ui'` in their eval_start step,
 * and SecondBrain's eval_start refuses a host transport for any set that is not an asks set (2026-11-06: "Eval: bfcl",
 * "Eval: steps" and "Eval: direct" failed at once). Once per vault, the `transport` is taken off every eval_start step
 * whose sets are not all asks sets; nothing else on any flow changes, and a transport put back after it is his.
 */
const STALE_TRANSPORT = 'eval-transport-2026-11-08';

function migrationsFile(vaultDir) {
  return path.join(vaultDir, '.secondbrain', 'flow-migrations.json');
}

function readMigrations(vaultDir) {
  try {
    const j = JSON.parse(fs.readFileSync(migrationsFile(vaultDir), 'utf8'));
    return Array.isArray(j.done) ? j.done.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Drop the stale transports ({ changed: [flow names] }). `sets` are estate.evalSets ({ name, runner }); with none (Steward's
 * folder not found) the runners are unknown, so nothing is touched and it is tried again on the next read.
 */
function dropStaleTransports({ schedules, vaultDir, sets }) {
  if (!Array.isArray(sets) || !sets.length) return { changed: [] };
  const done = readMigrations(vaultDir);
  if (done.includes(STALE_TRANSPORT)) return { changed: [] };
  const asks = new Set(sets.filter((s) => s.runner === 'asks').map((s) => s.name));
  const changed = [];
  for (const s of schedules.all()) {
    if (!Array.isArray(s.steps)) continue;
    let touched = false;
    const steps = s.steps.map((x) => {
      if (!x || typeof x !== 'object' || x.step !== 'eval_start' || x.transport === undefined || x.transport === 'in-process') return x;
      if (Array.isArray(x.sets) && x.sets.length && x.sets.every((n) => asks.has(String(n)))) return x;
      touched = true;
      const { transport, ...rest } = x; // eslint-disable-line no-unused-vars
      return rest;
    });
    if (touched) {
      schedules.update(s.id, { steps });
      changed.push(s.name);
    }
  }
  fs.mkdirSync(path.dirname(migrationsFile(vaultDir)), { recursive: true });
  fs.writeFileSync(migrationsFile(vaultDir), JSON.stringify({ done: [...done, STALE_TRANSPORT].sort() }, null, 2));
  return { changed };
}

module.exports = { RECIPES, evalExample, examples, seedExamples, seededFile, readSeeded, dropStaleTransports, migrationsFile, STALE_TRANSPORT };
