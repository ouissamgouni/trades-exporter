/**
 * AccountsLinkageTable
 *
 * Wrapper around TransactionsTable for transactions with account linkage issues.
 * Fetches issues from /transactions/data-health-check/transfer-issues,
 * groups by transaction_id, and renders TransactionsTable with an
 * "Account Issue" badge column. Fixes happen via inline-edit cells.
 */

import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Box, Badge, Spinner, Text, Flex } from '@chakra-ui/react';
import { TransactionsTable } from '../../TransactionsTable';
import { defaultFilterState } from '../../TransactionFilters';
import { ColumnPlugin, TableConfig } from '../types';
import { presetToVisibility } from '../useTransactionsTable';
import { API_URL, Account, Asset, Transaction, TransactionIssue } from '../../../types';
import { Tooltip } from '../../ui/tooltip';

// ============================================================================
// Types
// ============================================================================

interface AccountsLinkageTableProps {
    /** Callback when an issue is fixed */
    onFixed?: () => void;
}

// Issue type configuration for account issues
const ACCOUNT_ISSUE_CONFIG: Record<string, { color: string; label: string }> = {
    missing_transfer_from_account: { color: 'blue', label: 'Missing From' },
    missing_transfer_to_account: { color: 'blue', label: 'Missing To' },
    unlinked_transfer_from_account: { color: 'cyan', label: 'Unlinked From' },
    unlinked_transfer_to_account: { color: 'cyan', label: 'Unlinked To' },
    unlinked_account: { color: 'orange', label: 'Unlinked Account' },
    missing_source_account: { color: 'orange', label: 'Missing Account' },
};

// ============================================================================
// Component
// ============================================================================

export const AccountsLinkageTable: React.FC<AccountsLinkageTableProps> = ({
    onFixed,
}) => {
    // Fetch all account linkage issues
    const { data: issuesData, isLoading } = useQuery({
        queryKey: ['accountLinkageIssues'],
        queryFn: async () => {
            const allIssues: TransactionIssue[] = [];
            let page = 1;
            let totalPages = 1;

            while (page <= totalPages) {
                const params = new URLSearchParams({
                    page: String(page),
                    per_page: '200',
                });
                const response = await fetch(`${API_URL}/transactions/data-health-check/transfer-issues?${params}`);
                if (!response.ok) throw new Error('Failed to fetch account linkage issues');

                const data = await response.json();
                allIssues.push(...data.issues);
                totalPages = data.pagination.total_pages ?? 1;
                page++;
            }

            return allIssues;
        },
    });

    const issues = issuesData ?? [];

    // Group by transaction_id
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

    // Account issue column plugin
    const additionalColumns: ColumnPlugin<Transaction>[] = useMemo(() => [
        {
            id: 'account-issue',
            header: 'Account Issue',
            width: '160px',
            render: (tx: Transaction) => {
                const txIssues = issuesByTxId.get(tx.id) || [];
                if (txIssues.length === 0) return null;

                return (
                    <Flex direction="column" gap={0.5}>
                        {txIssues.map((issue, idx) => {
                            const config = ACCOUNT_ISSUE_CONFIG[issue.issue_type] || { color: 'gray', label: issue.issue_type };
                            return (
                                <Flex key={idx} align="center" gap={1}>
                                    <Badge size="xs" colorPalette={config.color} fontSize="7px">
                                        {config.label}
                                    </Badge>
                                    <Tooltip content={issue.raw_value} openDelay={100}>
                                        <Text fontSize="7px" color="orange.600" truncate maxW="80px">
                                            {issue.raw_value}
                                        </Text>
                                    </Tooltip>
                                </Flex>
                            );
                        })}
                    </Flex>
                );
            },
        },
    ], [issuesByTxId]);

    // Table configuration — show accounts column for inline-edit fixes
    const tableConfig: TableConfig<Transaction> = useMemo(() => ({
        columnPreset: 'compact',
        hiddenColumns: ['bundle', 'taxability', 'feeInBase'],
        shownColumns: ['accounts'],
        features: {
            filters: false,
            selection: false,
            inlineEdit: true,
        },
    }), []);

    const initialColumnVisibility = useMemo(
        () => presetToVisibility('compact', ['bundle', 'taxability', 'feeInBase'], ['accounts']),
        [],
    );

    if (isLoading) {
        return (
            <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                <Spinner size="xl" color="blue.500" />
                <Text mt={4}>Loading account linkage issues...</Text>
            </Box>
        );
    }

    if (transactionIds.length === 0) {
        return (
            <Box p={6} bg="green.50" borderRadius="md" textAlign="center">
                <Text color="green.600" fontWeight="medium">✓ No account linkage issues found!</Text>
            </Box>
        );
    }

    return (
        <TransactionsTable
            title="Account Linkage Issues"
            subtitle={`${transactionIds.length} transaction${transactionIds.length !== 1 ? 's' : ''} with unlinked accounts`}
            tableId="accountsLinkage"
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
            onDataChange={onFixed}
        />
    );
};

export default AccountsLinkageTable;
