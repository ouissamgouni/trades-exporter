/**
 * DataHealthView
 *
 * Top-level "Health" tab showing data completeness issues for P&L calculations.
 * Transaction-centric view with table layout and inline fixing.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Heading, Spinner, Tabs, TabsList, TabsTrigger, Text } from './ui/primitives';
import {
    FiActivity,
    FiAlertCircle,
    FiCheckCircle,
    FiRefreshCw,
} from 'react-icons/fi';
import { useNavigate } from 'react-router-dom';
import {
    API_URL,
    TransactionStatusResponse,
    Account,
} from '../types';
import { toaster } from './ui/toaster';
import { TransactionDetailDrawer } from './TransactionDetailDrawer';
import { AssetLinkageTable } from './tables/wrappers/AssetLinkageTable';
import { MissingDataTable } from './tables/wrappers/MissingDataTable';
import { AccountsLinkageTable } from './tables/wrappers/AccountsLinkageTable';
import { DuplicateResolutionPanel } from './DuplicateResolutionPanel';
import { useAssets } from '../hooks/useAssets';
import { useDataHealth } from '../contexts/DataHealthContext';

// =============================================================================
// Main Component
// =============================================================================

export const DataHealthView: React.FC<{ accountIds?: number[] }> = ({ accountIds }) => {
    const navigate = useNavigate();
    const { refreshHealthData } = useDataHealth();
    const { assets, refetchAssets: onAssetsUpdated } = useAssets();
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [data, setData] = useState<TransactionStatusResponse | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'missing-data' | 'assets-linkage' | 'accounts-linkage' | 'duplicates'>('missing-data');
    const [tabAutoSelected, setTabAutoSelected] = useState(false);

    // Transaction detail drawer state
    const [selectedTransactionId, setSelectedTransactionId] = useState<number | null>(null);
    const [isTransactionDrawerOpen, setIsTransactionDrawerOpen] = useState(false);

    const onAccountsUpdated = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/accounts/`);
            if (response.ok) setAccounts(await response.json());
        } catch {
            // ignore
        }
    }, []);
    useEffect(() => { onAccountsUpdated(); }, [onAccountsUpdated]);

    const onIssueFixed = refreshHealthData;
    const onNavigateToPendingTransactions = () => navigate('/inbox');
    const onNavigateToBundleSuggestions = () => navigate('/inbox');

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

    useEffect(() => {
        fetchStatus();
    }, [activeTab, fetchStatus]);

    // On first load, open the first tab that has issues
    useEffect(() => {
        if (!data || tabAutoSelected) return;
        setTabAutoSelected(true);
        const firstWithIssues = (
            [
                ['missing-data', data.missing_data_issues_count],
                ['assets-linkage', data.linkage_issues_count],
                ['accounts-linkage', data.transfer_issues_count],
                ['duplicates', data.duplicate_count],
            ] as const
        ).find(([, count]) => (count || 0) > 0);
        if (firstWithIssues) setActiveTab(firstWithIssues[0]);
    }, [data, tabAutoSelected]);

    // Refresh after fix
    const handleFixComplete = useCallback(() => {
        setTimeout(() => {
            fetchStatus();
            onAssetsUpdated?.();
            onAccountsUpdated?.();
            onIssueFixed?.();
        }, 500);
    }, [fetchStatus, onAssetsUpdated, onAccountsUpdated, onIssueFixed]);

    const allClear = data && !data.has_issues && data.bundle_suggestions_count === 0;

    return (
        <>
            <div className="border border-gray-200 bg-white">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-3 py-2">
                    <div className="flex items-center gap-2">
                        <FiActivity size={16} />
                        <Heading as="h3" className="text-sm">Data Health Check</Heading>
                    </div>
                    <Button
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => {
                            fetchStatus();
                            refreshHealthData();
                        }}
                        disabled={isLoading}
                        title="Refresh all tabs"
                        aria-label="Refresh"
                    >
                        <FiRefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
                    </Button>
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

export default DataHealthView;
