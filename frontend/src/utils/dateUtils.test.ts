import { describe, it, expect } from 'vitest'
import { parseApiDate } from './dateUtils'

// `parseApiDate` is the single entry point every date coming back from the
// API passes through (ISO strings, unix timestamps, or Date objects) — a
// parsing regression breaks every date displayed in the app, so this is a
// critical-path test.
describe('parseApiDate', () => {
    it('returns null for null/undefined', () => {
        expect(parseApiDate(null)).toBeNull()
        expect(parseApiDate(undefined)).toBeNull()
    })

    it('parses an ISO string without a timezone marker as UTC', () => {
        const date = parseApiDate('2024-01-15T10:30:00')
        expect(date).not.toBeNull()
        expect(date!.toISOString()).toBe('2024-01-15T10:30:00.000Z')
    })

    it('parses an ISO string that already has a timezone marker', () => {
        const date = parseApiDate('2024-01-15T10:30:00+00:00')
        expect(date).not.toBeNull()
        expect(date!.toISOString()).toBe('2024-01-15T10:30:00.000Z')
    })

    it('parses a unix timestamp in seconds', () => {
        const date = parseApiDate(1705316445)
        expect(date).not.toBeNull()
        expect(date!.getTime()).toBe(1705316445 * 1000)
    })

    it('parses a unix timestamp already in milliseconds', () => {
        const millis = 1705316445123
        const date = parseApiDate(millis)
        expect(date).not.toBeNull()
        expect(date!.getTime()).toBe(millis)
    })

    it('passes through a valid Date instance', () => {
        const input = new Date('2024-01-15T10:30:00.000Z')
        expect(parseApiDate(input)).toBe(input)
    })

    it('returns null for an invalid date string', () => {
        expect(parseApiDate('not-a-date')).toBeNull()
    })
})
