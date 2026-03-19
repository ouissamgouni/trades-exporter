/**
 * MissingDataTable
 *
 * Wrapper around TransactionsTable for displaying transactions with missing data issues.
 * Fetches issues from /transactions/data-health-check/missing-data-issues,
 * groups them by transaction_id, and renders a TransactionsTable with an
 * additional "Issues" column showing colored badges per issue type.
 */

import React, { useMemo, useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Box, Badge, Spinner, Text, Flex, Button, HStack } from '@chakra-ui/react';
import { FiCheck, FiZap } from 'react-icons/fi';
import { TransactionsTable } from '../../TransactionsTable';
import { defaultFilterState } from '../../TransactionFilters';
import { ColumnPlugin, TableConfig } from '../types';
import { presetToVisibility } from '../useTransactionsTable';
import { API_URL, Account, Asset, Transaction, TransactionIssue } from '../../../types';
import { AssetSelector } from '../../AssetSelector';
import { AccountSelector } from '../../AccountSelector';
import { toaster } from '../../ui/toaster';
import { Tooltip } from '../../ui/tooltip';
import { ISSUE_CONFIG } from '../../../constants/issueConfig';
import { linkRawAccount, linkRawAsset } from '../../../utils/rawAccountApi';

// ============================================================================
// Types
// ============================================================================

