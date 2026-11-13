/**
 * AssetPnLAuditSection — Standalone PnL audit for a single asset.
 *
 * Wraps InvestigationView with pre-applied asset filter.
 * Fetches the latest PnL version independently (no PnL context needed).
 */
import React from 'react';
import { Badge, Spinner } from './ui/primitives';
import { FiClock } from 'react-icons/fi';

import { useLatestPnLVersion } from '../hooks/useLatestPnLVersion';
import { InvestigationView } from './pnl/InvestigationView';

interface AssetPnLAuditSectionProps {
    assetId?: number;
    /** Scopes the audit to an account instead of an asset */
    accountId?: number;
    assetSymbol?: string;
    assetLabel?: string;
    /** Explicit PnL version ID (skips latest-version fetch when provided) */
    versionId?: number;
}

export const AssetPnLAuditSection: React.FC<AssetPnLAuditSectionProps> = ({
    assetId,
    accountId,
    assetSymbol,
    assetLabel,
    versionId: explicitVersionId,
}) => {
    const { version, versionId: latestVersionId, baseCurrency, isLoading: versionLoading } = useLatestPnLVersion();
    const versionId = explicitVersionId ?? latestVersionId;

    if (versionLoading) {
        return (
            <div className="flex justify-center py-6">
                <Spinner size="sm" />
                <span className="ml-2 text-xs text-slate-500">Loading PnL data…</span>
            </div>
        );
    }

    if (!versionId) {
        return (
            <span className="block py-3 text-center text-xs text-slate-400">
                No PnL calculation available.
            </span>
        );
    }

    const createdAt = version?.created_at
        ? new Date(version.created_at).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        })
        : 'Unknown';

    return (
        <>
            {/* Version info banner */}
            <div className="mb-2 flex items-center gap-1.5 bg-slate-50 px-2 py-1 text-[10px] text-slate-500">
                <FiClock size={10} />
                <span>
                    Version #{version?.version_id} · {createdAt}
                </span>
                <Badge colorScheme="gray" className="ml-1">
                    {version?.lot_method}
                </Badge>
            </div>

            <InvestigationView
                versionId={versionId}
                baseCurrency={baseCurrency}
                initialFilters={assetId != null ? { relatedAssetIds: [String(assetId)] } : { relatedAccountIds: [String(accountId)] }}
                assets={assetSymbol && assetId != null ? [{ id: assetId, symbol: assetSymbol, label: assetLabel }] : undefined}
            />
        </>
    );
};
