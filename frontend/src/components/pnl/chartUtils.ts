/**
 * Shared chart constants and utilities.
 *
 * Centralises ZoomPreset type, preset definitions, and axis-formatting
 * helpers that were previously duplicated across chart components.
 */

import type { Range } from './TotalReturnScorecard';

// ---------------------------------------------------------------------------
// Zoom presets (superset — covers all Range values)
// ---------------------------------------------------------------------------

export type ZoomPreset = 'all' | '3y' | '1y' | '6m' | '3m' | '1m' | '1w';

export const ZOOM_PRESETS: Record<ZoomPreset, { label: string; days: number | null }> = {
    all: { label: 'All', days: null },
    '3y': { label: '3Y', days: 1095 },
    '1y': { label: '1Y', days: 365 },
    '6m': { label: '6M', days: 180 },
    '3m': { label: '3M', days: 90 },
    '1m': { label: '1M', days: 30 },
    '1w': { label: '1W', days: 7 },
};

/** Map a Range (from the period selector) to the equivalent ZoomPreset. */
export function rangeToZoom(range: Range): ZoomPreset {
    return range as ZoomPreset; // Range and ZoomPreset share the same literal values
}

// ---------------------------------------------------------------------------
// Axis formatting helpers
// ---------------------------------------------------------------------------

export function formatCompact(val: number): string {
    const abs = Math.abs(val);
    if (abs >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
    return val.toFixed(0);
}

export function getAxisDateFormat(totalDays: number): string {
    if (totalDays < 7) return '%m/%d';
    if (totalDays < 90) return '%b %d';
    if (totalDays < 365) return '%b %y';
    return '%Y';
}

export function getTickValues(totalDays: number): string {
    if (totalDays > 730) return 'every 6 months';
    if (totalDays > 365) return 'every 3 months';
    if (totalDays > 180) return 'every 2 months';
    return 'every 1 month';
}

// ---------------------------------------------------------------------------
// Shared zoom-filter helper
// ---------------------------------------------------------------------------

export interface HasDate {
    date: string;
}

/** Filter points by a ZoomPreset, anchored to the last data point's date.
 *  This ensures correct filtering even when data doesn't extend to today. */
export function filterPointsByZoom<T extends HasDate>(points: T[], zoom: ZoomPreset): T[] {
    const preset = ZOOM_PRESETS[zoom];
    if (!preset.days || !points.length) return points;
    const lastDate = new Date(points[points.length - 1].date + 'T00:00:00');
    const cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - preset.days);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    return points.filter(p => p.date >= cutoffStr);
}
