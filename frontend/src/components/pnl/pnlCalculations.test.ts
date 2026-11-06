import { describe, it, expect } from 'vitest'
import { applyPriceToAssetRow, priceScopedRows, sumLiveBalancesForAccounts } from './pnlCalculations'
import { createInitialPnLState, pnlReducer } from './pnlState'
import type { PriceResponse } from '../../types'
import type { AssetPnLRow } from './types'

const row = (id: number, overrides: Partial<AssetPnLRow> = {}): AssetPnLRow => ({
    asset: { id, symbol: `A${id}`, label: null },
    account_ids: [1],
    category_ids: [],
    quantity: 0,
    market_value: 0,
    cost_basis: 0,
    unrealized_pnl: 0,
    unrealized_pnl_pct: 0,
    realized_pnl: 0,
    taxable_realized_pnl: 0,
    total_fees: 0,
    lot_count: 0,
    realized_event_count: 0,
    warning_count: 0,
    ...overrides,
})

describe('priceScopedRows', () => {
    it('values the account slice with the full-portfolio unit price', () => {
        const scoped = [row(1, { quantity: 2, cost_basis: 150 })]
        const priced = [row(1, { quantity: 10, cost_basis: 800, unit_value: 100, market_value: 1000, price_source: 'x' })]

        const [r] = priceScopedRows(scoped, priced)

        expect(r.market_value).toBe(200)
        expect(r.unrealized_pnl).toBe(50)
        expect(r.unit_value).toBe(100)
        expect(r.price_source).toBe('x')
    })

    it('leaves value at 0 when no price is known', () => {
        const [r] = priceScopedRows([row(2, { quantity: 3, cost_basis: 30 })], [])
        expect(r.market_value).toBe(0)
        expect(r.unit_value).toBeNull()
    })
})

describe('sumLiveBalancesForAccounts', () => {
    it('sums only the selected accounts and skips symbols they do not hold', () => {
        const live = new Map([
            ['BTC', new Map([[1, 0.5], [2, 1], [3, 4]])],
            ['ETH', new Map([[3, 10]])],
        ])

        const result = sumLiveBalancesForAccounts(live, [1, 2])

        expect(result.get('BTC')).toBe(1.5)
        expect(result.has('ETH')).toBe(false)
    })
})

const price = (overrides: Partial<PriceResponse> = {}): PriceResponse => ({
    asset: { id: 1, symbol: 'BTC', label: 'Bitcoin' },
    price: null,
    price_quote: 'EUR',
    ...overrides,
})

describe('applyPriceToAssetRow (critical: unrealized P&L valuation)', () => {
    it('values a failed fetch at the last known price and flags it', () => {
        const r = applyPriceToAssetRow(
            row(1, { quantity: 2, cost_basis: 100 }),
            price({ error: 'down', last_known_price: 80, last_known_source: 'coingecko', last_known_price_date: '2026-11-01T00:00:00' }),
        )
        expect(r.unit_value).toBe(80)
        expect(r.market_value).toBe(160)
        expect(r.unrealized_pnl).toBe(60)
        expect(r.price_state).toBe('failed_with_last_known')
        expect(r.price_source).toBe('coingecko')
    })

    it('leaves value at 0 when nothing is known', () => {
        const r = applyPriceToAssetRow(row(1, { quantity: 2, cost_basis: 100 }), price({ error: 'down' }))
        expect(r.unit_value).toBeNull()
        expect(r.market_value).toBe(0)
        expect(r.price_state).toBe('failed')
    })
})

describe('UPSERT_PRICE (critical: never lose a known price on refresh failure)', () => {
    it('carries the previous price forward as last known', () => {
        let state = createInitialPnLState('EUR', null, [])
        state = pnlReducer(state, { type: 'UPSERT_PRICE', assetId: 1, price: price({ price: 50, source: 'cached-src', fetched_at: '2026-11-01T00:00:00', price_state: 'cached' }) })
        state = pnlReducer(state, { type: 'UPSERT_PRICE', assetId: 1, price: price({ error: 'Request timed out', price_state: 'failed' }) })

        const [p] = state.prices
        expect(p.price).toBeNull()
        expect(p.last_known_price).toBe(50)
        expect(p.last_known_source).toBe('cached-src')
        expect(p.price_state).toBe('failed_with_last_known')
        expect(p.error).toBe('Request timed out')
    })
})
