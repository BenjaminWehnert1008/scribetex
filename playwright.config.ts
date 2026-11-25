import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
// CI builds once and tests that very build, the one that is deployed afterwards.
const preview = `npm run preview -- --port ${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.E2E_SKIP_BUILD ? preview : `npm run build && ${preview}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
