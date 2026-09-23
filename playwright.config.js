import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  workers: process.platform === 'darwin' ? 1 : undefined,
});
