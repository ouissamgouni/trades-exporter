import { describe, expect, it } from 'vitest';
import { parsePnLFocus, pnlFocusPath } from './pnlFocus';

describe('pnlFocus (major)', () => {
    it('round-trips an asset focus and keeps other params', () => {
        const path = pnlFocusPath({ kind: 'asset', id: 5, symbol: 'BTC', label: 'Bitcoin' });
        expect(path.startsWith('/pnl/portfolio?')).toBe(true);
        const { focus, rest } = parsePnLFocus(`${path.split('?')[1]}&accounts=1,2`);
        expect(focus).toEqual({ kind: 'asset', id: 5, symbol: 'BTC', label: 'Bitcoin' });
        expect(rest).toBe('accounts=1%2C2');
    });

    it('round-trips an account focus', () => {
        const { focus, rest } = parsePnLFocus(pnlFocusPath({ kind: 'account', id: 9, name: 'Main wallet' }).split('?')[1]);
        expect(focus).toEqual({ kind: 'account', id: 9, name: 'Main wallet' });
        expect(rest).toBe('');
    });

    it('returns null without focus params', () => {
        expect(parsePnLFocus('?tab=audit')).toEqual({ focus: null, rest: 'tab=audit' });
    });
});
