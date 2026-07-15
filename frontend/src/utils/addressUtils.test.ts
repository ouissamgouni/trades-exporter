import { describe, it, expect } from 'vitest'
import { formatAddress, formatChainName } from './addressUtils'

// Major (not critical-path) coverage for the wallet-address/chain-name
// display helpers used across onchain connector views.
describe('formatAddress', () => {
    it('returns an empty string for null/undefined/empty input', () => {
        expect(formatAddress(null)).toBe('')
        expect(formatAddress(undefined)).toBe('')
        expect(formatAddress('')).toBe('')
    })

    it('returns short addresses unchanged', () => {
        expect(formatAddress('0x1234')).toBe('0x1234')
    })

    it('truncates long addresses with an ellipsis', () => {
        expect(formatAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234...5678')
    })

    it('respects custom prefix/suffix lengths', () => {
        expect(formatAddress('0x1234567890abcdef1234567890abcdef12345678', 4, 2)).toBe('0x12...78')
    })
})

describe('formatChainName', () => {
    it('returns an empty string for null/undefined', () => {
        expect(formatChainName(null)).toBe('')
        expect(formatChainName(undefined)).toBe('')
    })

    it('capitalizes the first letter and lowercases the rest', () => {
        expect(formatChainName('ethereum')).toBe('Ethereum')
        expect(formatChainName('BASE')).toBe('Base')
    })
})
