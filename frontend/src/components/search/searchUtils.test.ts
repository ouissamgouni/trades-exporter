import { describe, expect, it } from 'vitest';
import { matchScore, parseQuery, rankItems } from './searchUtils';

describe('parseQuery (major)', () => {
    it('detects a transaction id with or without #', () => {
        expect(parseQuery('#123')).toEqual({ scope: 'all', text: '#123', txId: 123 });
        expect(parseQuery(' 42 ').txId).toBe(42);
    });

    it('handles scope prefixes', () => {
        expect(parseQuery('a: btc')).toEqual({ scope: 'assets', text: 'btc', txId: null });
        expect(parseQuery('ACC:binance')).toEqual({ scope: 'accounts', text: 'binance', txId: null });
        expect(parseQuery('tx:#7').txId).toBe(7);
    });

    it('does not treat digits as a tx id in asset/account scope', () => {
        expect(parseQuery('a:1inch').txId).toBeNull();
        expect(parseQuery('acc:123').txId).toBeNull();
    });
});

describe('matchScore / rankItems (major)', () => {
    it('orders exact, starts-with, word-start, contains', () => {
        const exact = matchScore('eth', ['ETH'])!;
        const prefix = matchScore('eth', ['ETHFI'])!;
        const word = matchScore('eth', ['Wrapped ETH'])!;
        const contains = matchScore('eth', ['STETHX'])!;
        expect(exact).toBeLessThan(prefix);
        expect(prefix).toBeLessThan(word);
        expect(word).toBeLessThan(contains);
        expect(matchScore('xyz', ['ETH'])).toBeNull();
    });

    it('prefers earlier fields at the same tier', () => {
        expect(matchScore('ab', ['ab', null])!).toBeLessThan(matchScore('ab', [null, 'ab'])!);
    });

    it('ranks items and applies the limit', () => {
        const items = [
            { symbol: 'STETH', label: 'Lido Staked Ether' },
            { symbol: 'ETH', label: 'Ethereum' },
            { symbol: 'ETHFI', label: 'ether.fi' },
            { symbol: 'BTC', label: 'Bitcoin' },
        ];
        const ranked = rankItems(items, 'eth', i => [i.symbol, i.label], 3).map(i => i.symbol);
        expect(ranked).toEqual(['ETH', 'ETHFI', 'STETH']);
    });
});
