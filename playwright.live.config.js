import { defineConfig } from '@playwright/test';

// Manual smoke suite against real provider sites; see tests/live/ and the
// README development section. It shares one persistent profile, so it runs
// in a single worker.
export default defineConfig({
  testDir: 'tests/live',
  testMatch: '**/*.live.test.js',
  outputDir: 'test-results/live',
  workers: 1,
  reporter: [['list']],
});
