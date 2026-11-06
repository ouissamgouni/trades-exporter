import { test, expect } from '@playwright/test'

// Critical: a job stuck in the DB used to block every sync silently (409 with no
// visible feedback). The UI must name the job and offer a working abort.
test.describe('sync blocked by stuck job (critical)', () => {
    test('shows the stuck job and aborts it', async ({ page }) => {
        let aborted = false
        await page.route('**/sync-job/status', (route) =>
            route.fulfill({
                json: {
                    status: 'idle',
                    total_processed: 0, new_entries_added: 0, entries_updated: 0, duplicates_skipped: 0,
                    errors: [], error_count: 0, connectors_completed: [], total_connectors: 0, abort_requested: false,
                    blocking_job: aborted ? null : { id: 802, status: 'pending', started_at: '2026-03-17T19:52:33', orphaned: true },
                },
            }),
        )
        await page.route('**/sync-job/jobs/802/abort', (route) => {
            aborted = true
            return route.fulfill({ json: { status: 'aborted', message: 'Stuck job #802 (pending) was marked as aborted.', job_id: 802 } })
        })

        await page.goto('/sync/control')

        const alert = page.getByRole('alert').filter({ hasText: 'Sync job #802 is stuck' })
        await expect(alert).toBeVisible()
        await expect(page.getByRole('button', { name: 'Start Sync Job' })).toBeDisabled()

        await alert.getByRole('button', { name: 'Abort stuck job' }).click()

        await expect(page.getByText('Job #802 aborted')).toBeVisible()
        await expect(alert).toHaveCount(0)
    })
})
