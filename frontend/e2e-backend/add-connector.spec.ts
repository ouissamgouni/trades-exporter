import { test, expect } from '@playwright/test'
import { resolveScenarioPorts } from './scenario'

const { apiPort } = resolveScenarioPorts()
const API = `http://localhost:${apiPort}`

// Major: the add-connector dialog asks for the network first and only lists
// providers supporting it, recommended one first.
test.describe('add connector (backend-e2e, major)', () => {
    test.afterEach(async ({ request }) => {
        const accounts = await (await request.get(`${API}/accounts/`)).json()
        const wallet = (Array.isArray(accounts) ? accounts : accounts.items ?? [])
            .find((a: { name: string }) => a.name === 'Playwright Wallet')
        if (wallet) await request.delete(`${API}/accounts/${wallet.id}/connectors/ankr`)
    })

    test('network-first picker filters providers and creates the connector', async ({ page }) => {
        await page.goto('/setup/accounts')
        await page.getByText('Playwright Wallet').click()
        await page.getByRole('button', { name: 'Add Connector' }).click()

        const dialog = page.getByRole('dialog')
        await dialog.getByLabel('Network').selectOption({ label: 'BNB Smart Chain' })

        const typeSelect = dialog.getByLabel('Connector Type')
        const options = typeSelect.locator('option:not([value=""])')
        await expect(options.first()).toContainText('EVM · Ankr')
        await expect(options.first()).toContainText('recommended')
        await expect(typeSelect.locator('option', { hasText: 'Etherscan' })).toHaveCount(0)
        await expect(typeSelect.locator('option', { hasText: 'Binance' })).toHaveCount(0)
        await expect(typeSelect).toHaveValue('ankr')
        await expect(dialog.getByLabel('Chain')).toHaveValue('bsc')

        await dialog.getByRole('button', { name: 'Create' }).click()
        await expect(dialog).toBeHidden()
        await expect(page.getByText('EVM · Ankr')).toBeVisible()
    })
})
