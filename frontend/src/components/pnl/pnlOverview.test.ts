import { describe, it, expect } from 'vitest'
import { compositionSegments } from './OverviewCards'
import { splitContributors } from './ContributorsPanel'
import { sortAccounts, accountsMismatch, isClosedAccount, groupAccounts, UNGROUPED_LABEL } from './AccountsStrip'
import { columnValue, sumColumn, splitHalves, type HoldingRow } from './AssetsSection'
import { aggregateByAccount } from './AccountPnLCard'
import { cumulativeTwr, seriesReturnBetween } from './chartUtils'
import { presetTooltip } from './PeriodPresets'
import { pnlReducer, createInitialPnLState, computeContextScope } from './pnlState'
import type { PerformerItem } from '../../hooks/useChartData'
import type { AssetPnLRow } from './types'

const perf = (id: number, o: Partial<PerformerItem> = {}): PerformerItem => ({
    id, name: `P${id}`, group_type: 'asset', total_return: 0, roi_pct: 0, unrealized_pnl: 0,
    market_value: 0, cost_basis: 0, total_fees: 0, efficiency: 0, ...o,
})

describe('Composition bar (critical)', () => {
    it('unrealized and realized first, then cost after a gap, fees at the end of cost', () => {
        const { segments, fees } = compositionSegments(1000, 200, 50, 20)
        expect(segments.map(s => s.key)).toEqual(['unrealized', 'realized', 'cost'])
        const [unr, real, cost] = segments
        expect(unr.left).toBe(0)
        expect(real.left).toBeCloseTo(unr.width)
        expect(cost.left).toBeCloseTo(unr.width + real.width + 1.5)
        expect(unr.width + real.width + cost.width).toBeCloseTo(98.5)
        expect(fees!.left + fees!.width).toBeCloseTo(cost.left + cost.width)
    })

    it('negative P&L segments are flagged; fees never exceed cost', () => {
        const { segments, fees } = compositionSegments(100, -200, -50, 500)
        expect(segments[0]).toMatchObject({ key: 'unrealized', negative: true })
        expect(segments[1]).toMatchObject({ key: 'realized', negative: true })
        expect(fees!.width).toBeCloseTo(segments[2].width)
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

    it('groups accounts by account group, largest first, Ungrouped last', () => {
        const groups: Record<number, string | undefined> = { 1: 'CEX', 2: undefined, 3: 'CEX' }
        const buckets = groupAccounts(items, id => groups[id])
        expect(buckets.map(b => b.label)).toEqual(['CEX', UNGROUPED_LABEL])
        expect(buckets[0].items.map(p => p.id)).toEqual([1, 3])
        expect(buckets[0].value).toBe(100)
        expect(buckets[0].totalReturn).toBe(7)
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

describe('Time-weighted return (critical)', () => {
    const pt = (date: string, v: number, pnl: number) => ({ date, total_value_in_base: v, unrealized_pnl: pnl, cumulative_realized_pnl: 0 })

    it('ignores deposit timing (matches backend)', () => {
        const s = cumulativeTwr([pt('2025-01-01', 100, 0), pt('2025-01-02', 110, 10), pt('2025-01-03', 210, 10), pt('2025-01-04', 231, 31)])
        expect(s[s.length - 1].y).toBeCloseTo(21)
        expect(s[2].y).toBeCloseTo(10)
    })

    it('benchmark return between dates forward-fills', () => {
        const pts = [{ date: '2025-01-01', close: 100 }, { date: '2025-01-05', close: 110 }, { date: '2025-01-10', close: 121 }]
        expect(seriesReturnBetween(pts, '2025-01-07')).toBeCloseTo(10)
        expect(seriesReturnBetween(pts, null)).toBeCloseTo(21)
        expect(seriesReturnBetween([], null)).toBeNull()
    })

    it('preset tooltip shows excess vs benchmark', () => {
        expect(presetTooltip('1Y', 6.4, 11.2, { label: 'S&P 500', value: 8.1 })).toBe('1Y · ROI +6.4% · TWR +11.2% · S&P 500 +8.1% · +3.1 pp')
    })
})

describe('Assets split + account cards (major)', () => {
    it('splits at the midpoint, worst half from the other end', () => {
        expect(splitHalves([5, 4, 3, 2, 1])).toEqual({ top: [5, 4, 3], bottom: [1, 2] })
    })

    it('aggregates assets per account with live-price value', () => {
        const a = (id: number, unit: number) => ({ asset: { id, symbol: `S${id}` }, unit_value: unit, cost_basis: 0, market_value: 0, unrealized_pnl: 0, lot_count: 1 })
        const bal = new Map([
            [1, [{ account_id: 7, account_name: 'X', qty: 2, cost_basis_in_base: 10, avg_unit_cost_in_base: 5, lot_count: 1 }]],
            [2, [{ account_id: 7, account_name: 'X', qty: 1, cost_basis_in_base: 4, avg_unit_cost_in_base: 4, lot_count: 2 }]],
        ])
        const [row] = aggregateByAccount([a(1, 10), a(2, 3)], bal)
        expect(row).toMatchObject({ account_id: 7, asset_count: 2, total_market_value: 23, total_cost_basis: 14, total_unrealized_pnl: 9, total_lot_count: 3 })
    })
})

describe('Multi-account scope (critical)', () => {
    it('toggles accounts into one scope and back to portfolio', () => {
        let st = createInitialPnLState('EUR', 1, [])
        st = pnlReducer(st, { type: 'TOGGLE_ACCOUNT_SCOPE', accountId: 3, name: 'Binance' })
        st = pnlReducer(st, { type: 'TOGGLE_ACCOUNT_SCOPE', accountId: 5, name: 'Degiro' })
        expect(computeContextScope(st.drill, 'all').accountIds).toEqual([3, 5])
        expect(st.drill.breadcrumbs.map(b => b.label)).toEqual(['Portfolio', 'Accounts: Binance, Degiro'])
        st = pnlReducer(st, { type: 'TOGGLE_ACCOUNT_SCOPE', accountId: 3, name: 'Binance' })
        expect(computeContextScope(st.drill, 'all').accountIds).toEqual([5])
        expect(st.drill.entityLabel).toBe('Degiro')
        st = pnlReducer(st, { type: 'TOGGLE_ACCOUNT_SCOPE', accountId: 5, name: 'Degiro' })
        expect(computeContextScope(st.drill, 'all').level).toBe('portfolio')
    })

    it('applies a confirmed selection at once; empty selection resets', () => {
        let st = createInitialPnLState('EUR', 1, [])
        st = pnlReducer(st, { type: 'SET_ACCOUNT_SCOPE', accounts: [{ id: 3, name: 'Binance' }, { id: 5, name: 'Degiro' }] })
        expect(computeContextScope(st.drill, 'all').accountIds).toEqual([3, 5])
        st = pnlReducer(st, { type: 'SET_ACCOUNT_SCOPE', accounts: [] })
        expect(computeContextScope(st.drill, 'all').level).toBe('portfolio')
    })
})
