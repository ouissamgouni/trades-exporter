import { defineConfig, devices } from '@playwright/test'

// Critical/major smoke tests. These exercise the static app shell and tab
// navigation against the Vite dev server — they do NOT require the backend
// API to be running (network calls fail silently and are caught in the app).
const PORT = 3002
const baseURL = `http://localhost:${PORT}`

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL,
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'npm run dev -- --no-open',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
})
