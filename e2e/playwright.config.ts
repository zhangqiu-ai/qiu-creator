import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  outputDir: '../tmp/playwright',
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  use: { trace: 'retain-on-failure' },
});
