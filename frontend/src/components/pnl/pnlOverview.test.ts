import { describe, it, expect } from 'vitest'
import { buildBridgeRows, bridgeSegments } from './ReturnBridge'
import { splitContributors } from './ContributorsPanel'
import { sortAccounts, accountsMismatch, isClosedAccount } from './AccountsStrip'
import { columnValue, sumColumn, type HoldingRow } from './AssetsSection'
import type { RangeMetrics } from './TotalReturnScorecard'
import type { PerformerItem } from '../../hooks/useChartData'
import type { AssetPnLRow } from './types'

const metrics = (o: Partial<RangeMetrics> = {}): RangeMetrics => ({
    totalReturn: 0, roi: 0, currentValue: 1200, costBasis: 1000, totalInvested: 1000,
    unrealizedPnl: 200, realizedPnl: 50, taxableRealizedPnl: 40, realizedInPeriod: 30,
    taxableRealizedInPeriod: 20, totalFees: 12, feeEntryCount: 3, costBasisInPeriod: 100,
    unrealizedInPeriod: 80, feesInPeriod: 4, totalIncome: 15, totalWithholding: 5,
    incomeEventCount: 2, incomeInPeriod: 6, withholdingInPeriod: 1, ...o,
})

const perf = (id: number, o: Partial<PerformerItem> = {}): PerformerItem => ({
    id, name: `P${id}`, group_type: 'asset', total_return: 0, roi_pct: 0, unrealized_pnl: 0,
    market_value: 0, cost_basis: 0, total_fees: 0, efficiency: 0, ...o,
})

describe('ReturnBridge (critical)', () => {
    it('all-time rows: value = cost + unrealized, total return = unrealized + realized, income apart', () => {
        const [value, ret] = buildBridgeRows(metrics(), false, 'EUR')
        expect(value.steps.map(s => s.value)).toEqual([1000, 200, 1200])
        expect(ret.steps.map(s => s.key)).toEqual(['unrealized', 'realized', 'total', 'income'])
        expect(ret.steps[2].value).toBe(250)
        expect(ret.steps[3]).toMatchObject({ kind: 'extra', value: 10 })
        expect(ret.note?.value).toContain('12')
    })

    it('period rows: start + cost Δ + unrealized Δ = end value', () => {
        const [value, ret] = buildBridgeRows(metrics(), true, 'EUR')
        const [start, costD, unrD, end] = value.steps.map(s => s.value)
        expect(start + costD + unrD).toBeCloseTo(end)
        expect(end).toBe(1200)
        expect(ret.steps[2].value).toBe(110)
        expect(ret.steps[3].value).toBe(5)
    })

    it('segments float deltas from the running total', () => {
        const [, ret] = buildBridgeRows(metrics({ unrealizedPnl: 200, realizedPnl: -50, incomeEventCount: 0, totalIncome: 0, totalWithholding: 0 }), false, 'EUR')
        expect(bridgeSegments(ret.steps)).toEqual([
            { from: 0, to: 200 },
            { from: 200, to: 150 },
            { from: 0, to: 150 },
        ])
    })
})

describe('ContributorsPanel (critical)', () => {
    it('splits gains/losses and nets them', () => {
        const items = [perf(1, { total_return: 50 }), perf(2, { total_return: -20 }), perf(3, { total_return: 10 })]
        const r = splitContributors(items, 'TR')
        expect(r.positives.map(p => p.id)).toEqual([1, 3])
        expect(r.negatives.map(p => p.id)).toEqual([2])
        expect(r.gains).toBe(60)
        expect(r.losses).toBe(-20)
        expect(r.net).toBe(40)
    })
})

describe('AccountsStrip (major)', () => {
    const items = [
        perf(1, { name: 'b', market_value: 100, total_return: 5, roi_pct: 5 }),
        perf(2, { name: 'a', market_value: 300, total_return: -10, roi_pct: -3 }),
        perf(3, { name: 'c', market_value: 0, total_return: 2, roi_pct: 0 }),
    ]

    it('sorts by value / return / name', () => {
        expect(sortAccounts(items, 'value', 'desc').map(p => p.id)).toEqual([2, 1, 3])
        expect(sortAccounts(items, 'return', 'asc').map(p => p.id)).toEqual([2, 3, 1])
        expect(sortAccounts(items, 'name', 'asc').map(p => p.id)).toEqual([2, 1, 3])
    })

    it('flags closed accounts and Σ mismatches beyond rounding', () => {
        expect(isClosedAccount(items[2])).toBe(true)
        expect(accountsMismatch(items, 400)).toBeNull()
        expect(accountsMismatch(items, 400.5)).toBeNull()
        expect(accountsMismatch(items, 450)).toBe(-50)
    })
})

const asset = (o: Partial<AssetPnLRow> = {}): AssetPnLRow => ({
    asset: { id: 1, symbol: 'BTC', label: 'Bitcoin' },
    account_ids: [1], category_ids: [], quantity: 2, market_value: 300, cost_basis: 200,
    unrealized_pnl: 100, unrealized_pnl_pct: 0.5, realized_pnl: 20, taxable_realized_pnl: 10,
    total_fees: 3, lot_count: 2, realized_event_count: 1, warning_count: 0, has_lots: true,
    unit_value: 150, ...o,
} as AssetPnLRow)

const holding = (a: AssetPnLRow, o: Partial<HoldingRow> = {}): HoldingRow => ({
    key: String(a.asset.id), src: a, partial: false, qty: a.quantity, cost: a.cost_basis,
    value: a.market_value, unrealized: a.unrealized_pnl, ...o,
})

describe('AssetsSection columns (critical)', () => {
    it('computes per-row values, hides realized on account slices', () => {
        const r = holding(asset(), { delta: { asset_id: 1, symbol: 'BTC', total_return: 7, roi_pct: 2, unrealized_change: 5, realized_in_period: 2, cost_change: 0, market_value_change: 5, income_in_period: 4 } })
        expect(columnValue('totalReturn', r, 600)).toBe(120)
        expect(columnValue('weight', r, 600)).toBe(50)
        expect(columnValue('income', r, 600)).toBe(4)
        expect(columnValue('retDelta', r, 600)).toBe(7)
        const slice = holding(asset(), { partial: true, accountId: 2, qty: 1, cost: 100, value: 150, unrealized: 50 })
        expect(columnValue('realized', slice, 600)).toBeNull()
        expect(columnValue('unrealized', slice, 600)).toBe(50)
    })

    it('sums only applicable values', () => {
        const rows = [holding(asset()), holding(asset({ asset: { id: 2, symbol: 'ETH', label: null }, realized_pnl: -5, unrealized_pnl: -10 }))]
        expect(sumColumn('realized', rows, 600)).toBe(15)
        expect(sumColumn('income', rows, 600)).toBeNull()
    })
})
