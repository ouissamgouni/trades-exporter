import { describe, it, expect } from 'vitest'
import {
    applyFacetSelection,
    facetDimensions,
    formatGroupAmount,
    formatGroupAmountExact,
    formatNetQty,
    groupsUrlFor,
    shouldAutoExpandDays,
    truncateSymbol,
    withoutInvalid,
} from './groupUtils'

describe('withoutInvalid', () => {
    it('drops invalid from the status filter', () => {
        expect(withoutInvalid(new URLSearchParams())?.get('review_status')).toBe('pending,valid')
        expect(withoutInvalid(new URLSearchParams({ review_status: 'valid,invalid' }))?.get('review_status')).toBe('valid')
    })
    it('returns null when only invalid is filtered', () => {
        expect(withoutInvalid(new URLSearchParams({ review_status: 'invalid' }))).toBeNull()
    })
})
import { intersectBounds } from './useTransactionGroups'
import type { TransactionGroup } from './types'

const facet = (value: string, count = 1) => ({ value, label: value, count })

const makeGroup = (overrides: Partial<TransactionGroup> = {}): TransactionGroup => ({
    period_start: '2026-11-01',
    date_from: '2026-10-31T23:00:00',
    date_to: '2026-11-30T22:59:59.999999',
    total_count: 10,
    pending_count: 10,
    valid_count: 0,
    invalid_count: 0,
    health_issue_count: 0,
    accounts: [],
    facets: { accounts: [], assets: [], networks: [], sources: [] },
    realized_pnl_in_base: null,
    ...overrides,
})

describe('group recap rules (major)', () => {
    it('offers only facet dimensions with 2+ values', () => {
        const twoAccounts = { accounts: [facet('1'), facet('2')], assets: [facet('9')], networks: [], sources: [] }
        expect(facetDimensions(makeGroup({ facets: twoAccounts }))).toEqual(['accounts'])
        const single = { accounts: [facet('1')], assets: [facet('9')], networks: [], sources: [] }
        expect(facetDimensions(makeGroup({ facets: single }))).toEqual([])
    })

    it('truncates asset symbols to 8 characters', () => {
        expect(truncateSymbol('BNKE.PA')).toBe('BNKE.PA')
        expect(truncateSymbol('VERYLONGSYMBOL')).toBe('VERYLONG…')
    })

    it('auto-expands days only for months with at most 50 rows (invalid included)', () => {
        expect(shouldAutoExpandDays(makeGroup({ total_count: 45, invalid_count: 5 }))).toBe(true)
        expect(shouldAutoExpandDays(makeGroup({ total_count: 45, invalid_count: 6 }))).toBe(false)
    })

    it('formats signed net quantities', () => {
        expect(formatNetQty(0.5)).toBe('+0.5')
        expect(formatNetQty(-1200)).toBe('−1,200')
        expect(formatNetQty(0)).toBe('0')
    })

    it('formats group amounts with 2 decimals and dust as <0.01', () => {
        expect(formatGroupAmount(1234.5)).toBe('1,234.50')
        expect(formatGroupAmount(-3.456)).toBe('−3.46')
        expect(formatGroupAmount(0)).toBe('0.00')
        expect(formatGroupAmount(0.0000199)).toBe('<0.01')
        expect(formatGroupAmount(-0.0000199)).toBe('>−0.01')
        expect(formatGroupAmountExact(0.0000199)).toBe('0.0000199')
    })
})

describe('group query params (critical)', () => {
    it('group facets override the global dimension only', () => {
        const params = new URLSearchParams({ account_id: '1,2', review_status: 'pending' })
        const next = applyFacetSelection(params, { accounts: ['2'], assets: [] })
        expect(next.get('account_id')).toBe('2')
        expect(next.get('asset_id')).toBeNull()
        expect(next.get('review_status')).toBe('pending')
    })

    it('narrows a period to the global date filter', () => {
        const params = new URLSearchParams({ date_from: '2026-11-10T00:00:00' })
        const next = intersectBounds(params, { from: '2026-11-01T00:00:00', to: '2026-11-30T23:59:59' })
        expect(next.get('date_from')).toBe('2026-11-10T00:00:00')
        expect(next.get('date_to')).toBe('2026-11-30T23:59:59')
    })

    it('derives the grouping endpoint from the table data source', () => {
        expect(groupsUrlFor(undefined)).toMatch(/\/transactions\/groups$/)
        expect(groupsUrlFor('http://x/pnl/versions/3/enriched-transactions?unit_pattern=swap'))
            .toBe('http://x/pnl/versions/3/enriched-transactions/groups?unit_pattern=swap')
        expect(groupsUrlFor('http://x/raw-accounts/a/b/transactions?field_type=x')).toBeNull()
    })
})
