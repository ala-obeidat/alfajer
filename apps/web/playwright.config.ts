import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  // Boot both halves of the stack so the E2E specs are self-contained (CI can
  // run `playwright test` with no manual server setup). Locally, an already
  // running `bun dev` is reused instead of spawning a duplicate.
  webServer: [
    {
      // Signaling relay (WebSocket + /healthz). cwd is the repo root, resolved
      // relative to this config's directory (apps/web).
      command: 'bun --cwd apps/signaling dev',
      cwd: '../..',
      url: 'http://localhost:3000/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // SvelteKit web app. PUBLIC_* are consumed via $env/static/public, so
      // they must exist in the process env — a fresh CI checkout has no .env.
      command: 'bun --cwd apps/web dev',
      cwd: '../..',
      url: 'http://localhost:5173',
      env: {
        PUBLIC_SIGNALING_URL: 'http://localhost:3000',
        PUBLIC_TURN_URL: '',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    }
  ],
});
