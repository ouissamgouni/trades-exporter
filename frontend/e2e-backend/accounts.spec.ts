import { test, expect } from '@playwright/test'

// Backend-backed critical test: verifies the app renders real data seeded
// from scenarios/frontend_e2e (see .taskfiles/start.yml `start:scenario:backend`
// and frontend/playwright.backend-e2e.config.ts globalSetup).
test.describe('accounts (backend-e2e, critical)', () => {
    test('setup > accounts shows the seeded fixture account', async ({ page }) => {
        await page.goto('/setup/accounts')

        await expect(page.getByText('Playwright Wallet')).toBeVisible()
    })
})
