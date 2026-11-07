import { describe, it, expect } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { server } from '../test/server'
import { AssetDetailPanelProvider } from '../contexts/AssetDetailPanelContext'
import { PriceHealthCards } from './PriceHealthCards'

const healthRow = (asset_id: number, symbol: string, label: string, status: string) => ({
    asset_id, symbol, label, status,
    last_price: 100, last_source: 'mock', last_updated: '2026-11-01T00:00:00',
    first_snapshot: '2026-01-01T00:00:00', total_snapshots: 10, days_stale: 0,
    is_flatline: false, has_transactions: true, sparkline: [], quote_currencies: [],
})

const job = {
    status: 'running', scope_asset_ids: null, started_at: '2026-11-07T10:00:00', finished_at: null,
    total_assets: 2, completed_assets: 0, total_missing_days: 8, processed_days: 0,
    fetched_count: 0, failed_count: 0, current_asset_id: 2, current_date: null, error: null,
    assets: [
        // SOL's gaps were already fixed, so it's no longer in the gap summary
        { asset_id: 3, symbol: 'SOL', label: 'Solana', gap_count: 1, missing_days: 3, status: 'pending', fetched: 0, failed: 0 },
    ],
    log: [],
}

function setup({ jobState = { ...job, status: 'idle', assets: [] } as object } = {}) {
    const skipped: number[] = []
    server.use(
        http.get('*/price-snapshots/health', () => HttpResponse.json({
            items: [
                healthRow(1, 'BTC', 'Bitcoin', 'healthy'),
                healthRow(2, 'ETH', 'Ethereum', 'stale'),
                healthRow(3, 'SOL', 'Solana', 'healthy'),
            ],
            staleness_threshold_days: 3,
            summary: { healthy: 2, warning: 0, stale: 1 },
        })),
        http.get('*/price-snapshots/gaps/summary', () => HttpResponse.json({
            items: [{ asset_id: 2, symbol: 'ETH', label: 'Ethereum', gap_count: 2, total_missing_days: 5 }],
        })),
        http.get('*/price-snapshots/gaps/jobs/current', () => HttpResponse.json(jobState)),
        http.post('*/price-snapshots/gaps/jobs/current/skip/:id', ({ params }) => {
            skipped.push(Number(params.id))
            return HttpResponse.json(jobState)
        }),
    )
    return { skipped }
}

function renderCards(props: ComponentProps<typeof PriceHealthCards> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <AssetDetailPanelProvider>
                <PriceHealthCards {...props} />
            </AssetDetailPanelProvider>
        </QueryClientProvider>,
    )
}

const cardNames = () => Array.from(document.querySelectorAll('[data-asset-card]')).map(c => c.getAttribute('data-asset-card'))

describe('PriceHealthCards (major: shared price health view in /prices and P&L drawer)', () => {
    it('shows asset labels and all assets by default', async () => {
        setup()
        renderCards()

        expect(await screen.findByText('Bitcoin')).toBeInTheDocument()
        expect(screen.getByText('Ethereum')).toBeInTheDocument()
        expect(screen.getByText('All (3)')).toBeInTheDocument()
    })

    it('restricts cards and counts to the given asset scope, opening on gaps', async () => {
        setup()
        renderCards({ assetIds: [1, 2], defaultFilter: 'gaps' })

        expect(await screen.findByText('Ethereum')).toBeInTheDocument()
        expect(await screen.findByText('Gaps (1)')).toBeInTheDocument()
        expect(screen.getByText('All (2)')).toBeInTheDocument()
        expect(cardNames()).toEqual(['2'])
        expect(screen.getByText(/Fix 2 gaps \(5 d\)/)).toBeInTheDocument()
    })

    it('keeps job assets under the gaps filter and lets them be skipped', async () => {
        const { skipped } = setup({ jobState: job })
        renderCards({ defaultFilter: 'gaps' })

        const solana = await screen.findByText('Solana')
        const card = solana.closest('[data-asset-card]') as HTMLElement
        expect(within(card).getByText('Queued')).toBeInTheDocument()

        await userEvent.click(within(card).getByRole('button', { name: 'Skip Solana' }))

        expect(skipped).toEqual([3])
    })
})
