import { test, expect } from '@playwright/test'

// Backend-backed critical test: exercises the app's core write path —
// manually adding a transaction — against the real backend/DB seeded
// from scenarios/frontend_e2e, then verifies it persists and shows up
// in the All Transactions list.
test.describe('add transaction (backend-e2e, critical)', () => {
    test('manual form creates a transaction that appears in All Transactions', async ({ page }) => {
        await page.goto('/add-transaction/manual')

        // Account: select the seeded fixture account
        await page.getByPlaceholder('Select or create account...').click()
        await page.getByText('Playwright Wallet', { exact: true }).click()

        // Asset: select BTC
        await page.getByPlaceholder('Select or create asset...').click()
        await page.getByText('BTC', { exact: true }).click()

        // Quantity — a distinctive value we can find later in the list
        await page.locator('input[type="number"][placeholder="0.00"]').first().fill('0.05')

        await page.getByRole('button', { name: '➕ Create Transaction' }).click()

        // Success feedback in the form itself
        await expect(page.getByText(/Transaction created successfully/)).toBeVisible()

        // Confirm it persisted and shows up in the All Transactions list
        await page.goto('/all-transactions')
        await expect(page.getByText('0.05').first()).toBeVisible()
    })
})
