import { test, expect } from '@playwright/test'

// Critical smoke test: the app shell must render and the default route must
// redirect to the first workflow step. This does NOT require the backend —
// it exercises the static shell/navigation, which render regardless of
// whether the API is reachable (fetches fail silently and are caught).
test.describe('app shell (critical)', () => {
    test('home renders the app shell and redirects to the default tab', async ({ page }) => {
        await page.goto('/')

        await expect(page.getByText('TradeTrail').first()).toBeVisible()
        await expect(page).toHaveURL(/\/setup\/accounts$/)
    })

    test('top-level workflow tabs are visible', async ({ page }) => {
        await page.goto('/')

        await expect(page.getByRole('button', { name: /Setup/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Sync/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Add \/ Import/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /P&L/ })).toBeVisible()
    })
})
