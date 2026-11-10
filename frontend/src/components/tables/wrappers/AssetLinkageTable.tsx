/**
 * AssetLinkageTable
 * 
 * Displays transactions with asset linkage issues using TransactionsTable.
 * Fetches issue metadata first, then renders full transactions with
 * additional "Issue" and "Fix" columns via the plugin architecture.
 * 
 * Issue types handled:
 * - unlinked_asset: Main transaction asset not linked
 * - unlinked_price_quote: Price quote asset not linked
 * - unlinked_fee_quote: Fee quote asset not linked
 */

import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Spinner, type BadgeColorScheme } from '../../ui/primitives';
import { TransactionsTable } from '../../TransactionsTable';
import { defaultFilterState } from '../../TransactionFilters';
import { ColumnPlugin, TableConfig } from '../types';
import { presetToVisibility } from '../useTransactionsTable';
import { API_URL, Asset, Transaction, TransactionIssue } from '../../../types';
import { Tooltip } from '../../ui/tooltip';
import { useShowInContextRowAction } from '../rowActions';

// ============================================================================
// Types
// ============================================================================

interface AssetLinkageTableProps {
    /** Available assets for the selector */
    assets: Asset[];
    /** Callback when an issue is fixed */
    onFixed?: () => void;
    /** Callback when assets list should be refreshed */
    onAssetsUpdated?: () => void;
}

interface LinkageIssuesResponse {
    issues: TransactionIssue[];
    pagination: {
        total_count: number;
        page: number;
        per_page: number;
        total_pages: number;
    };
}

// Issue type configuration
const ISSUE_CONFIG: Record<string, { color: BadgeColorScheme; label: string }> = {
    unlinked_asset: { color: 'red', label: 'Asset' },
    unlinked_price_quote: { color: 'purple', label: 'Price' },
    unlinked_fee_quote: { color: 'yellow', label: 'Fee' },
    unlinked_attributed_asset: { color: 'orange', label: 'Attributed' },
};

// ============================================================================
// Component
// ============================================================================

export const AssetLinkageTable: React.FC<AssetLinkageTableProps> = ({
    assets,
    onFixed,
    onAssetsUpdated,
}) => {

    // Step 1: Fetch all linkage issues to get transaction IDs and issue metadata
    // Backend limit is 200 per_page, so we fetch in batches if needed
    const { data: issuesData, isLoading: issuesLoading } = useQuery({
        queryKey: ['assetLinkageIssues'],
        queryFn: async () => {
            const allIssues: TransactionIssue[] = [];
            let page = 1;
            let totalPages = 1;

            // Fetch all pages
            while (page <= totalPages) {
                const params = new URLSearchParams({
                    page: String(page),
                    per_page: '200', // Backend max is 200
                    issue_types: 'unlinked_asset,unlinked_price_quote,unlinked_fee_quote,unlinked_attributed_asset',
                });
                const response = await fetch(`${API_URL}/transactions/data-health-check/linkage-issues?${params}`);
                if (!response.ok) throw new Error('Failed to fetch issues');

                const data = await response.json() as LinkageIssuesResponse;
                allIssues.push(...data.issues);
                totalPages = data.pagination.total_pages;
                page++;
            }

            return {
                issues: allIssues,
                pagination: { total_count: allIssues.length, page: 1, per_page: allIssues.length, total_pages: 1 }
            } as LinkageIssuesResponse;
        },
    });

    const showInContextAction = useShowInContextRowAction();
    const rowActions = useMemo(() => [showInContextAction], [showInContextAction]);

    const issues = issuesData?.issues ?? [];
    const totalCount = issuesData?.pagination.total_count ?? 0;

    // Build lookup map: transaction_id -> issues for that transaction
    const issuesByTxId = useMemo(() => {
        const map = new Map<number, TransactionIssue[]>();
        for (const issue of issues) {
            const existing = map.get(issue.transaction_id) || [];
            existing.push(issue);
            map.set(issue.transaction_id, existing);
        }
        return map;
    }, [issues]);

    // Get unique transaction IDs
    const transactionIds = useMemo(() =>
        Array.from(new Set(issues.map(i => i.transaction_id))),
        [issues]
    );

    // Define read-only column showing which asset field has the issue
    const additionalColumns: ColumnPlugin<Transaction>[] = useMemo(() => [
        {
            id: 'asset-issue',
            header: 'Asset Issue',
            width: '140px',
            render: (tx: Transaction) => {
                const txIssues = issuesByTxId.get(tx.id) || [];
                if (txIssues.length === 0) return null;

                return (
                    <div className="flex flex-col gap-0.5">
                        {txIssues.map((issue, idx) => {
                            const config = ISSUE_CONFIG[issue.issue_type] || { color: 'gray' as BadgeColorScheme, label: issue.issue_type };
                            return (
                                <div key={idx} className="flex items-center gap-1">
                                    <Badge colorScheme={config.color} className="text-[7px]">
                                        {config.label}
                                    </Badge>
                                    <Tooltip content={issue.raw_value} openDelay={100}>
                                        <span className="max-w-[60px] truncate text-[7px] text-orange-600">
                                            {issue.raw_value}
                                        </span>
                                    </Tooltip>
                                </div>
                            );
                        })}
                    </div>
                );
            },
        },
    ], [issuesByTxId]);

    // Table configuration
    const tableConfig: TableConfig<Transaction> = useMemo(() => ({
        columnPreset: 'compact',
        hiddenColumns: ['bundle', 'taxability', 'feeInBase'],
        features: {
            filters: false,
            selection: false,
            inlineEdit: true,
        },
    }), []);

    // Initial column visibility for this table
    const initialColumnVisibility = useMemo(() =>
        presetToVisibility('compact', ['bundle', 'taxability', 'feeInBase']),
        []
    );

    // Loading state
    if (issuesLoading) {
        return (
            <div className="bg-slate-50 py-10 text-center">
                <Spinner size="lg" className="text-blue-500" />
                <span className="mt-4 block">Loading linkage issues...</span>
            </div>
        );
    }

    // No issues
    if (totalCount === 0 || transactionIds.length === 0) {
        return (
            <div className="bg-green-50 p-6 text-center">
                <span className="font-medium text-green-600">✓ No asset linkage issues found!</span>
            </div>
        );
    }

    // Render TransactionsTable with filtered transactions
    return (
        <TransactionsTable
            defaultExpandAllDays
            title="Asset Linkage Issues"
            subtitle={`${totalCount} transaction${totalCount !== 1 ? 's' : ''} with unlinked assets`}
            tableId="assetLinkage"
            initialColumnVisibility={initialColumnVisibility}
            filters={{
                ...defaultFilterState,
                transactionIds,
                reviewStatus: [], // Show all statuses
            }}
            showFilters={false}
            showBundles={false}
            showSuggestions={false}
            additionalColumns={additionalColumns}
            additionalRowActions={rowActions}
            config={tableConfig}
        />
    );
};

export default AssetLinkageTable;
