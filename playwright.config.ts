import { defineConfig, devices } from '@playwright/test'

// E2E runs against the production build served by `vite preview`. `npm run test:e2e` builds first.
const port = Number(process.env.E2E_PORT ?? 4173)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    // Never reuse a server that was already running: it could be serving an old build.
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
