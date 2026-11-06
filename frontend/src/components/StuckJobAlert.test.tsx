import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../test/server'
import { StuckJobAlert } from './StuckJobAlert'
import { Toaster } from './ui/toaster'

describe('StuckJobAlert (critical: only way to unblock syncs)', () => {
    const job = { id: 802, status: 'pending', started_at: '2026-03-17T19:52:33' }

    it('explains which job blocks syncs', () => {
        render(<StuckJobAlert job={job} onAborted={() => { }} />)

        expect(screen.getByRole('alert')).toHaveTextContent('Sync job #802 is stuck and blocks new syncs')
        expect(screen.getByRole('alert')).toHaveTextContent('pending')
    })

    it('aborts that specific job and notifies', async () => {
        let abortedId: string | undefined
        server.use(
            http.post('*/sync-job/jobs/:id/abort', ({ params }) => {
                abortedId = params.id as string
                return HttpResponse.json({ status: 'aborted', message: 'Stuck job #802 (pending) was marked as aborted.', job_id: 802 })
            }),
        )
        const onAborted = vi.fn()
        render(<><StuckJobAlert job={job} onAborted={onAborted} /><Toaster /></>)

        await userEvent.click(screen.getByRole('button', { name: 'Abort stuck job' }))

        expect(await screen.findByText('Job #802 aborted')).toBeInTheDocument()
        expect(abortedId).toBe('802')
        expect(onAborted).toHaveBeenCalledOnce()
    })

    it('shows the backend error when abort fails', async () => {
        server.use(
            http.post('*/sync-job/jobs/:id/abort', () =>
                HttpResponse.json({ detail: 'Job #802 is not active' }, { status: 409 }),
            ),
        )
        const onAborted = vi.fn()
        render(<><StuckJobAlert job={job} onAborted={onAborted} /><Toaster /></>)

        await userEvent.click(screen.getByRole('button', { name: 'Abort stuck job' }))

        expect(await screen.findByText('Job #802 is not active')).toBeInTheDocument()
        expect(onAborted).not.toHaveBeenCalled()
    })
})
