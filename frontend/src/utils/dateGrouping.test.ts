import { describe, it, expect } from 'vitest'
import {
    formatDayLabel,
    formatMonthLabel,
    formatTxDateTime,
    getNamedDateRange,
    localFilterToUtcNaive,
} from './dateUtils'

const NOW = new Date(2026, 10, 6, 12, 0) // 6 Nov 2026, local time

describe('grouped table date labels (major)', () => {
    it('formats rows with time only under a day header', () => {
        const local = new Date(2026, 10, 5, 14, 32)
        expect(formatTxDateTime(local, 'time', NOW)).toBe('14:32')
    })

    it('omits the year only for the current year', () => {
        expect(formatTxDateTime(new Date(2026, 10, 5, 9, 5), 'full', NOW)).toBe('5 Nov 09:05')
        expect(formatTxDateTime(new Date(2024, 2, 1, 9, 5), 'full', NOW)).toBe('1 Mar 2024 09:05')
    })

    it('labels months and days relative to now', () => {
        expect(formatMonthLabel('2026-11-01', NOW)).toBe('November')
        expect(formatMonthLabel('2024-11-01', NOW)).toBe('Nov 2024')
        expect(formatDayLabel('2026-11-06', NOW)).toBe('Today')
        expect(formatDayLabel('2026-11-05', NOW)).toBe('Yesterday')
        expect(formatDayLabel('2026-11-04', NOW)).toBe('Wed 4')
    })
})

describe('date filter conversion (critical)', () => {
    it('converts local date-only bounds to naive UTC covering the whole local day', () => {
        const from = localFilterToUtcNaive('2026-11-05', 'start')
        const to = localFilterToUtcNaive('2026-11-05', 'end')
        expect(new Date(`${from}Z`).getTime()).toBe(new Date(2026, 10, 5, 0, 0, 0).getTime())
        expect(new Date(`${to}Z`).getTime()).toBe(new Date(2026, 10, 5, 23, 59, 59, 999).getTime())
    })

    it('passes through values that already carry a zone', () => {
        expect(localFilterToUtcNaive('2026-11-05T10:00:00Z', 'start')).toBe('2026-11-05T10:00:00Z')
    })

    it('uses the calendar year for the last tax year preset', () => {
        expect(getNamedDateRange('last_tax_year', NOW)).toEqual({ from: '2025-01-01', to: '2025-12-31' })
        expect(getNamedDateRange('this_month', NOW)).toEqual({ from: '2026-11-01', to: '2026-11-06' })
    })
})
