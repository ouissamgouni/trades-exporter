import { describe, it, expect } from 'vitest'
import { openWarningCount } from './SummaryCards'
import { isActiveInPeriod, columnValue, type HoldingRow } from './AssetsSection'
import { splitContributors } from './ContributorsPanel'
import { cumulativeTwr } from './chartUtils'
import { priceIssueRanges } from './PortfolioPerformanceChart'
import type { AssetPeriodDelta, PerformerItem, TimelinePoint } from '../../hooks/useChartData'
import type { AssetPnLRow, PnLSummary } from './types'

const asset = (o: Partial<AssetPnLRow> = {}): AssetPnLRow => ({
    asset: { id: 1, symbol: 'HYPE', label: null },
    account_ids: [1], category_ids: [], quantity: 0, market_value: 0, cost_basis: 0,
    unrealized_pnl: 0, unrealized_pnl_pct: 0, realized_pnl: 40, taxable_realized_pnl: 40,
    total_fees: 0, lot_count: 1, realized_event_count: 1, warning_count: 0, has_lots: true,
    has_open_position: false, ...o,
} as AssetPnLRow)

const delta = (o: Partial<AssetPeriodDelta> = {}): AssetPeriodDelta => ({
    asset_id: 1, symbol: 'HYPE', total_return: 0, roi_pct: 0, unrealized_change: 0,
    realized_in_period: 0, cost_change: 0, market_value_change: 0, income_in_period: 0, ...o,
})

const perf = (id: number, o: Partial<PerformerItem> = {}): PerformerItem => ({
    id, name: `P${id}`, group_type: 'asset', total_return: 0, roi_pct: 0, unrealized_pnl: 0,
    market_value: 0, cost_basis: 0, total_fees: 0, efficiency: 0, ...o,
})

const point = (date: string, o: Partial<TimelinePoint> = {}): TimelinePoint => ({
    date, total_value_in_base: 100, cost_basis_in_base: 100, unrealized_pnl: 0,
    cumulative_realized_pnl: 0, cumulative_income: 0, breakdown: [], ...o,
})

describe('Warnings chip count (bug fix)', () => {
    it('counts open warnings only once type counts are known', () => {
        const summary = { warning_count: 1, error_count: 0 } as PnLSummary
        expect(openWarningCount(summary, {})).toBe(0)
        expect(openWarningCount(summary, { missing_price: 2, zero_cost_lot: 1 })).toBe(3)
        expect(openWarningCount(summary, undefined)).toBe(1)
    })
})

describe('Assets active in the selected period (bug fix)', () => {
    it('hides a closed position with no activity in the period', () => {
        expect(isActiveInPeriod(asset(), undefined)).toBe(false)
        expect(isActiveInPeriod(asset(), delta())).toBe(false)
    })

    it('keeps open positions, realized/income/cost movements and no-P&L rows', () => {
        expect(isActiveInPeriod(asset({ has_open_position: true }), undefined)).toBe(true)
        expect(isActiveInPeriod(asset(), delta({ realized_in_period: 12 }))).toBe(true)
        expect(isActiveInPeriod(asset(), delta({ income_in_period: 3 }))).toBe(true)
        expect(isActiveInPeriod(asset(), delta({ cost_change: -100 }))).toBe(true)
        expect(isActiveInPeriod(asset({ has_lots: false }), undefined)).toBe(true)
    })
})

describe('TWR / MWR per asset and contributor', () => {
    it('exposes TWR / MWR as columns, hidden on account slices', () => {
        const a = asset()
        const row: HoldingRow = { key: '1', src: a, partial: false, qty: 0, cost: 0, value: 0, unrealized: 0, twr: 12.5, mwr: null }
        expect(columnValue('twr', row, 0)).toBe(12.5)
        expect(columnValue('mwr', row, 0)).toBeNull()
        expect(columnValue('twr', { ...row, partial: true }, 0)).toBeNull()
    })

    it('ranks contributors by TWR and drops those without one', () => {
        const items = [perf(1), perf(2), perf(3)]
        const returns = { twr: { '1': 5, '2': -3, '3': null }, mwr: {} }
        const r = splitContributors(items, 'TWR', returns)
        expect(r.positives.map(p => p.id)).toEqual([1])
        expect(r.negatives.map(p => p.id)).toEqual([2])
    })
})

describe('Missing prices', () => {
    it('cumulativeTwr carries unpriced holdings at cost (no fake loss)', () => {
        const pts = [
            point('2024-01-01'),
            // 50 bought in an unpriced asset: valued 0, unrealized −50
            point('2024-01-02', { total_value_in_base: 100, cost_basis_in_base: 150, unrealized_pnl: -50, unpriced_cost_in_base: 50 }),
        ]
        expect(cumulativeTwr(pts)[1].y).toBeCloseTo(0)
    })

    it('groups consecutive unpriced/stale dates into shaded ranges', () => {
        const pts = [
            point('2024-01-01'),
            point('2024-01-02', { unpriced_count: 1 }),
            point('2024-01-03', { stale_count: 2 }),
            point('2024-01-04'),
            point('2024-01-05', { stale_count: 1 }),
        ]
        expect(priceIssueRanges(pts)).toEqual([
            { from: '2024-01-02', to: '2024-01-03' },
            { from: '2024-01-05', to: '2024-01-05' },
        ])
    })
})
