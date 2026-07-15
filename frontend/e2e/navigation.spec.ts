import { test, expect } from '@playwright/test'

// Major smoke test: switching top-level tabs must update the URL (routes are
// deep-linkable, see App.tsx's route-driven tab state) and render the
// corresponding panel.
test.describe('tab navigation (major)', () => {
    test('switching to the Sync tab updates the URL', async ({ page }) => {
        await page.goto('/')

        await page.getByRole('button', { name: /Sync/ }).click()
        await expect(page).toHaveURL(/\/sync\/control$/)
    })

    test('switching to the Prices tab updates the URL', async ({ page }) => {
        await page.goto('/')

        await page.getByRole('button', { name: /Prices/ }).click()
        await expect(page).toHaveURL(/\/prices$/)
    })

    test('navigating directly to a deep-linked route restores the correct tab', async ({ page }) => {
        await page.goto('/pnl/portfolio')

        // The active tab trigger gets the underline-variant "active" styling.
        await expect(page.getByRole('button', { name: /P&L/ })).toHaveClass(/text-blue-600/)
    })
})
