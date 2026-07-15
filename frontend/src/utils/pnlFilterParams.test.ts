import { describe, it, expect } from 'vitest'
import { buildPnLFilterParams, hasActivePnLFilters } from './pnlFilterParams'
import { defaultFilterState } from '../components/TransactionFilters'

// Critical: these functions build the query params sent to the P&L endpoints —
// a bug here silently returns the wrong slice of data (or all data) to the
// P&L/tax views without any visible error.
describe('buildPnLFilterParams', () => {
    it('returns an empty object when no filters are active', () => {
        expect(buildPnLFilterParams(defaultFilterState)).toEqual({})
    })

    it('joins multi-select dimensions with commas', () => {
        const filters = { ...defaultFilterState, accountIds: ['1', '2'], assetIds: ['10'] }
        expect(buildPnLFilterParams(filters)).toEqual({ account_id: '1,2', asset_id: '10' })
    })

    it('includes non_owned only when true, via filter state or override', () => {
        expect(buildPnLFilterParams(defaultFilterState)).toEqual({})
        expect(buildPnLFilterParams(defaultFilterState, true)).toEqual({ non_owned: 'true' })
        expect(buildPnLFilterParams({ ...defaultFilterState, nonOwned: true })).toEqual({ non_owned: 'true' })
    })

    it('serializes includeFee/hasBundle booleans as strings', () => {
        const filters = { ...defaultFilterState, includeFee: false, hasBundle: true }
        expect(buildPnLFilterParams(filters)).toEqual({ include_fee: 'false', has_bundle: 'true' })
    })

    it('includes date range filters verbatim', () => {
        const filters = { ...defaultFilterState, dateFrom: '2024-01-01', dateTo: '2024-12-31' }
        expect(buildPnLFilterParams(filters)).toEqual({ date_from: '2024-01-01', date_to: '2024-12-31' })
    })
})

describe('hasActivePnLFilters', () => {
    it('is false for the default filter state', () => {
        expect(hasActivePnLFilters(defaultFilterState)).toBe(false)
    })

    it('is true when any dimension is set', () => {
        expect(hasActivePnLFilters({ ...defaultFilterState, categoryIds: ['5'] })).toBe(true)
        expect(hasActivePnLFilters({ ...defaultFilterState, dateFrom: '2024-01-01' })).toBe(true)
    })

    it('respects the nonOwned override parameter', () => {
        expect(hasActivePnLFilters(defaultFilterState, true)).toBe(true)
    })
})
