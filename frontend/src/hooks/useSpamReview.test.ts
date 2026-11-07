import { describe, expect, it } from 'vitest';
import { getSpamLevel } from './useSpamReview';

describe('getSpamLevel', () => {
    it('distinguishes suspected from confirmed spam tags', () => {
        expect(getSpamLevel({ tags: [{ spam: true, spam_level: 'suspected' }] })).toBe('suspected');
        expect(getSpamLevel({ tags: [{ foo: 'bar' }, { spam: true, spam_reasons: ['is_scam'] }] })).toBe('confirmed');
    });

    it('returns null without a spam tag, including legacy dict tags', () => {
        expect(getSpamLevel({ tags: [{ staking: true }] })).toBeNull();
        expect(getSpamLevel({ tags: { contract_address: '0x1' } })).toBeNull();
        expect(getSpamLevel({})).toBeNull();
    });
});
