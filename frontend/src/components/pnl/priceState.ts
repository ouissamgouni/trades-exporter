import type { PriceResponse, PriceState } from '../../types';

export const PRICE_STATE_LABELS: Record<PriceState, string> = {
    live: 'Live',
    cached: 'Cached',
    fallback: 'Fallback',
    stale: 'Stale',
    failed_with_last_known: 'Failed · last known',
    failed: 'Failed',
    missing: 'No price',
    skipped: 'Not priced',
};

/** Older backends may not send price_state, so derive it from the legacy fields. */
export function resolvePriceState(p: PriceResponse): PriceState {
    if (p.price_state) return p.price_state;
    if (p.skipped) return 'skipped';
    if (p.price != null) return p.is_stale ? 'stale' : p.is_fallback ? 'fallback' : 'live';
    return p.last_known_price != null ? 'failed_with_last_known' : 'failed';
}

/** Unit price used for valuation: live price, else last known. */
export function effectivePrice(p: PriceResponse): number | null {
    return p.price ?? p.last_known_price ?? null;
}

/** Provider name only: the "fallback:" prefix duplicates the state badge. */
export function effectiveSource(p: PriceResponse): string | null {
    const raw = p.price != null ? p.source ?? null : p.last_known_source ?? p.source ?? null;
    return raw?.replace(/^fallback:/, '') ?? null;
}

export function effectiveDate(p: PriceResponse): string | null {
    return p.price != null ? p.fetched_at ?? null : p.last_known_price_date ?? null;
}
