/**
 * DataHealthCheckDrawer
 * 
 * Slide-in drawer showing data completeness issues for P&L calculations.
 * Transaction-centric view with table layout and inline fixing.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    Heading,
    HStack,
    Spinner,
    Tabs,
    Text,
    VStack,
} from '@chakra-ui/react';
import {
    FiActivity,
    FiAlertCircle,
    FiArrowDown,
    FiArrowUp,
    FiCheck,
    FiCheckCircle,
    FiChevronLeft,
    FiChevronRight,
    FiRefreshCw,
    FiRepeat,
    FiX,
    FiZap,
} from 'react-icons/fi';
import {
    API_URL,
    TransactionStatusResponse,
    TransactionIssue,
    IssueType,
    Asset,
    Account,
} from '../types';
import { TransactionTooltip } from './TransactionTooltip';
import { AssetSelector } from './AssetSelector';
import { AccountSelector } from './AccountSelector';
import { SourceInfoCell } from './SourceInfoCell';
import { toaster } from './ui/toaster';
import { TransactionDetailDrawer } from './TransactionDetailDrawer';
import { TransactionsTable } from './TransactionsTable';
import { AssetLinkageTable } from './tables/wrappers/AssetLinkageTable';
import { defaultFilterState } from './TransactionFilters';
import { formatQuantity } from '../utils/numberUtils';
import { AccountMappingPanel } from './AccountMappingPanel';
import { DuplicateResolutionPanel } from './DuplicateResolutionPanel';
import { useDataHealth } from '../contexts/DataHealthContext';
import { linkRawAccount, linkRawAsset } from '../utils/rawAccountApi';

// =============================================================================
// Constants & Configuration
// =============================================================================

const ITEMS_PER_PAGE = 50;

// Column widths for table-like alignment
const COLS = {
    ID: '55px',
    DATE: '80px',
    SOURCE: '200px',
    TX: '110px',
    TYPE: '120px',
    VALUE: '95px',
    ACTION: '155px',
} as const;

// Issue type configuration
const ISSUE_CONFIG: Record<IssueType, { color: string; label: string }> = {
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

// =============================================================================
// Utility Functions
// =============================================================================

const formatDate = (dateStr: string): string => {
    try {
        return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: '2-digit'
        });
    } catch {
        return dateStr.slice(0, 10);
    }
};

// Using formatQuantity from utils/numberUtils for consistent quantity formatting with K/M/B suffixes

// =============================================================================
// Sub-Components
// =============================================================================

/** Direction indicator icon */
const DirectionIcon: React.FC<{ direction: string }> = ({ direction }) => {
    const icons: Record<string, JSX.Element> = {
        inflow: <FiArrowDown size={11} color="var(--chakra-colors-green-500)" />,
        outflow: <FiArrowUp size={11} color="var(--chakra-colors-red-500)" />,
    };
    return icons[direction] || <FiRepeat size={11} color="var(--chakra-colors-gray-400)" />;
};

/** Table header row */
const TableHeader: React.FC = () => (
    <Flex
        px={2} py={1.5}
        bg="gray.50"
        borderBottomWidth={1}
        borderColor="gray.200"
        fontSize="xs"
        fontWeight="semibold"
        color="gray.500"
    >
        <Box w={COLS.ID}>ID</Box>
        <Box w={COLS.DATE}>Date</Box>
        <Box w={COLS.SOURCE}>Source</Box>
        <Box w={COLS.TX}>Transaction</Box>
        <Box w={COLS.TYPE}>Issue</Box>
        <Box w={COLS.VALUE}>Value</Box>
        <Box w={COLS.ACTION}>Action</Box>
    </Flex>
);

// =============================================================================
// Issue Row Component
// =============================================================================

interface IssueRowProps {
    issue: TransactionIssue;
    assets: Asset[];
    accounts: Account[];
    onFixed: () => void;
    onAssetsUpdated?: () => void;
    onAccountsUpdated?: () => void;
    onTransactionClick: (txId: number) => void;
}

