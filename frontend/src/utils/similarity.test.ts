import { describe, it, expect } from 'vitest'
import { calculateSimilarity, getAccountSuggestions, getAssetSuggestions } from './similarity'

// Critical: this fuzzy matcher drives the account/asset "did you mean...?"
// suggestion flow used when mapping raw connector data to real accounts/assets
// during Setup — wrong matches misattribute transactions.
describe('calculateSimilarity', () => {
    it('scores an exact match (case/whitespace-insensitive) as 1', () => {
        expect(calculateSimilarity('BTC', 'btc')).toBe(1)
        expect(calculateSimilarity(' BTC ', 'btc')).toBe(1)
    })

    it('scores a substring match as 0.8', () => {
        expect(calculateSimilarity('BTCUSDT', 'BTC')).toBe(0.8)
    })

    it('falls back to Levenshtein-based similarity for unrelated strings', () => {
        // distance('kitten', 'sitting') = 3, maxLen = 7 -> 1 - 3/7
        expect(calculateSimilarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7, 5)
    })

    it('returns 0 similarity for completely different strings of equal length', () => {
        expect(calculateSimilarity('abc', 'xyz')).toBe(0)
    })
})

describe('getAccountSuggestions', () => {
    const accounts = [
        { name: 'Binance Main', address_or_identifier: null },
        { name: 'Coinbase', address_or_identifier: '0xabc123' },
    ]

    it('returns an empty array for an empty source label', () => {
        expect(getAccountSuggestions('', accounts)).toEqual([])
    })

    it('matches by name and sorts by descending confidence', () => {
        const results = getAccountSuggestions('Binance', accounts, 0.5, 3)
        expect(results[0].item.name).toBe('Binance Main')
        expect(results[0].confidence).toBeGreaterThanOrEqual(0.5)
    })

    it('also matches against the address_or_identifier field', () => {
        const results = getAccountSuggestions('0xabc123', accounts, 0.5, 3)
        expect(results.some((r) => r.item.name === 'Coinbase')).toBe(true)
    })

    it('excludes matches below the minimum confidence threshold', () => {
        expect(getAccountSuggestions('zzz-unrelated-zzz', accounts, 0.9, 3)).toEqual([])
    })

    it('caps results at maxSuggestions', () => {
        const many = Array.from({ length: 5 }, (_, i) => ({ name: `Binance ${i}`, address_or_identifier: null }))
        expect(getAccountSuggestions('Binance', many, 0.1, 2)).toHaveLength(2)
    })
})

describe('getAssetSuggestions', () => {
    const assets = [
        { symbol: 'BTC', label: 'Bitcoin' },
        { symbol: 'ETH', label: 'Ethereum' },
    ]

    it('returns an empty array for an empty source symbol', () => {
        expect(getAssetSuggestions('', assets)).toEqual([])
    })

    it('matches by symbol or label and sorts by descending confidence', () => {
        const results = getAssetSuggestions('Bitcoin', assets, 0.5, 3)
        expect(results[0].item.symbol).toBe('BTC')
    })
})
