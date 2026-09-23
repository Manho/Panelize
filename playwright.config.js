import { defineConfig } from '@playwright/test';

// Browsers launch headless through tests/e2e/browser-launch-options.js, so
// parallel workers no longer fight over window focus on macOS.
export default defineConfig({
  testDir: 'tests/e2e',
});