const IssueRow: React.FC<IssueRowProps> = ({
    issue, assets, accounts, onFixed, onAssetsUpdated, onAccountsUpdated, onTransactionClick
}) => {
    const [isFixed, setIsFixed] = useState(false);
    const [isApplying, setIsApplying] = useState(false);

    const config = ISSUE_CONFIG[issue.issue_type];
    const isAccountIssue = issue.issue_type === 'unlinked_account'
        || issue.issue_type === 'missing_source_account'
        || issue.issue_type === 'missing_transfer_from_account'
        || issue.issue_type === 'missing_transfer_to_account'
        || issue.issue_type === 'unlinked_transfer_from_account'
        || issue.issue_type === 'unlinked_transfer_to_account';

    // API call to map raw asset/account
    const mapRawItem = async (id: number) => {
        if (isAccountIssue) {
            await linkRawAccount({ source: issue.source, label: issue.raw_value, network: issue.network || undefined, accountId: id });
        } else {
            await linkRawAsset({ source: issue.source, symbol: issue.raw_value, network: issue.network || undefined, assetId: id });
        }
    };

    // Handle selector change (selector handles API call via linkRawAsset/linkRawAccount)
    const handleSelect = (id: number | null) => {
        if (!id) return;
        setIsFixed(true);
        toaster.success({
            title: isAccountIssue ? 'Account mapped' : 'Asset mapped',
            description: `${issue.raw_value} linked successfully`,
        });
        onFixed();
    };

    // Handle suggestion accept (direct API call)
    const handleAcceptSuggestion = async () => {
        if (!issue.suggestion || !issue.raw_value) return;

        setIsApplying(true);
        try {
            await mapRawItem(issue.suggestion.id);
            setIsFixed(true);
            toaster.success({
                title: isAccountIssue ? 'Account mapped' : 'Asset mapped',
                description: `${issue.raw_value} → ${issue.suggestion.name}`,
            });
            onFixed();
        } catch (err) {
            toaster.error({
                title: 'Failed to apply suggestion',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setIsApplying(false);
        }
    };

    const suggestionConfidence = issue.suggestion?.confidence ?? 0;
    const suggestionColor = suggestionConfidence >= 0.9 ? 'green'
        : suggestionConfidence >= 0.7 ? 'blue' : 'gray';

    return (
        <Flex
            px={2} py={1}
            bg={isFixed ? 'green.50' : 'white'}
            borderBottomWidth={1}
            borderColor={isFixed ? 'green.200' : 'gray.100'}
            fontSize="xs"
            align="center"
            _hover={{ bg: isFixed ? 'green.50' : 'gray.25' }}
        >
            {/* ID with tooltip */}
            <Box w={COLS.ID}>
                <TransactionTooltip txId={issue.transaction_id}>
                    <Text
                        color="blue.500"
                        fontFamily="mono"
                        cursor="pointer"
                        _hover={{ textDecoration: 'underline' }}
                        onClick={() => onTransactionClick(issue.transaction_id)}
                    >
                        #{issue.transaction_id}
                    </Text>
                </TransactionTooltip>
            </Box>

            {/* Date */}
            <Box w={COLS.DATE}>
                <Text color="gray.500">{formatDate(issue.date_time)}</Text>
            </Box>

            {/* Source Info */}
            <Box w={COLS.SOURCE}>
                <SourceInfoCell
                    sourceAccount={issue.source_account ?? undefined}
                    accountId={issue.account_id}
                    resolvedAccountName={issue.account_name ?? undefined}
                    resolvedAccount={accounts.find(a => a.id === issue.account_id)}
                    source={issue.source}
                    sourceSymbol={issue.source_asset_symbol}
                    connectorName={issue.connector_name ?? undefined}
                    runDatetime={issue.run_datetime ?? undefined}
                    syncConnectorRunId={issue.sync_connector_run_id ?? undefined}
                    network={issue.network ?? undefined}
                />
            </Box>

            {/* Transaction */}
            <Box w={COLS.TX}>
                <Flex align="center" gap={1}>
                    <Box flexShrink={0}>
                        <DirectionIcon direction={issue.direction} />
                    </Box>
                    <Text truncate title={`${issue.quantity} ${issue.source_asset_symbol}`}>
                        {formatQuantity(issue.quantity)} {issue.source_asset_symbol}
                    </Text>
                </Flex>
            </Box>

            {/* Issue Type */}
            <Box w={COLS.TYPE}>
                <Badge
                    size="xs"
                    colorPalette={config.color}
                    variant="subtle"
                    maxW="100%"
                    whiteSpace="normal"
                    wordBreak="break-word"
                    lineClamp={2}
                >
                    {config.label}
                </Badge>
            </Box>

            {/* Raw Value */}
            <Box w={COLS.VALUE}>
                <Text
                    color="gray.600"
                    truncate
                    title={issue.raw_value}
                    wordBreak="break-all"
                    maxW="100%"
                >
                    {issue.raw_value || '—'}
                </Text>
            </Box>

            {/* Action */}
            <Box w={COLS.ACTION}>
                {isFixed ? (
                    <Badge colorPalette="green" size="xs">
                        <FiCheckCircle size={10} />
                        <Text ml={1}>Done</Text>
                    </Badge>
                ) : (
                    <Flex gap={1} align="center" w="full">
                        {/* Show suggestion chip only if confidence >= 70% */}
                        {issue.suggestion && issue.raw_value && suggestionConfidence >= 0.7 && (
                            <Button
                                size="xs"
                                colorPalette={suggestionColor}
                                variant="outline"
                                onClick={handleAcceptSuggestion}
                                disabled={isApplying}
                                title={`${Math.round(suggestionConfidence * 100)}% match - ${issue.suggestion.name}`}
                                h="22px"
                                minW="45px"
                                px={1}
                                flexShrink={0}
                            >
                                {isApplying ? <Spinner size="xs" /> : <FiCheck size={11} />}
                            </Button>
                        )}
                        {/* Always show manual selector */}
                        <Box flex={1} minW={0}>
                            {isAccountIssue ? (
                                <AccountSelector
                                    accounts={accounts}
                                    value={null}
                                    onChange={handleSelect}
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
                                    onChange={handleSelect}
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
                )}
            </Box>
        </Flex>
    );
};

// =============================================================================
// Main Drawer Component
// =============================================================================

interface DataHealthCheckDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    accountIds?: number[];
    onNavigateToPendingTransactions?: () => void;
    onNavigateToBundleSuggestions?: () => void;
    refreshTrigger?: number;
    assets?: Asset[];
    accounts?: Account[];
    onAssetsUpdated?: () => void;
    onAccountsUpdated?: () => void;
    onIssueFixed?: () => void;
}

export const DataHealthCheckDrawer: React.FC<DataHealthCheckDrawerProps> = ({
    isOpen,
    onClose,
    accountIds,
    onNavigateToPendingTransactions,
    onNavigateToBundleSuggestions,
    refreshTrigger,
    assets = [],
    accounts = [],
    onAssetsUpdated,
    onAccountsUpdated,
    onIssueFixed,
}) => {
    const [data, setData] = useState<TransactionStatusResponse | null>(null);
    const [issues, setIssues] = useState<TransactionIssue[]>([]);
    const [issuesTotal, setIssuesTotal] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [page, setPage] = useState(1);
    const [isApplyingAll, setIsApplyingAll] = useState(false);
    const [activeTab, setActiveTab] = useState<'missing-data' | 'assets-linkage' | 'accounts-linkage' | 'pending' | 'duplicates'>('missing-data');

    // Get dismiss state from context
    const { showDismissedMappings, setShowDismissedMappings } = useDataHealth();

    // Transaction detail drawer state
    const [selectedTransactionId, setSelectedTransactionId] = useState<number | null>(null);
    const [isTransactionDrawerOpen, setIsTransactionDrawerOpen] = useState(false);

    // Resizable drawer state
    const [drawerWidth, setDrawerWidth] = useState<number>(() => {
        const saved = localStorage.getItem('dataHealthDrawerWidth');
        return saved ? parseInt(saved, 10) : Math.min(window.innerWidth * 0.75, 1400);
    });
    const [isResizing, setIsResizing] = useState(false);
    const resizeStartX = React.useRef<number>(0);
    const resizeStartWidth = React.useRef<number>(0);

    // Resize handlers
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsResizing(true);
        resizeStartX.current = e.clientX;
        resizeStartWidth.current = drawerWidth;
    }, [drawerWidth]);

    const handleResizeMove = useCallback((e: MouseEvent) => {
        if (!isResizing) return;
        const deltaX = resizeStartX.current - e.clientX;
        const newWidth = Math.max(600, Math.min(window.innerWidth * 0.95, resizeStartWidth.current + deltaX));
        setDrawerWidth(newWidth);
    }, [isResizing]);

    const handleResizeEnd = useCallback(() => {
        if (!isResizing) return;
        setIsResizing(false);
        localStorage.setItem('dataHealthDrawerWidth', drawerWidth.toString());
    }, [isResizing, drawerWidth]);

    // Add/remove resize event listeners
    useEffect(() => {
        if (isResizing) {
            document.addEventListener('mousemove', handleResizeMove);
            document.addEventListener('mouseup', handleResizeEnd);
            return () => {
                document.removeEventListener('mousemove', handleResizeMove);
                document.removeEventListener('mouseup', handleResizeEnd);
            };
        }
    }, [isResizing, handleResizeMove, handleResizeEnd]);

    // Fetch status data
    const fetchStatus = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (accountIds?.length) {
                params.set('account_ids', accountIds.join(','));
            }

            const response = await fetch(`${API_URL}/transactions/data-health-check/status?${params}`);
            if (!response.ok) throw new Error('Failed to fetch status');

            setData(await response.json());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        }
    }, [accountIds]);

    // Fetch issues based on active tab
    const fetchIssues = useCallback(async (tab: typeof activeTab, pageNum: number = 1) => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({
                page: pageNum.toString(),
                per_page: ITEMS_PER_PAGE.toString(),
            });
            if (accountIds?.length) {
                params.set('account_ids', accountIds.join(','));
            }

            let endpoint = '';
            if (tab === 'missing-data') {
                endpoint = '/transactions/data-health-check/missing-data-issues';
            } else if (tab === 'assets-linkage') {
                endpoint = '/transactions/data-health-check/linkage-issues';
                // Filter to only show asset-related linkage issues
                params.set('issue_types', 'unlinked_asset,unlinked_price_quote,unlinked_fee_quote');
            } else if (tab === 'accounts-linkage') {
                // Account linkage is handled by AccountMappingPanel component
                return;
            } else {
                return; // pending tab doesn't use this
            }

            const response = await fetch(`${API_URL}${endpoint}?${params}`);
            if (!response.ok) throw new Error(`Failed to fetch ${tab} issues`);

            const result = await response.json();
            setIssues(result.issues);
            setIssuesTotal(result.pagination.total_count);
            setPage(pageNum);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setIsLoading(false);
        }
    }, [accountIds]);

    // Fetch on open/refresh/tab change
    useEffect(() => {
        if (isOpen) {
            fetchStatus();
            // Skip fetching issues for tabs that manage their own data:
            // - 'pending' uses TransactionsTable with its own query
            // - 'assets-linkage' uses AssetLinkageTable with its own query
            // - 'accounts-linkage' uses AccountMappingPanel with its own query
            if (activeTab === 'missing-data') {
                fetchIssues(activeTab, 1);
            }
        }
    }, [isOpen, activeTab, fetchStatus, fetchIssues, refreshTrigger]);

    // Refresh after fix
    const handleFixComplete = useCallback(() => {
        setTimeout(() => {
            fetchStatus();
            // Only fetch issues for tabs that use the drawer's issues state
            if (activeTab === 'missing-data') {
                fetchIssues(activeTab, page);
            }
            onAssetsUpdated?.();
            onAccountsUpdated?.();
            onIssueFixed?.();
        }, 500);
    }, [activeTab, page, fetchStatus, fetchIssues, onAssetsUpdated, onAccountsUpdated, onIssueFixed]);

    // High confidence suggestions for bulk apply (70%+ threshold)
    const highConfidenceIssues = (issues ?? []).filter(
        i => i.suggestion && i.suggestion.confidence >= 0.7 && i.raw_value
    );

    // Apply all high-confidence suggestions
    const handleApplyAll = async () => {
        if (!highConfidenceIssues.length) return;

        setIsApplyingAll(true);
        try {
            // Group by type
            const accountTypes = new Set(['unlinked_account', 'missing_source_account', 'missing_transfer_from_account', 'missing_transfer_to_account', 'unlinked_transfer_from_account', 'unlinked_transfer_to_account']);
            const assetIssues = highConfidenceIssues.filter(i => !accountTypes.has(i.issue_type));
            const accountIssues = highConfidenceIssues.filter(i => accountTypes.has(i.issue_type));

            // Bulk map assets (deduplicated)
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

            // Map accounts individually (deduplicated) — with network
            if (accountIssues.length) {
                const unique = new Map(accountIssues.map(i => [`${i.source}:${i.raw_value}:${i.network || ''}`, i]));
                for (const issue of unique.values()) {
                    await linkRawAccount({ source: issue.source, label: issue.raw_value, network: issue.network || undefined, accountId: issue.suggestion!.id });
                }
            }

            toaster.success({
                title: 'Applied suggestions',
                description: `${highConfidenceIssues.length} fix(es) applied`,
            });
            handleFixComplete();
        } catch (err) {
            toaster.error({
                title: 'Failed to apply suggestions',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setIsApplyingAll(false);
        }
    };

    if (!isOpen) return null;

    const totalPages = Math.ceil(issuesTotal / ITEMS_PER_PAGE);

    // Check if current tab has issues - check BOTH status count AND actual fetched data
    const statusHasIssues = activeTab === 'missing-data'
        ? (data?.missing_data_issues_count ?? 0) > 0
        : activeTab === 'assets-linkage'
            ? (data?.linkage_issues_count ?? 0) > 0
            : activeTab === 'accounts-linkage'
                ? (data?.transfer_issues_count ?? 0) > 0
                : activeTab === 'duplicates'
                    ? (data?.duplicate_count ?? 0) > 0
                    : false;

    // Use fetched data if available, otherwise fall back to status count
    const hasIssues = issuesTotal > 0 || (statusHasIssues && issues.length === 0);

    const allClear = data && !data.has_issues && data.bundle_suggestions_count === 0;

    return (
        <>
            {/* Backdrop */}
            <Box
                position="fixed"
                inset={0}
                bg="blackAlpha.400"
                zIndex={99}
                onClick={onClose}
            />

            {/* Panel */}
            <Box
                position="fixed"
                right={0}
                top={0}
                bottom={0}
                width={`${drawerWidth}px`}
                maxW="95vw"
                bg="white"
                boxShadow="xl"
                zIndex={100}
                overflowY="auto"
                borderLeft="1px solid"
                borderColor="gray.200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Resize Handle */}
                <Box
                    position="absolute"
                    left={0}
                    top={0}
                    bottom={0}
                    width="4px"
                    cursor="col-resize"
                    bg={isResizing ? 'blue.400' : 'transparent'}
                    _hover={{ bg: 'blue.200' }}
                    transition="background-color 0.2s"
                    onMouseDown={handleResizeStart}
                    zIndex={1}
                />

                {/* Header */}
                <Flex
                    justify="space-between"
                    align="center"
                    px={3}
                    py={2}
                    borderBottom="1px solid"
                    borderColor="gray.200"
                    bg="gray.50"
                    position="sticky"
                    top={0}
                    zIndex={1}
                >
                    <Flex align="center" gap={2}>
                        <FiActivity size={16} />
                        <Heading size="sm">Data Health Check</Heading>
                    </Flex>
                    <HStack gap={1}>
                        {highConfidenceIssues.length > 0 && (
                            <Button
                                size="xs"
                                colorPalette="green"
                                onClick={handleApplyAll}
                                disabled={isApplyingAll || isLoading}
                            >
                                {isApplyingAll ? <Spinner size="xs" /> : <FiZap size={12} />}
                                <Text ml={1}>Apply ({highConfidenceIssues.length})</Text>
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                                // Clear all cached issues and refresh status
                                setIssues([]);
                                setIssuesTotal(0);
                                setPage(1);
                                fetchStatus();
                                // Refresh current tab if not pending
                                if (activeTab !== 'pending') {
                                    fetchIssues(activeTab, 1);
                                }
                            }}
                            disabled={isLoading}
                            title="Refresh all tabs"
                        >
                            <FiRefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
                        </Button>
                        <Button variant="ghost" size="xs" onClick={onClose}>
                            <FiX size={16} />
                        </Button>
                    </HStack>
                </Flex>

                {/* Content */}
                <Box p={3}>
                    {/* Loading */}
                    {isLoading && !data && (
                        <Flex justify="center" py={8}>
                            <Spinner size="md" />
                        </Flex>
                    )}

                    {/* Error */}
                    {error && (
                        <Box p={3} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                            <Flex align="center" gap={2}>
                                <FiAlertCircle color="var(--chakra-colors-red-500)" />
                                <Text color="red.700" fontSize="sm">{error}</Text>
                            </Flex>
                        </Box>
                    )}

                    {data && (
                        <VStack gap={3} align="stretch">
                            {/* Summary */}
                            <Flex
                                align="center"
                                gap={3}
                                p={2}
                                bg="gray.50"
                                borderRadius="md"
                                justify="space-between"
                                flexWrap="wrap"
                                fontSize="xs"
                            >
                                <Text fontWeight="medium" color="gray.600">
                                    Transaction Status
                                </Text>
                                <HStack gap={3}>
                                    <Text><b>{data.total_count}</b> total</Text>
                                    <Text><b style={{ color: 'var(--chakra-colors-green-600)' }}>{data.valid_count}</b> valid</Text>
                                    <Text><b style={{ color: 'var(--chakra-colors-yellow-600)' }}>{data.pending_count}</b> pending</Text>
                                    <Text><b style={{ color: 'var(--chakra-colors-red-600)' }}>{data.invalid_count}</b> invalid</Text>
                                </HStack>
                            </Flex>

                            {/* Tabs for different issue types */}
                            <Tabs.Root value={activeTab} onValueChange={(e) => setActiveTab(e.value as typeof activeTab)}>
                                <Tabs.List>
                                    <Tabs.Trigger value="missing-data">
                                        Missing Data
                                        {data.missing_data_issues_count > 0 && (
                                            <Badge ml={1} size="xs" colorPalette="red">
                                                {data.missing_data_issues_count}
                                            </Badge>
                                        )}
                                    </Tabs.Trigger>
                                    <Tabs.Trigger value="assets-linkage">
                                        Assets Linkage
                                        {((data.linkage_issues_count || 0) > 0) && (
                                            <Badge ml={1} size="xs" colorPalette="purple">
                                                {data.linkage_issues_count}
                                            </Badge>
                                        )}
                                    </Tabs.Trigger>
                                    <Tabs.Trigger value="accounts-linkage">
                                        Accounts Linkage
                                        {(data.unmapped_accounts_transaction_count || 0) > 0 && (
                                            <Badge ml={1} size="xs" colorPalette="orange">
                                                {data.unmapped_accounts_transaction_count}
                                            </Badge>
                                        )}
                                    </Tabs.Trigger>
                                    <Tabs.Trigger value="pending">
                                        Pending
                                        {data.pending_count > 0 && (
                                            <Badge ml={1} size="xs" colorPalette="yellow">
                                                {data.pending_count}
                                            </Badge>
                                        )}
                                    </Tabs.Trigger>
                                    <Tabs.Trigger value="duplicates">
                                        Duplicates
                                        {(data.duplicate_count || 0) > 0 && (
                                            <Badge ml={1} size="xs" colorPalette="red">
                                                {data.duplicate_count}
                                            </Badge>
                                        )}
                                    </Tabs.Trigger>
                                </Tabs.List>
                            </Tabs.Root>

                            {/* All Clear */}
                            {allClear && (
                                <Box p={4} bg="green.50" borderRadius="md" borderWidth={1} borderColor="green.200" textAlign="center">
                                    <FiCheckCircle size={32} color="var(--chakra-colors-green-500)" style={{ margin: '0 auto 8px' }} />
                                    <Text fontWeight="bold" color="green.700">All Clear! ✓</Text>
                                    <Text color="green.600" fontSize="xs">All transactions have complete data.</Text>
                                </Box>
                            )}

                            {/* Quick Actions */}
                            {!allClear && (
                                <Flex gap={2} flexWrap="wrap">
                                    {data.pending_count > 0 && onNavigateToPendingTransactions && (
                                        <Button size="xs" colorPalette="blue" variant="outline" onClick={onNavigateToPendingTransactions}>
                                            <Badge colorPalette="blue" size="xs" mr={1}>{data.pending_count}</Badge>
                                            Pending Review
                                        </Button>
                                    )}
                                    {data.bundle_suggestions_count > 0 && onNavigateToBundleSuggestions && (
                                        <Button size="xs" colorPalette="teal" variant="outline" onClick={onNavigateToBundleSuggestions}>
                                            <Badge colorPalette="teal" size="xs" mr={1}>{data.bundle_suggestions_count}</Badge>
                                            Bundle Suggestions
                                        </Button>
                                    )}
                                </Flex>
                            )}

                            {/* Issues Table - shown only for missing-data tab */}
                            {activeTab === 'missing-data' && hasIssues && (
                                <>
                                    {/* Header with pagination */}
                                    <Flex justify="space-between" align="center">
                                        <Text fontSize="xs" fontWeight="medium" color="gray.600">
                                            Data Issues ({issuesTotal})
                                        </Text>
                                        {totalPages > 1 && (
                                            <HStack gap={1}>
                                                <Button size="xs" variant="ghost" onClick={() => fetchIssues(activeTab, page - 1)} disabled={page === 1 || isLoading}>
                                                    <FiChevronLeft size={14} />
                                                </Button>
                                                <Text fontSize="xs" color="gray.500">{page} / {totalPages}</Text>
                                                <Button size="xs" variant="ghost" onClick={() => fetchIssues(activeTab, page + 1)} disabled={page === totalPages || isLoading}>
                                                    <FiChevronRight size={14} />
                                                </Button>
                                            </HStack>
                                        )}
                                    </Flex>

                                    {/* Table */}
                                    <Box borderWidth={1} borderColor="gray.200" borderRadius="md" overflow="hidden">
                                        <TableHeader />
                                        {issues.map((issue, idx) => (
                                            <IssueRow
                                                key={`${issue.transaction_id}-${issue.issue_type}-${idx}`}
                                                issue={issue}
                                                assets={assets}
                                                accounts={accounts}
                                                onFixed={handleFixComplete}
                                                onAssetsUpdated={onAssetsUpdated}
                                                onAccountsUpdated={onAccountsUpdated}
                                                onTransactionClick={(txId) => {
                                                    setSelectedTransactionId(txId);
                                                    setIsTransactionDrawerOpen(true);
                                                }}
                                            />
                                        ))}
                                    </Box>

                                    {/* Bottom pagination */}
                                    {totalPages > 1 && (
                                        <Flex justify="center" pt={2}>
                                            <HStack gap={2}>
                                                <Button size="xs" variant="outline" onClick={() => fetchIssues(activeTab, page - 1)} disabled={page === 1 || isLoading}>
                                                    <FiChevronLeft size={12} /> Prev
                                                </Button>
                                                <Text fontSize="xs" color="gray.500">Page {page} of {totalPages}</Text>
                                                <Button size="xs" variant="outline" onClick={() => fetchIssues(activeTab, page + 1)} disabled={page === totalPages || isLoading}>
                                                    Next <FiChevronRight size={12} />
                                                </Button>
                                            </HStack>
                                        </Flex>
                                    )}
                                </>
                            )}

                            {/* No issues message for missing-data tab */}
                            {activeTab === 'missing-data' && !hasIssues && !allClear && issuesTotal === 0 && (
                                <Box p={3} bg="gray.50" borderRadius="md" textAlign="center">
                                    <Text fontSize="xs" color="gray.600">
                                        No data mapping issues. Review pending transactions or bundle suggestions above.
                                    </Text>
                                </Box>
                            )}

                            {/* Assets Linkage tab content */}
                            {activeTab === 'assets-linkage' && (
                                <AssetLinkageTable
                                    assets={assets}
                                    onFixed={handleFixComplete}
                                    onAssetsUpdated={onAssetsUpdated}
                                />
                            )}

                            {/* Accounts Linkage tab content */}
                            {activeTab === 'accounts-linkage' && (
                                <Box>
                                    <AccountMappingPanel
                                        mode="issues-only"
                                        includeDismissed={showDismissedMappings}
                                        onDismissedChange={setShowDismissedMappings}
                                    />
                                </Box>
                            )}

                            {/* Duplicates tab content */}
                            {activeTab === 'duplicates' && (
                                <Box>
                                    {(data.duplicate_count || 0) > 0 ? (
                                        <DuplicateResolutionPanel compactMode={true} />
                                    ) : (
                                        <Box p={3} bg="green.50" borderRadius="md" textAlign="center">
                                            <Text fontSize="sm" color="green.700">
                                                No duplicate transactions found! ✓
                                            </Text>
                                        </Box>
                                    )}
                                </Box>
                            )}

                            {/* Pending tab content */}
                            {activeTab === 'pending' && (
                                <Box>
                                    {data.pending_count > 0 ? (
                                        <TransactionsTable
                                            tableId="dataHealth-pending"
                                            filters={{ ...defaultFilterState, reviewStatus: ['pending'] }}
                                            showFilters={false}
                                            compact={true}
                                        />
                                    ) : (
                                        <Box p={3} bg="green.50" borderRadius="md" textAlign="center">
                                            <Text fontSize="sm" color="green.700">
                                                All transactions reviewed! ✓
                                            </Text>
                                        </Box>
                                    )}
                                </Box>
                            )}
                        </VStack>
                    )}
                </Box>
            </Box>

            {/* Transaction Detail Drawer */}
            <TransactionDetailDrawer
                transactionId={selectedTransactionId}
                isOpen={isTransactionDrawerOpen}
                onClose={() => {
                    setIsTransactionDrawerOpen(false);
                    setSelectedTransactionId(null);
                }}
                accounts={accounts}
            />
        </>
    );
};

export default DataHealthCheckDrawer;
