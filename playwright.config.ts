import { defineConfig, devices } from '@playwright/test';

// Dedicated port so e2e doesn't fight an in-flight `npm run dev`.
const PORT = 5180;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Restrict to *.spec.ts so we don't pick up vitest's *.test.ts files,
  // which use vitest globals (vi.mock, etc.) that Playwright doesn't provide.
  testMatch: '**/*.spec.ts',
  // Vite dev with HMR doesn't love concurrent navigation from multiple tests.
  // Run serially against a single server — the suite is small enough.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Invoke vite directly; `npm run dev -- --port` flag forwarding is
    // fragile across shells on Windows. Force IPv4 binding because Vite
    // on some Windows setups binds only to `[::1]`, which Playwright (which
    // probes 127.0.0.1) can't reach.
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
