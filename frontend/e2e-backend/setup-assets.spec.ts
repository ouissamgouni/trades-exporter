import { test, expect } from '@playwright/test'

// Backend-backed major test: verifies Setup > Assets renders the
// fixture's configured assets from scenarios/frontend_e2e.
test.describe('setup assets (backend-e2e, major)', () => {
    test('setup > assets shows the seeded BTC and EUR assets', async ({ page }) => {
        await page.goto('/setup/assets')

        await expect(page.getByText('BTC').first()).toBeVisible()
        await expect(page.getByText('EUR').first()).toBeVisible()
    })
})
