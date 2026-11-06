import { describe, it, expect } from 'vitest'
import {
    applyFacetSelection,
    facetDimensions,
    formatNetQty,
    groupsUrlFor,
    shouldAutoExpandDays,
    shouldAutoShowFacetBar,
    statusChips,
} from './groupUtils'
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
    it('shows only non-zero status chips', () => {
        const chips = statusChips(makeGroup({ pending_count: 3, valid_count: 0, invalid_count: 2 }))
        expect(chips.map(c => c.key)).toEqual(['pending', 'invalid'])
    })

    it('auto-shows the facet bar only for 20+ rows with a dimension of 2+ values', () => {
        const twoAccounts = { accounts: [facet('1'), facet('2')], assets: [facet('9')], networks: [], sources: [] }
        expect(shouldAutoShowFacetBar(makeGroup({ total_count: 19, facets: twoAccounts }))).toBe(false)
        expect(shouldAutoShowFacetBar(makeGroup({ total_count: 20, facets: twoAccounts }))).toBe(true)
        expect(facetDimensions(makeGroup({ facets: twoAccounts }))).toEqual(['accounts'])
        const single = { accounts: [facet('1')], assets: [facet('9')], networks: [], sources: [] }
        expect(shouldAutoShowFacetBar(makeGroup({ total_count: 500, facets: single }))).toBe(false)
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
