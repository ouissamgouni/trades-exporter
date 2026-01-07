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
    DataHealthCheckResponse, 
    TransactionIssue,
    IssueType,
    Asset,
    Account,
} from '../types';
import { TransactionTooltip } from './TransactionTooltip';
import { AssetSelector } from './AssetSelector';
import { AccountSelector } from './AccountSelector';
import { toaster } from './ui/toaster';

// =============================================================================
// Constants & Configuration
// =============================================================================

const ITEMS_PER_PAGE = 50;

// Column widths for table-like alignment
const COLS = {
    ID: '55px',
    DATE: '80px',
    TX: '110px',
    TYPE: '135px',
    VALUE: '85px',
    ACTION: '140px',
} as const;

// Issue type configuration
const ISSUE_CONFIG: Record<IssueType, { color: string; label: string }> = {
    asset: { color: 'red', label: 'Unlinked Base Asset' },
    account: { color: 'orange', label: 'Unlinked Account' },
    price_quote: { color: 'purple', label: 'Unlinked Price Asset' },
    fee_quote: { color: 'yellow', label: 'Unlinked Fee Asset' },
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



const formatQty = (qty: number): string => {
    if (qty >= 1_000_000) return `${(qty / 1_000_000).toFixed(1)}M`;
    if (qty >= 1_000) return `${(qty / 1_000).toFixed(1)}K`;
    if (qty >= 1) return qty.toFixed(2);
    if (qty >= 0.01) return qty.toFixed(4);
    return qty.toExponential(2);
};

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
}

