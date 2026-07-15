import { test, expect } from '@playwright/test'

// Backend-backed critical test: exercises the app's core value
// proposition — running a real P&L calculation against seeded
// transactions + mock prices (scenarios/frontend_e2e/prices.yaml) and
// verifying the resulting numbers render.
test.describe('pnl (backend-e2e, critical)', () => {
    test('portfolio > calculate P&L shows the BTC position with an unrealized gain', async ({ page }) => {
        test.setTimeout(60_000)

        await page.goto('/pnl/portfolio')

        // Fresh scenario DB has no P&L version yet — trigger a calculation.
        await page.getByRole('button', { name: /Calculate P&L|Calculate|Refresh|Recalc/ }).first().click()

        // Calculation runs against the real backend — allow generous time.
        // BTC is bought at 40000 EUR (transactions.yaml) and priced at 45000 EUR
        // (prices.yaml), so it must show a positive unrealized gain.
        await expect(page.getByText('Bitcoin').first()).toBeVisible({ timeout: 45_000 })
        await expect(page.getByText('Unrealized').first()).toBeVisible()
        await expect(page.getByText('+500.00', { exact: false }).first()).toBeVisible()
    })
})
