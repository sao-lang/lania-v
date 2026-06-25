import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/bench',
  timeout: 10 * 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4176',
    trace: 'off',
  },
  webServer: {
    command:
      'npm run build --workspace @lania-v/playground-benchmark && npm run preview --workspace @lania-v/playground-benchmark',
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
