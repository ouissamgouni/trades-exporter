/**
 * Shared delta (Δ) computation and formatting utilities.
 *
 * Used by DeltaBar, AssetPnLTable, and AssetDetailView to avoid
 * duplicating balance-comparison logic across files.
 */

/** Percentage delta below which balances are considered matching (0.01%) */
export const MATCH_TOLERANCE = 0.0001;

/** Threshold above which the gap is treated as a total mismatch (99.99%) */
export const TOTAL_GAP_TOLERANCE = 0.9999;

export interface DeltaInfo {
    delta: number;
    pct: number;
    matched: boolean;
    /** True when pnl or live is effectively 0 and the other is not → complete gap */
    totalGap: boolean;
}

/** Compute delta between live and P&L quantities */
export const computeDelta = (
    pnlQty: number,
    liveQty: number | undefined,
): DeltaInfo | null => {
    if (liveQty == null) return null;
    const delta = liveQty - pnlQty;
    const maxQty = Math.max(Math.abs(liveQty), Math.abs(pnlQty));
    const pct = maxQty > 0 ? delta / maxQty : 0;
    const absPct = Math.abs(pct);
    const matched = absPct < MATCH_TOLERANCE;
    const totalGap = absPct >= TOTAL_GAP_TOLERANCE;
    return { delta, pct, matched, totalGap };
};

/** Tailwind text color class for a given delta percentage */
export const deltaColor = (pct: number): string => {
    const absPct = Math.abs(pct);
    if (absPct < MATCH_TOLERANCE) return 'text-green-600';
    if (absPct < 0.01) return 'text-orange-500';
    return 'text-red-600';
};

/** Format a ratio as a signed percentage string, e.g. "+12.34%" */
export const formatPct = (value: number): string => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${(value * 100).toFixed(2)}%`;
};
