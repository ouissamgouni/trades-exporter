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

import React, { useMemo, useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, Badge, Spinner, Text, Flex, HStack } from '@chakra-ui/react';
import { FiCheck } from 'react-icons/fi';
import { TransactionsTable } from '../../TransactionsTable';
import { defaultFilterState } from '../../TransactionFilters';
import { ColumnPlugin, TableConfig } from '../types';
import { presetToVisibility } from '../useTransactionsTable';
import { API_URL, Asset, Transaction, TransactionIssue } from '../../../types';
import { AssetSelector } from '../../AssetSelector';
import { toaster } from '../../ui/toaster';
import { Tooltip } from '../../ui/tooltip';
import { getAssetSuggestions, getConfidenceColor, formatConfidence } from '../../../utils/similarity';

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
const ISSUE_CONFIG: Record<string, { color: string; label: string }> = {
    unlinked_asset: { color: 'red', label: 'Asset' },
    unlinked_price_quote: { color: 'purple', label: 'Price' },
    unlinked_fee_quote: { color: 'yellow', label: 'Fee' },
};

// ============================================================================
// Component
// ============================================================================

export const AssetLinkageTable: React.FC<AssetLinkageTableProps> = ({
    assets,
    onFixed,
    onAssetsUpdated,
}) => {
    const queryClient = useQueryClient();
    const [fixedIds, setFixedIds] = useState<Set<string>>(new Set());
    const [fixingIds, setFixingIds] = useState<Set<string>>(new Set());

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
                    issue_types: 'unlinked_asset,unlinked_price_quote,unlinked_fee_quote',
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

    // Handle asset mapping
    const handleMapAsset = useCallback(async (issue: TransactionIssue, assetId: number) => {
        const key = `${issue.transaction_id}-${issue.issue_type}`;
        setFixingIds(prev => new Set(prev).add(key));

        try {
            const response = await fetch(
                `${API_URL}/raw-assets/${encodeURIComponent(issue.source)}/${encodeURIComponent(issue.raw_value)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asset_id: assetId }),
                }
            );

            if (response.status === 404) {
                await fetch(`${API_URL}/raw-assets`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symbol: issue.raw_value,
                        source: issue.source,
                        asset_id: assetId,
                    }),
                });
            } else if (!response.ok) {
                throw new Error('Failed to map asset');
            }

            setFixedIds(prev => new Set(prev).add(key));
            toaster.success({ title: 'Asset mapped', description: `${issue.raw_value} linked` });
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            queryClient.invalidateQueries({ queryKey: ['assetLinkageIssues'] });
            queryClient.invalidateQueries({ queryKey: ['dataHealthStatus'] });
            onFixed?.();
            onAssetsUpdated?.();
        } catch {
            toaster.error({ title: 'Error', description: 'Failed to map asset' });
        } finally {
            setFixingIds(prev => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        }
    }, [queryClient, onFixed, onAssetsUpdated]);

    // Define additional columns for issue display
    const additionalColumns: ColumnPlugin<Transaction>[] = useMemo(() => [
        {
            id: 'fix-action',
            header: 'Link Asset',
            width: '220px',
            render: (tx: Transaction) => {
                const txIssues = issuesByTxId.get(tx.id) || [];
                if (txIssues.length === 0) return null;
                
                return (
                    <Flex direction="column" gap={1}>
                        {txIssues.map((issue, idx) => {
                            const key = `${issue.transaction_id}-${issue.issue_type}`;
                            const isFixed = fixedIds.has(key);
                            const isFixing = fixingIds.has(key);
                            const config = ISSUE_CONFIG[issue.issue_type] || { color: 'gray', label: issue.issue_type };

                            if (isFixed) {
                                return (
                                    <Badge key={idx} colorPalette="green" size="xs" fontSize="7px">
                                        <FiCheck size={10} /> {config.label} Linked
                                    </Badge>
                                );
                            }

                            if (isFixing) {
                                return <Spinner key={idx} size="xs" />;
                            }

                            // Get asset suggestions for this issue's raw_value
                            const suggestions = getAssetSuggestions(issue.raw_value, assets, 0.5, 3);

                            return (
                                <Flex key={idx} direction="column" gap={0.5} onClick={e => e.stopPropagation()}>
                                    <Flex align="center" gap={1}>
                                        <Badge size="xs" colorPalette={config.color} fontSize="6px" flexShrink={0} w="35px" textAlign="center">
                                            {config.label}
                                        </Badge>
                                        <Tooltip content={issue.raw_value} openDelay={100}>
                                            <Text fontSize="7px" color="orange.600" flexShrink={0} w="40px" truncate>
                                                {issue.raw_value}
                                            </Text>
                                        </Tooltip>
                                        <Box w="100px" flexShrink={0}>
                                            <AssetSelector
                                                assets={assets}
                                                value={null}
                                                onChange={(assetId) => assetId && handleMapAsset(issue, assetId)}
                                                onAssetCreated={onAssetsUpdated}
                                                size="sm"
                                                placeholder="Select..."
                                            />
                                        </Box>
                                    </Flex>
                                    {/* Show suggestions as clickable badges */}
                                    {suggestions.length > 0 && (
                                        <HStack gap={1} flexWrap="wrap" ml="75px">
                                            {suggestions.map((s, sIdx) => (
                                                <Tooltip
                                                    key={sIdx}
                                                    content={`${formatConfidence(s.confidence)} match`}
                                                    openDelay={100}
                                                >
                                                    <Badge
                                                        size="xs"
                                                        colorPalette={getConfidenceColor(s.confidence)}
                                                        variant={s.confidence >= 0.9 ? 'solid' : 'subtle'}
                                                        cursor="pointer"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            if (s.item.asset_id) handleMapAsset(issue, s.item.asset_id);
                                                        }}
                                                        _hover={{ opacity: 0.8 }}
                                                    >
                                                        {s.item.symbol.slice(0, 8)}{s.confidence >= 0.9 && '✓'}
                                                    </Badge>
                                                </Tooltip>
                                            ))}
                                        </HStack>
                                    )}
                                </Flex>
                            );
                        })}
                    </Flex>
                );
            },
        },
    ], [issuesByTxId, assets, fixedIds, fixingIds, handleMapAsset, onAssetsUpdated]);

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
            <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                <Spinner size="xl" color="blue.500" />
                <Text mt={4}>Loading linkage issues...</Text>
            </Box>
        );
    }

    // No issues
    if (totalCount === 0 || transactionIds.length === 0) {
        return (
            <Box p={6} bg="green.50" borderRadius="md" textAlign="center">
                <Text color="green.600" fontWeight="medium">✓ No asset linkage issues found!</Text>
            </Box>
        );
    }

    // Render TransactionsTable with filtered transactions
    return (
        <TransactionsTable
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
            config={tableConfig}
        />
    );
};

export default AssetLinkageTable;