const IssueRow: React.FC<IssueRowProps> = ({ 
    issue, assets, accounts, onFixed, onAssetsUpdated, onAccountsUpdated 
}) => {
    const [isFixed, setIsFixed] = useState(false);
    const [isApplying, setIsApplying] = useState(false);
    
    const config = ISSUE_CONFIG[issue.issue_type];
    const isAccountIssue = issue.issue_type === 'account';
    
    // API call to map raw asset/account
    const mapRawItem = async (id: number) => {
        const endpoint = isAccountIssue ? 'raw-accounts' : 'raw-assets';
        const idKey = isAccountIssue ? 'account_id' : 'asset_id';
        const createBody = isAccountIssue 
            ? { label: issue.raw_value, source: issue.source, account_id: id }
            : { symbol: issue.raw_value, source: issue.source, asset_id: id };
        
        const response = await fetch(
            `${API_URL}/${endpoint}/${encodeURIComponent(issue.source)}/${encodeURIComponent(issue.raw_value)}`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [idKey]: id }),
            }
        );
        
        // If not found, create it
        if (response.status === 404) {
            await fetch(`${API_URL}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createBody),
            });
        } else if (!response.ok) {
            throw new Error(`Failed to map ${isAccountIssue ? 'account' : 'asset'}`);
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
                        cursor="help"
                        _hover={{ textDecoration: 'underline' }}
                    >
                        #{issue.transaction_id}
                    </Text>
                </TransactionTooltip>
            </Box>
            
            {/* Date */}
            <Box w={COLS.DATE}>
                <Text color="gray.500">{formatDate(issue.date_time)}</Text>
            </Box>
            
            {/* Transaction */}
            <Box w={COLS.TX}>
                <Flex align="center" gap={1}>
                    <DirectionIcon direction={issue.direction} />
                    <Text truncate title={`${issue.quantity} ${issue.source_asset_symbol}`}>
                        {formatQty(issue.quantity)} {issue.source_asset_symbol}
                    </Text>
                </Flex>
            </Box>
            
            {/* Issue Type */}
            <Box w={COLS.TYPE}>
                <Badge size="xs" colorPalette={config.color} variant="subtle">
                    {config.label}
                </Badge>
            </Box>
            
            {/* Raw Value */}
            <Box w={COLS.VALUE}>
                <Text color="gray.600" truncate title={issue.raw_value}>
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
                ) : issue.suggestion && issue.raw_value ? (
                    <Button
                        size="xs"
                        colorPalette={suggestionColor}
                        variant={suggestionConfidence >= 0.9 ? 'solid' : 'outline'}
                        onClick={handleAcceptSuggestion}
                        disabled={isApplying}
                        title={`${Math.round(suggestionConfidence * 100)}% match`}
                        h="22px"
                        w="full"
                    >
                        {isApplying ? <Spinner size="xs" /> : <FiCheck size={10} />}
                        <Text ml={1} truncate>{issue.suggestion.name}</Text>
                    </Button>
                ) : (
                    <Box>
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
}) => {
    const [data, setData] = useState<DataHealthCheckResponse | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [page, setPage] = useState(1);
    const [isApplyingAll, setIsApplyingAll] = useState(false);

    // Fetch health check data
    const fetchData = useCallback(async (pageNum: number = 1) => {
        setIsLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({
                include_details: 'true',
                issues_page: pageNum.toString(),
                issues_per_page: ITEMS_PER_PAGE.toString(),
            });
            if (accountIds?.length) {
                params.set('account_ids', accountIds.join(','));
            }
            
            const response = await fetch(`${API_URL}/transactions/data-health-check?${params}`);
            if (!response.ok) throw new Error('Failed to fetch data health check');
            
            setData(await response.json());
            setPage(pageNum);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setIsLoading(false);
        }
    }, [accountIds]);

    // Fetch on open/refresh
    useEffect(() => {
        if (isOpen) fetchData(1);
    }, [isOpen, fetchData, refreshTrigger]);

    // Refresh after fix
    const handleFixComplete = useCallback(() => {
        setTimeout(() => {
            fetchData(page);
            onAssetsUpdated?.();
            onAccountsUpdated?.();
        }, 500);
    }, [page, fetchData, onAssetsUpdated, onAccountsUpdated]);

    // High confidence suggestions for bulk apply
    const highConfidenceIssues = (data?.issues_list ?? []).filter(
        i => i.suggestion && i.suggestion.confidence >= 0.9 && i.raw_value
    );

    // Apply all high-confidence suggestions
    const handleApplyAll = async () => {
        if (!highConfidenceIssues.length) return;
        
        setIsApplyingAll(true);
        try {
            // Group by type
            const assetIssues = highConfidenceIssues.filter(i => i.issue_type !== 'account');
            const accountIssues = highConfidenceIssues.filter(i => i.issue_type === 'account');
            
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
            
            // Map accounts individually (deduplicated)
            if (accountIssues.length) {
                const unique = new Map(accountIssues.map(i => [`${i.source}:${i.raw_value}`, i]));
                for (const issue of unique.values()) {
                    await fetch(
                        `${API_URL}/raw-accounts/${encodeURIComponent(issue.source)}/${encodeURIComponent(issue.raw_value)}`,
                        {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ account_id: issue.suggestion!.id }),
                        }
                    );
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

    const totalPages = data ? Math.ceil(data.issues_total_count / ITEMS_PER_PAGE) : 0;
    const hasIssues = (data?.issues_list?.length ?? 0) > 0;
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
                width="640px"
                maxW="95vw"
                bg="white"
                boxShadow="xl"
                zIndex={100}
                overflowY="auto"
                borderLeft="1px solid"
                borderColor="gray.200"
                onClick={(e) => e.stopPropagation()}
            >
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
                            onClick={() => fetchData(page)}
                            disabled={isLoading}
                            title="Refresh"
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
                                    <Text><b style={{color: 'var(--chakra-colors-green-600)'}}>{data.valid_count}</b> valid</Text>
                                    <Text><b style={{color: 'var(--chakra-colors-yellow-600)'}}>{data.pending_count}</b> pending</Text>
                                    <Text><b style={{color: 'var(--chakra-colors-red-600)'}}>{data.invalid_count}</b> invalid</Text>
                                </HStack>
                            </Flex>

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

                            {/* Issues Table */}
                            {hasIssues && (
                                <>
                                    {/* Header with pagination */}
                                    <Flex justify="space-between" align="center">
                                        <Text fontSize="xs" fontWeight="medium" color="gray.600">
                                            Data Issues ({data.issues_total_count})
                                        </Text>
                                        {totalPages > 1 && (
                                            <HStack gap={1}>
                                                <Button size="xs" variant="ghost" onClick={() => fetchData(page - 1)} disabled={page === 1 || isLoading}>
                                                    <FiChevronLeft size={14} />
                                                </Button>
                                                <Text fontSize="xs" color="gray.500">{page} / {totalPages}</Text>
                                                <Button size="xs" variant="ghost" onClick={() => fetchData(page + 1)} disabled={page === totalPages || isLoading}>
                                                    <FiChevronRight size={14} />
                                                </Button>
                                            </HStack>
                                        )}
                                    </Flex>

                                    {/* Table */}
                                    <Box borderWidth={1} borderColor="gray.200" borderRadius="md" overflow="hidden">
                                        <TableHeader />
                                        {data.issues_list!.map((issue, idx) => (
                                            <IssueRow
                                                key={`${issue.transaction_id}-${issue.issue_type}-${idx}`}
                                                issue={issue}
                                                assets={assets}
                                                accounts={accounts}
                                                onFixed={handleFixComplete}
                                                onAssetsUpdated={onAssetsUpdated}
                                                onAccountsUpdated={onAccountsUpdated}
                                            />
                                        ))}
                                    </Box>

                                    {/* Bottom pagination */}
                                    {totalPages > 1 && (
                                        <Flex justify="center" pt={2}>
                                            <HStack gap={2}>
                                                <Button size="xs" variant="outline" onClick={() => fetchData(page - 1)} disabled={page === 1 || isLoading}>
                                                    <FiChevronLeft size={12} /> Prev
                                                </Button>
                                                <Text fontSize="xs" color="gray.500">Page {page} of {totalPages}</Text>
                                                <Button size="xs" variant="outline" onClick={() => fetchData(page + 1)} disabled={page === totalPages || isLoading}>
                                                    Next <FiChevronRight size={12} />
                                                </Button>
                                            </HStack>
                                        </Flex>
                                    )}
                                </>
                            )}

                            {/* No issues but not all clear */}
                            {!hasIssues && !allClear && data.issues_total_count === 0 && (
                                <Box p={3} bg="gray.50" borderRadius="md" textAlign="center">
                                    <Text fontSize="xs" color="gray.600">
                                        No data mapping issues. Review pending transactions or bundle suggestions above.
                                    </Text>
                                </Box>
                            )}
                        </VStack>
                    )}
                </Box>
            </Box>
        </>
    );
};

export default DataHealthCheckDrawer;
