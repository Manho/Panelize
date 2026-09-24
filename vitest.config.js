import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    // Playwright suites have their own runners and configs.
    exclude: [...configDefaults.exclude, 'tests/e2e/**', 'tests/live/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.config.js',
        '**/dist/',
        '**/.{idea,git,cache,output,temp}/',
      ],
    },
    setupFiles: ['./tests/setup.js'],
  },
});
