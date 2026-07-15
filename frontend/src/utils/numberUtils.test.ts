import { describe, it, expect } from 'vitest'
import { formatQuantity } from './numberUtils'

// `formatQuantity` drives every number displayed across the P&L / positions /
// transactions views — a regression here silently corrupts money and
// quantity displays app-wide, so this is a critical-path test.
describe('formatQuantity', () => {
    it('formats null/undefined/zero as "0"', () => {
        expect(formatQuantity(null)).toBe('0')
        expect(formatQuantity(undefined)).toBe('0')
        expect(formatQuantity(0)).toBe('0')
    })

    it('uses exponential notation for very small values', () => {
        expect(formatQuantity(0.000000123)).toBe('1.23e-7')
    })

    it('formats small decimals (< 1) with trailing zeros trimmed', () => {
        expect(formatQuantity(0.5)).toBe('0.5')
    })

    it('formats medium values (1-999) with trailing zeros trimmed', () => {
        expect(formatQuantity(42)).toBe('42')
        expect(formatQuantity(42.5)).toBe('42.5')
    })

    it('applies K/M/B suffixes for large values', () => {
        expect(formatQuantity(1234.5678)).toBe('1.23K')
        expect(formatQuantity(1500000)).toBe('1.50M')
        expect(formatQuantity(2_000_000_000)).toBe('2.00B')
    })

    it('respects negative values', () => {
        expect(formatQuantity(-1234.5678)).toBe('-1.23K')
    })
})
