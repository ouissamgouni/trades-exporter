import { describe, it, expect } from 'vitest'
import { priceScopedRows, sumLiveBalancesForAccounts } from './pnlCalculations'
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
