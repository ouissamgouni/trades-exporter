import { describe, it, expect } from 'vitest'
import { getBlockingJob, readApiError } from './syncJobApi'

describe('readApiError / getBlockingJob (major: sync start error reporting)', () => {
    it('extracts the blocking job from a structured 409', async () => {
        const blocking = { id: 802, status: 'pending', started_at: '2026-03-17T19:52:33', orphaned: true }
        const res = new Response(
            JSON.stringify({ detail: { code: 'sync_job_active', message: 'Sync job #802 is stuck', blocking_job: blocking } }),
            { status: 409 },
        )

        const err = await readApiError(res, 'Failed to start job')

        expect(err.message).toBe('Sync job #802 is stuck')
        expect(getBlockingJob(err)).toEqual(blocking)
    })

    it('handles plain string details and non-JSON bodies', async () => {
        const plain = await readApiError(new Response(JSON.stringify({ detail: 'boom' }), { status: 500 }), 'Failed')
        expect(plain.message).toBe('boom')
        expect(getBlockingJob(plain)).toBeNull()

        const html = await readApiError(new Response('<html>Bad gateway</html>', { status: 502 }), 'Failed to start job')
        expect(html.message).toBe('Failed to start job (HTTP 502)')
    })
})
