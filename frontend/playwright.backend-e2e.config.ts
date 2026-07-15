import { defineConfig, devices } from '@playwright/test'
import { resolveScenarioPorts } from './e2e-backend/scenario'

// Backend-backed E2E suite: exercises real backend-rendered data seeded from
// the dedicated `scenarios/frontend_e2e` fixture. Unlike playwright.config.ts
// (static smoke tests), these tests require the backend API to be running
// and reachable, so a global setup/teardown starts/stops a detached
// `frontend_e2e` scenario (DB + backend only, see .taskfiles/start.yml).
const { apiPort, webPort } = resolveScenarioPorts()
const baseURL = `http://localhost:${webPort}`

export default defineConfig({
    testDir: './e2e-backend',
    testMatch: /.*\.spec\.ts/,
    globalSetup: './e2e-backend/global-setup.ts',
    globalTeardown: './e2e-backend/global-teardown.ts',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
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
        command: `npm run dev -- --port ${webPort} --no-open`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
            VITE_API_URL: `http://localhost:${apiPort}`,
        },
    },
})
