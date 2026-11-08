/**
 * The Flows shelf end to end (Playwright's Electron support): the built app, launched with a settings folder and a
 * notes vault of its own in a temp folder (never the operator's), and Steward's MCP host replaced by a local fake
 * (fake-steward.mjs). No network, no model, no Steward, no door: the vault is not inside a ground, so no door or glass
 * starts, and Telegram is off.
 *
 * What would go red: Run now not reaching schedules:run and Steward's run_recipe for every kind of flow (the fake sees
 * no run_recipe with the flow's id and trigger "now", and the shelf never shows it running); a finished run not filed
 * on the flow, or a failure filed without its reason (2026-11-08: "NONE of the flows started", and a failed run that
 * did not say why); + New flow not saving a wired line of blocks; Set up not making an automation of a saved flow.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, _electron as electron } from '@playwright/test';
import { fakeSteward, EVAL_FAILURE } from './fake-steward.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FLOWS = {
  recipe: { id: 'e2erecipe', name: 'E2E recipe flow', steps: ['repo_log', 'versions'] },
  eval: { id: 'e2eeval', name: 'E2E eval flow', steps: [{ step: 'eval_start', sets: ['small'], runs: 1 }, { step: 'eval_wait', hours: 1 }] },
  legacy: { id: 'e2elegacy', name: 'E2E legacy prompt', prompt: 'Say hello.' },
};

function schedule({ id, name, steps, prompt = '' }) {
  return {
    id,
    name,
    prompt,
    when: { type: 'manual' },
    whenText: '',
    deliver: ['note'],
    backend: 'local',
    ...(steps ? { steps } : {}),
    enabled: true,
    created: Date.now() - 60000,
    lastRun: null,
    lastResult: null,
    next: null,
  };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

test.describe.configure({ mode: 'serial' });

let root;
let vault;
let fake;
let app;
let page;

const schedulesFile = () => path.join(vault, '.secondbrain', 'schedules.json');
const saved = () => JSON.parse(fs.readFileSync(schedulesFile(), 'utf8'));

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'secondbrain-e2e-'));
  vault = path.join(root, 'vault');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(path.join(vault, '.secondbrain'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(schedulesFile(), JSON.stringify(Object.values(FLOWS).map(schedule), null, 2));
  fake = fakeSteward();
  const fakePort = await fake.listen();
  const host = `http://127.0.0.1:${fakePort}`;
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      vaultDir: vault,
      agent: { backend: 'ollama', host, model: 'e2e', transport: 'responses' },
      telegram: { token: '', enabled: false, off: true },
      services: { ollama: { enabled: false } },
    }),
  );
  const env = { ...process.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_ENV', 'SECONDBRAIN_RUNS_OLLAMA', 'SECONDBRAIN_TELEGRAM_API']) delete env[k];
  app = await electron.launch({
    args: [APP_DIR],
    cwd: APP_DIR,
    env: {
      ...env,
      SECONDBRAIN_USER_DATA: userData,
      SECONDBRAIN_PORT: String(await freePort()),
      SECONDBRAIN_STEWARD_MCP_URL: `${host}/mcp`,
      SECONDBRAIN_SCHEDULER_MS: '1000',
    },
    timeout: 30000,
  });
  page = await app.firstWindow();
  await page.locator('[data-topbar="Flows"]').click();
  await expect(page.locator(`[data-flow="${FLOWS.recipe.id}"]`)).toBeVisible();
});

test.afterAll(async () => {
  if (app) await app.close().catch(() => {});
  if (fake) await fake.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** Open a flow on the shelf, press Run now, and see it running: the list's line and the canvas's blocks. */
async function runNow(flow) {
  const item = page.locator(`[data-flow="${flow.id}"]`);
  await item.click();
  const run = page.locator(`[data-run="${flow.id}"]`);
  await expect(run).toBeEnabled();
  await run.click();
  await expect(item).toContainText(/running now|waiting on/);
  await expect(page.locator('[aria-label="Flow canvas"] [data-block][data-state="running"]').first()).toBeVisible();
  return item;
}

const reachedSteward = (flow) =>
  fake.calls.filter((c) => c.kind === 'mcp' && c.name === 'run_recipe' && c.arguments && c.arguments.flow === flow.id && c.arguments.trigger === 'now');

