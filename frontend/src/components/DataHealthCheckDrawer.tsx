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
    FiCheckCircle,
    FiRefreshCw,
    FiX,
} from 'react-icons/fi';
import {
    API_URL,
    TransactionStatusResponse,
    Asset,
    Account,
} from '../types';
import { toaster } from './ui/toaster';
import { TransactionDetailDrawer } from './TransactionDetailDrawer';
import { TransactionsTable } from './TransactionsTable';
import { AssetLinkageTable } from './tables/wrappers/AssetLinkageTable';
import { MissingDataTable } from './tables/wrappers/MissingDataTable';
import { AccountsLinkageTable } from './tables/wrappers/AccountsLinkageTable';
import { defaultFilterState } from './TransactionFilters';
import { DuplicateResolutionPanel } from './DuplicateResolutionPanel';

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
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'missing-data' | 'assets-linkage' | 'accounts-linkage' | 'pending' | 'duplicates'>('missing-data');

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

    // Fetch on open/refresh
    useEffect(() => {
        if (isOpen) {
            fetchStatus();
        }
    }, [isOpen, activeTab, fetchStatus, refreshTrigger]);

    // Refresh after fix
    const handleFixComplete = useCallback(() => {
        setTimeout(() => {
            fetchStatus();
            onAssetsUpdated?.();
            onAccountsUpdated?.();
            onIssueFixed?.();
        }, 500);
    }, [fetchStatus, onAssetsUpdated, onAccountsUpdated, onIssueFixed]);

    if (!isOpen) return null;

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
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                                fetchStatus();
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
                                        {(data.transfer_issues_count || 0) > 0 && (
                                            <Badge ml={1} size="xs" colorPalette="orange">
                                                {data.transfer_issues_count}
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

                            {/* Missing Data tab content */}
                            {activeTab === 'missing-data' && (
                                <MissingDataTable
                                    onFixed={handleFixComplete}
                                    assets={assets}
                                    accounts={accounts}
                                    onAssetsUpdated={onAssetsUpdated}
                                    onAccountsUpdated={onAccountsUpdated}
                                />
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
                                <AccountsLinkageTable
                                    onFixed={handleFixComplete}
                                />
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
