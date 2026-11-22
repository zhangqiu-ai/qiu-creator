import { defineConfig } from '@playwright/test';

/** Performance checks (QC-065): run on request, never part of the e2e suite. */
export default defineConfig({
  testDir: '.',
  testMatch: '*.perf.ts',
  outputDir: '../../tmp/playwright-perf',
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  use: { trace: 'off' },
});