test('Run now on a recipe flow reaches Steward, runs, and is filed ok', async () => {
  const item = await runNow(FLOWS.recipe);
  expect(reachedSteward(FLOWS.recipe)).toHaveLength(1);
  expect(reachedSteward(FLOWS.recipe)[0].arguments.recipe.steps).toEqual(FLOWS.recipe.steps);
  await expect(item).toContainText(/ok ·/, { timeout: 20000 });
  await expect(page.locator('[data-last-run]')).toContainText('last run: ok');
  await expect(page.locator('[aria-label="Flow canvas"] [data-block][data-state="done"]').first()).toBeVisible();
  expect(saved().find((s) => s.id === FLOWS.recipe.id)).toMatchObject({ lastResult: 'ok', running: false, pending: null });
});

test('Run now on an eval flow reaches Steward, and its failure is shown with the reason', async () => {
  const item = await runNow(FLOWS.eval);
  expect(reachedSteward(FLOWS.eval)).toHaveLength(1);
  const step = reachedSteward(FLOWS.eval)[0].arguments.recipe.steps[0];
  expect(step).toMatchObject({ step: 'eval_start', sets: ['small'] });
  expect(step).not.toHaveProperty('transport');
  await expect(item).toContainText(`failed: ${EVAL_FAILURE}`, { timeout: 20000 });
  await expect(page.locator(`[data-failed="${FLOWS.eval.id}"]`)).toHaveText(`Last run failed: ${EVAL_FAILURE}`);
  await expect(page.locator('[aria-label="Flow canvas"] [data-block][data-state="failed"]').first()).toBeVisible();
});

test('Run now on a legacy prompt flow runs its turn on the local loop and is filed ok', async () => {
  const before = fake.calls.filter((c) => c.kind === 'chat').length;
  const item = await runNow(FLOWS.legacy);
  await expect(item).toContainText(/ok ·/, { timeout: 20000 });
  expect(fake.calls.filter((c) => c.kind === 'chat').length).toBeGreaterThan(before);
  // a prompt flow never goes to Steward's recipe host
  expect(reachedSteward(FLOWS.legacy)).toHaveLength(0);
  expect(saved().find((s) => s.id === FLOWS.legacy.id)).toMatchObject({ lastResult: 'ok', running: false });
});

/** Drag a wire from one block's out dot (bottom) to the next one's in dot (top), on the editor's canvas. */
async function wire(fromBlock, toBlock) {
  const node = (b) => page.locator('.react-flow__node', { has: page.locator(`[data-edit-block="${b}"]`) });
  const from = await node(fromBlock).locator('.react-flow__handle-bottom').boundingBox();
  const to = await node(toBlock).locator('.react-flow__handle-top').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
}

const NEW_FLOW = 'E2E three blocks';

test('+ New flow builds a 3-block flow, wired in a line, and saves it', async () => {
  await page.locator('[data-new-flow]').click();
  await page.getByLabel('Flow name').fill(NEW_FLOW);
  for (const b of ['repo_log', 'versions', 'note']) await page.locator(`[data-palette="${b}"]`).click();
  await expect(page.locator('[data-edit-block]')).toHaveCount(3);
  await wire('repo_log', 'versions');
  await wire('versions', 'note');
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await page.locator('[data-save-flow]').click();
  const item = page.locator('[data-flow]', { hasText: NEW_FLOW });
  await expect(item).toBeVisible();
  const s = saved().find((x) => x.name === NEW_FLOW);
  expect(s).toMatchObject({ steps: ['repo_log', 'versions'], deliver: ['note'], when: { type: 'manual' }, enabled: true });
});

test('Set up makes an automation of the saved flow', async () => {
  await page.locator('[data-flow]', { hasText: NEW_FLOW }).click();
  await page.getByRole('button', { name: 'Set up' }).click();
  const setup = page.locator('[aria-label="Set up"]');
  await setup.locator('[data-new-automation]').click();
  const form = setup.locator('form[aria-label="New automation"]');
  await form.getByLabel('Flow', { exact: true }).selectOption({ label: NEW_FLOW });
  await form.getByRole('button', { name: 'Add automation' }).click();
  await expect(setup.locator('[data-automation]', { hasText: NEW_FLOW })).toBeVisible();
  const s = saved().find((x) => x.name === NEW_FLOW);
  expect(s).toMatchObject({ whenText: 'weekdays 08:30', when: { type: 'weekdays', time: '08:30' }, enabled: true });
  expect(s.next).toBeGreaterThan(Date.now());
});
