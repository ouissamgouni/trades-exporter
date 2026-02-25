/**
 * Shared issue type configuration for Data Health Check components.
 * Used by MissingDataTable, DataHealthCheckDrawer headers, etc.
 */

import { IssueType } from '../types';

export const ISSUE_CONFIG: Record<IssueType, { color: string; label: string }> = {
    missing_source: { color: 'gray', label: 'Missing Source' },
    missing_source_asset: { color: 'red', label: 'Missing Source Asset' },
    missing_source_account: { color: 'orange', label: 'Missing Source Account' },
    unlinked_asset: { color: 'red', label: 'Unlinked Base Asset' },
    unlinked_account: { color: 'orange', label: 'Unlinked Account' },
    unlinked_price_quote: { color: 'purple', label: 'Unlinked Price Asset' },
    unlinked_fee_quote: { color: 'yellow', label: 'Unlinked Fee Asset' },
    missing_transfer_from_account: { color: 'blue', label: 'Missing From Account' },
    missing_transfer_to_account: { color: 'blue', label: 'Missing To Account' },
    unlinked_transfer_from_account: { color: 'cyan', label: 'Unlinked From Account' },
    unlinked_transfer_to_account: { color: 'cyan', label: 'Unlinked To Account' },
};
