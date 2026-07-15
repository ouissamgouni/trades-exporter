import { test, expect } from '@playwright/test'

// Backend-backed critical test: verifies the transactions list renders
// real backend data seeded from scenarios/frontend_e2e (see
// frontend/playwright.backend-e2e.config.ts globalSetup).
test.describe('transactions (backend-e2e, critical)', () => {
    test('all transactions shows the seeded BTC buy', async ({ page }) => {
        await page.goto('/all-transactions')

        await expect(page.getByText('BTC').first()).toBeVisible()
        // Account name is hard-truncated in the table's Source Info cell
        // (e.g. "Playwright Wal…"), so match a prefix rather than the full name.
        await expect(page.getByText(/Playwright Wal/).first()).toBeVisible()
    })
})