interface MissingDataTableProps {
    /** Callback when an issue is fixed */
    onFixed?: () => void;
    /** Available accounts for the selector */
    accounts: Account[];
    /** Available assets for the selector */
    assets: Asset[];
    /** Callback when assets list should be refreshed */
    onAssetsUpdated?: () => void;
    /** Callback when accounts list should be refreshed */
    onAccountsUpdated?: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const MissingDataTable: React.FC<MissingDataTableProps> = ({
    onFixed,
    accounts,
    assets,
    onAssetsUpdated,
    onAccountsUpdated,
}) => {
    const queryClient = useQueryClient();
    const [fixedKeys, setFixedKeys] = useState<Set<string>>(new Set());
    const [applyingKeys, setApplyingKeys] = useState<Set<string>>(new Set());
    const [isApplyingAll, setIsApplyingAll] = useState(false);

    // Fetch all missing-data issues (load all pages)
    const { data: issuesData, isLoading } = useQuery({
        queryKey: ['missingDataIssues'],
        queryFn: async () => {
            const allIssues: TransactionIssue[] = [];
            let page = 1;
            let totalPages = 1;

            while (page <= totalPages) {
                const params = new URLSearchParams({
                    page: String(page),
                    per_page: '200',
                });
                const response = await fetch(`${API_URL}/transactions/data-health-check/missing-data-issues?${params}`);
                if (!response.ok) throw new Error('Failed to fetch missing data issues');

                const data = await response.json();
                allIssues.push(...data.issues);
                totalPages = data.pagination.total_pages ?? 1;
                page++;
            }

            return allIssues;
        },
    });

    const issues = issuesData ?? [];

    // Group issues by transaction_id
    const issuesByTxId = useMemo(() => {
        const map = new Map<number, TransactionIssue[]>();
        for (const issue of issues) {
            const existing = map.get(issue.transaction_id) || [];
            existing.push(issue);
            map.set(issue.transaction_id, existing);
        }
        return map;
    }, [issues]);

    // Unique transaction IDs
    const transactionIds = useMemo(
        () => Array.from(new Set(issues.map(i => i.transaction_id))),
        [issues],
    );

    // High confidence suggestions for bulk apply
    const highConfidenceIssues = useMemo(
        () => issues.filter(i => i.suggestion && i.suggestion.confidence >= 0.7 && i.raw_value),
        [issues],
    );

    const isAccountIssue = (issueType: string) =>
        ['unlinked_account', 'missing_source_account', 'missing_transfer_from_account',
            'missing_transfer_to_account', 'unlinked_transfer_from_account', 'unlinked_transfer_to_account']
            .includes(issueType);

    // Handle fix for a single issue
    const handleFix = useCallback(async (issue: TransactionIssue, targetId: number) => {
        const key = `${issue.transaction_id}-${issue.issue_type}`;
        setApplyingKeys(prev => new Set(prev).add(key));
        try {
            if (isAccountIssue(issue.issue_type)) {
                await linkRawAccount({ source: issue.source, label: issue.raw_value, network: issue.network || undefined, accountId: targetId });
            } else {
                await linkRawAsset({ source: issue.source, symbol: issue.raw_value, network: issue.network || undefined, assetId: targetId });
            }
            setFixedKeys(prev => new Set(prev).add(key));
            toaster.success({ title: 'Mapped', description: `${issue.raw_value} linked` });
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            queryClient.invalidateQueries({ queryKey: ['missingDataIssues'] });
            queryClient.invalidateQueries({ queryKey: ['dataHealthStatus'] });
            onFixed?.();
        } catch {
            toaster.error({ title: 'Error', description: 'Failed to map' });
        } finally {
            setApplyingKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
        }
    }, [queryClient, onFixed]);

    // Apply all high-confidence suggestions
    const handleApplyAll = useCallback(async () => {
        if (!highConfidenceIssues.length) return;
        setIsApplyingAll(true);
        try {
            const accountTypes = new Set(['unlinked_account', 'missing_source_account', 'missing_transfer_from_account', 'missing_transfer_to_account', 'unlinked_transfer_from_account', 'unlinked_transfer_to_account']);
            const assetIssues = highConfidenceIssues.filter(i => !accountTypes.has(i.issue_type));
            const accountIssuesList = highConfidenceIssues.filter(i => accountTypes.has(i.issue_type));

            if (assetIssues.length) {
                const unique = new Map(assetIssues.map(i => [`${i.source}:${i.raw_value}`, i]));
                await fetch(`${API_URL}/raw-assets/bulk-map`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mappings: Array.from(unique.values()).map(i => ({
                            symbol: i.raw_value,
                            source: i.source,
                            asset_id: i.suggestion!.id,
                        })),
                    }),
                });
            }

            if (accountIssuesList.length) {
                const unique = new Map(accountIssuesList.map(i => [`${i.source}:${i.raw_value}:${i.network || ''}`, i]));
                for (const issue of unique.values()) {
                    await linkRawAccount({ source: issue.source, label: issue.raw_value, network: issue.network || undefined, accountId: issue.suggestion!.id });
                }
            }

            toaster.success({ title: 'Applied', description: `${highConfidenceIssues.length} fix(es)` });
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            queryClient.invalidateQueries({ queryKey: ['missingDataIssues'] });
            queryClient.invalidateQueries({ queryKey: ['dataHealthStatus'] });
            onFixed?.();
        } catch (err) {
            toaster.error({ title: 'Failed', description: err instanceof Error ? err.message : 'Unknown error' });
        } finally {
            setIsApplyingAll(false);
        }
    }, [highConfidenceIssues, queryClient, onFixed]);

    // Issues column plugin
    const additionalColumns: ColumnPlugin<Transaction>[] = useMemo(() => [
        {
            id: 'data-issues',
            header: 'Issues',
            width: '220px',
            render: (tx: Transaction) => {
                const txIssues = issuesByTxId.get(tx.id) || [];
                if (txIssues.length === 0) return null;

                return (
                    <Flex direction="column" gap={1}>
                        {txIssues.map((issue, idx) => {
                            const key = `${issue.transaction_id}-${issue.issue_type}`;
                            const isFixed = fixedKeys.has(key);
                            const isApplying = applyingKeys.has(key);
                            const config = ISSUE_CONFIG[issue.issue_type] || { color: 'gray', label: issue.issue_type };

                            if (isFixed) {
                                return (
                                    <Badge key={idx} colorPalette="green" size="xs" fontSize="7px">
                                        <FiCheck size={10} /> {config.label} Fixed
                                    </Badge>
                                );
                            }

                            if (isApplying) {
                                return <Spinner key={idx} size="xs" />;
                            }

                            const suggestionConfidence = issue.suggestion?.confidence ?? 0;
                            const suggestionColor = suggestionConfidence >= 0.9 ? 'green'
                                : suggestionConfidence >= 0.7 ? 'blue' : 'gray';

                            return (
                                <Flex key={idx} direction="column" gap={0.5} onClick={e => e.stopPropagation()}>
                                    <Flex align="center" gap={1}>
                                        <Badge size="xs" colorPalette={config.color} fontSize="6px" flexShrink={0} w="65px" textAlign="center">
                                            {config.label}
                                        </Badge>
                                        <Tooltip content={issue.raw_value} openDelay={100}>
                                            <Text fontSize="7px" color="orange.600" flexShrink={0} w="40px" truncate>
                                                {issue.raw_value}
                                            </Text>
                                        </Tooltip>
                                        {issue.suggestion && issue.raw_value && suggestionConfidence >= 0.7 && (
                                            <Button
                                                size="xs"
                                                colorPalette={suggestionColor}
                                                variant="outline"
                                                onClick={() => handleFix(issue, issue.suggestion!.id)}
                                                h="22px"
                                                minW="45px"
                                                px={1}
                                                flexShrink={0}
                                            >
                                                <FiCheck size={11} />
                                            </Button>
                                        )}
                                    </Flex>
                                    <Box flex={1} minW={0}>
                                        {isAccountIssue(issue.issue_type) ? (
                                            <AccountSelector
                                                accounts={accounts}
                                                value={null}
                                                onChange={(id) => id && handleFix(issue, id)}
                                                onAccountCreated={onAccountsUpdated}
                                                size="sm"
                                                placeholder="+ Add"
                                                defaultName={issue.raw_value}
                                                rawAccountLabel={issue.raw_value}
                                                rawAccountSource={issue.source}
                                                rawAccountNetwork={issue.network || undefined}
                                            />
                                        ) : (
                                            <AssetSelector
                                                assets={assets}
                                                value={null}
                                                onChange={(id) => id && handleFix(issue, id)}
                                                onAssetCreated={onAssetsUpdated}
                                                size="sm"
                                                placeholder="+ Add"
                                                defaultSymbol={issue.raw_value}
                                                rawAssetSymbol={issue.raw_value}
                                                rawAssetSource={issue.source}
                                            />
                                        )}
                                    </Box>
                                </Flex>
                            );
                        })}
                    </Flex>
                );
            },
        },
    ], [issuesByTxId, fixedKeys, applyingKeys, accounts, assets, handleFix, onAssetsUpdated, onAccountsUpdated]);

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

    const initialColumnVisibility = useMemo(
        () => presetToVisibility('compact', ['bundle', 'taxability', 'feeInBase']),
        [],
    );

    if (isLoading) {
        return (
            <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                <Spinner size="xl" color="blue.500" />
                <Text mt={4}>Loading missing data issues...</Text>
            </Box>
        );
    }

    if (transactionIds.length === 0) {
        return (
            <Box p={6} bg="green.50" borderRadius="md" textAlign="center">
                <Text color="green.600" fontWeight="medium">✓ No missing data issues found!</Text>
            </Box>
        );
    }

    return (
        <Box>
            {/* Bulk apply button */}
            {highConfidenceIssues.length > 0 && (
                <Flex justify="flex-end" mb={2}>
                    <Button
                        size="xs"
                        colorPalette="green"
                        onClick={handleApplyAll}
                        disabled={isApplyingAll}
                    >
                        {isApplyingAll ? <Spinner size="xs" /> : <FiZap size={12} />}
                        <Text ml={1}>Apply All ({highConfidenceIssues.length})</Text>
                    </Button>
                </Flex>
            )}

            <TransactionsTable
                title="Missing Data Issues"
                subtitle={`${transactionIds.length} transaction${transactionIds.length !== 1 ? 's' : ''} with missing data`}
                tableId="missingData"
                initialColumnVisibility={initialColumnVisibility}
                filters={{
                    ...defaultFilterState,
                    transactionIds,
                    reviewStatus: [],
                }}
                showFilters={false}
                showBundles={false}
                showSuggestions={false}
                compact={true}
                additionalColumns={additionalColumns}
                config={tableConfig}
            />
        </Box>
    );
};

export default MissingDataTable;
