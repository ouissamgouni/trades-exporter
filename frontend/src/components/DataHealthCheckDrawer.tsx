/**
 * DataHealthCheckDrawer
 * 
 * Slide-in drawer showing data completeness issues for P&L calculations.
 * Transaction-centric view with table layout and inline fixing.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Heading, Spinner, Tabs, TabsList, TabsTrigger, Text } from './ui/primitives';
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
            <div
                className="fixed inset-0 z-[99] bg-black/40"
                onClick={onClose}
            />

            {/* Panel: bottom sheet on mobile, right-side panel on sm+ */}
            <div
                className="fixed inset-x-0 bottom-0 top-auto z-[100] max-h-[90vh] w-full max-w-full overflow-y-auto border-t border-gray-200 bg-white shadow-xl sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-0 sm:max-h-none sm:w-[var(--sheet-w)] sm:max-w-[95vw] sm:border-l sm:border-t-0"
                style={{ ['--sheet-w' as string]: `${drawerWidth}px` }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Resize Handle (desktop only) */}
                <div
                    className={`absolute bottom-0 left-0 top-0 z-[1] hidden w-[4px] cursor-col-resize transition-colors hover:bg-blue-200 sm:block ${isResizing ? 'bg-blue-400' : 'bg-transparent'}`}
                    onMouseDown={handleResizeStart}
                />

                {/* Header */}
                <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-gray-200 bg-gray-50 px-3 py-2">
                    <div className="flex items-center gap-2">
                        <FiActivity size={16} />
                        <Heading as="h3" className="text-sm">Data Health Check</Heading>
                    </div>
                    <div className="flex gap-1">
                        <Button
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => {
                                fetchStatus();
                            }}
                            disabled={isLoading}
                            title="Refresh all tabs"
                        >
                            <FiRefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
                        </Button>
                        <Button variant="ghost" className="h-7 w-7 p-0" onClick={onClose}>
                            <FiX size={16} />
                        </Button>
                    </div>
                </div>

                {/* Content */}
                <div className="p-3">
                    {/* Loading */}
                    {isLoading && !data && (
                        <div className="flex justify-center py-8">
                            <Spinner size="md" />
                        </div>
                    )}

                    {/* Error */}
                    {error && (
                        <div className="border border-red-200 bg-red-50 p-3">
                            <div className="flex items-center gap-2">
                                <FiAlertCircle color="#E53E3E" />
                                <span className="text-sm text-red-700">{error}</span>
                            </div>
                        </div>
                    )}

                    {data && (
                        <div className="flex flex-col gap-3">
                            {/* Summary */}
                            <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-50 p-2 text-xs">
                                <span className="font-medium text-gray-600">
                                    Transaction Status
                                </span>
                                <div className="flex gap-3">
                                    <span><b>{data.total_count}</b> total</span>
                                    <span><b style={{ color: '#2F855A' }}>{data.valid_count}</b> valid</span>
                                    <span><b style={{ color: '#B7791F' }}>{data.pending_count}</b> pending</span>
                                    <span><b style={{ color: '#C53030' }}>{data.invalid_count}</b> invalid</span>
                                </div>
                            </div>

                            {/* Tabs for different issue types */}
                            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
                                <TabsList>
                                    <TabsTrigger value="missing-data">
                                        Missing Data
                                        {data.missing_data_issues_count > 0 && (
                                            <Badge colorScheme="red" className="ml-1 text-[10px]">
                                                {data.missing_data_issues_count}
                                            </Badge>
                                        )}
                                    </TabsTrigger>
                                    <TabsTrigger value="assets-linkage">
                                        Assets Linkage
                                        {((data.linkage_issues_count || 0) > 0) && (
                                            <Badge colorScheme="purple" className="ml-1 text-[10px]">
                                                {data.linkage_issues_count}
                                            </Badge>
                                        )}
                                    </TabsTrigger>
                                    <TabsTrigger value="accounts-linkage">
                                        Accounts Linkage
                                        {(data.transfer_issues_count || 0) > 0 && (
                                            <Badge colorScheme="orange" className="ml-1 text-[10px]">
                                                {data.transfer_issues_count}
                                            </Badge>
                                        )}
                                    </TabsTrigger>
                                    <TabsTrigger value="pending">
                                        Pending
                                        {data.pending_count > 0 && (
                                            <Badge colorScheme="yellow" className="ml-1 text-[10px]">
                                                {data.pending_count}
                                            </Badge>
                                        )}
                                    </TabsTrigger>
                                    <TabsTrigger value="duplicates">
                                        Duplicates
                                        {(data.duplicate_count || 0) > 0 && (
                                            <Badge colorScheme="red" className="ml-1 text-[10px]">
                                                {data.duplicate_count}
                                            </Badge>
                                        )}
                                    </TabsTrigger>
                                </TabsList>
                            </Tabs>

                            {/* All Clear */}
                            {allClear && (
                                <div className="border border-green-200 bg-green-50 p-4 text-center">
                                    <FiCheckCircle size={32} color="#38A169" style={{ margin: '0 auto 8px' }} />
                                    <Text className="block font-bold text-green-700">All Clear! ✓</Text>
                                    <Text className="block text-xs text-green-600">All transactions have complete data.</Text>
                                </div>
                            )}

                            {/* Quick Actions */}
                            {!allClear && (
                                <div className="flex flex-wrap gap-2">
                                    {data.pending_count > 0 && onNavigateToPendingTransactions && (
                                        <Button colorScheme="blue" variant="outline" className="h-6 px-2 text-xs" onClick={onNavigateToPendingTransactions}>
                                            <Badge colorScheme="blue" className="mr-1 text-[10px]">{data.pending_count}</Badge>
                                            Pending Review
                                        </Button>
                                    )}
                                    {data.bundle_suggestions_count > 0 && onNavigateToBundleSuggestions && (
                                        <Button
                                            colorScheme="gray"
                                            variant="outline"
                                            className="h-6 border-teal-300 px-2 text-xs text-teal-700 hover:bg-teal-50"
                                            onClick={onNavigateToBundleSuggestions}
                                        >
                                            <Badge colorScheme="green" className="mr-1 text-[10px]">{data.bundle_suggestions_count}</Badge>
                                            Bundle Suggestions
                                        </Button>
                                    )}
                                </div>
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
                                <div>
                                    {(data.duplicate_count || 0) > 0 ? (
                                        <DuplicateResolutionPanel compactMode={true} />
                                    ) : (
                                        <div className="bg-green-50 p-3 text-center">
                                            <span className="text-sm text-green-700">
                                                No duplicate transactions found! ✓
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Pending tab content */}
                            {activeTab === 'pending' && (
                                <div>
                                    {data.pending_count > 0 ? (
                                        <TransactionsTable
                                            tableId="dataHealth-pending"
                                            filters={{ ...defaultFilterState, reviewStatus: ['pending'] }}
                                            showFilters={false}
                                            compact={true}
                                        />
                                    ) : (
                                        <div className="bg-green-50 p-3 text-center">
                                            <span className="text-sm text-green-700">
                                                All transactions reviewed! ✓
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

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
