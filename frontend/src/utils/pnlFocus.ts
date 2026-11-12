/** Deep link into the P&L portfolio view scoped to one asset or account (consumed by PnLProvider). */
export type PnLFocus =
    | { kind: 'asset'; id: number; symbol: string; label?: string | null }
    | { kind: 'account'; id: number; name: string };

export function pnlFocusPath(focus: PnLFocus): string {
    const params = new URLSearchParams();
    if (focus.kind === 'asset') {
        params.set('focus_asset', String(focus.id));
        params.set('focus_symbol', focus.symbol);
        if (focus.label) params.set('focus_label', focus.label);
    } else {
        params.set('focus_account', String(focus.id));
        params.set('focus_name', focus.name);
    }
    return `/pnl/portfolio?${params.toString()}`;
}

const FOCUS_KEYS = ['focus_asset', 'focus_symbol', 'focus_label', 'focus_account', 'focus_name'];

/** Parses the focus params; `rest` is the query string without them. */
export function parsePnLFocus(search: string): { focus: PnLFocus | null; rest: string } {
    const params = new URLSearchParams(search);
    let focus: PnLFocus | null = null;
    const assetId = Number(params.get('focus_asset'));
    const accountId = Number(params.get('focus_account'));
    if (assetId) {
        focus = { kind: 'asset', id: assetId, symbol: params.get('focus_symbol') || `#${assetId}`, label: params.get('focus_label') };
    } else if (accountId) {
        focus = { kind: 'account', id: accountId, name: params.get('focus_name') || `#${accountId}` };
    }
    FOCUS_KEYS.forEach(k => params.delete(k));
    return { focus, rest: params.toString() };
}
