import type { SyncWindow } from '../types';

const SOURCE_LABELS: Record<SyncWindow['source'], string> = {
    override: 'manual override',
    last_transaction: 'last stored transaction',
    config_start: 'configured start date',
    history_cutoff: 'history cutoff',
    connector_default: 'connector default',
    full_history: 'full history',
};

const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Short label of where the next fetch starts, e.g. "from 20 Nov 25, 01:35 (last stored transaction)". */
export function describeSyncWindow(window: SyncWindow): string {
    let text: string;
    if (window.since) {
        text = `from ${fmt(window.since)} (${SOURCE_LABELS[window.source]})`;
    } else if (window.source === 'connector_default' && window.default_start) {
        text = `from ${fmt(window.default_start)} (${SOURCE_LABELS.connector_default})`;
    } else if (window.incremental) {
        text = 'full history (no stored transaction or start date)';
    } else {
        text = 'full history every run (stored rows skipped)';
    }
    if (window.history_cutoff && window.source !== 'history_cutoff') {
        text += ` · ignores rows ≤ ${fmt(window.history_cutoff)} (history cutoff)`;
    }
    return text;
}
