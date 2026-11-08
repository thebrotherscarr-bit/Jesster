// The Flows shelf's end-to-end suite (e2e/): the built app under Playwright's Electron support. Run `npm run build`
// first; then `npm run e2e`. One app is launched for the whole file (its tests run in order), with a temp settings
// folder and vault and a local fake for Steward's MCP host. No retries: a flip is a defect to fix.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.mjs',
  timeout: 45000,
  globalTimeout: 150000,
  expect: { timeout: 10000 },
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
