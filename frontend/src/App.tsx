
import React, { Suspense, useEffect, useState } from 'react';
import { Box, Container, Heading, Tabs, Text, HStack, Badge, Center, Spinner, Flex } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { API_URL, SyncJobProgress, ConnectorProgress, BundleSuggestion } from './types';
import { DataHealthProvider, useDataHealth } from './contexts/DataHealthContext';
import logoSrc from './assets/logo.png';
import { AssetDetailPanelProvider } from './contexts/AssetDetailPanelContext';
import { AssetDetailSlidePanel } from './components/AssetDetailSlidePanel';
import { QaTestPlanProvider, useQaPinnedWidth } from './components/QaTestPlanPanel';
import { StatusBar, STATUS_BAR_HEIGHT_PX } from './components/StatusBar';
import type { PnLCalcStatus } from './components/pnl/types';

// Setup status interface
interface SetupStatus {
    accounts_configured: boolean;
    accounts_count: number;
    connectors_configured: boolean;
    connectors_count: number;
    assets_configured: boolean;
    assets_count: number;
    base_currency_set: boolean;
    base_currency_symbol: string | null;
    unmapped_raw_assets_count?: number;
    unmapped_raw_accounts_count?: number;
}

// Create a client with sensible defaults
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000, // Data considered fresh for 30 seconds
            gcTime: 5 * 60_000, // Garbage-collect unused cache entries after 5 minutes
            refetchOnWindowFocus: false, // Don't refetch on tab focus
            retry: 1, // Only retry once on failure
        },
    },
});

// Lazy load all main tab components for better initial load performance
const UnifiedSetupView = React.lazy(() => import('./components/UnifiedSetupView'));
const SyncJobPanel = React.lazy(() => import('./components/SyncJobPanel').then(m => ({ default: m.SyncJobPanel })));
const AddImportPanel = React.lazy(() => import('./components/AddImportPanel').then(m => ({ default: m.AddImportPanel })));
const InboxView = React.lazy(() => import('./components/InboxView').then(m => ({ default: m.InboxView })));
const AllTransactionsView = React.lazy(() => import('./components/AllTransactionsView').then(m => ({ default: m.AllTransactionsView })));
const TransactionsTable = React.lazy(() => import('./components/TransactionsTable').then(m => ({ default: m.TransactionsTable })));
const TimelineSection = React.lazy(() => import('./components/TimelineSection'));
const PositionsView = React.lazy(() => import('./components/PositionsView'));
const PnLPanel = React.lazy(() => import('./components/PnLPanel').then(m => ({ default: m.PnLPanel })));
const PricesViewer = React.lazy(() => import('./components/PricesViewer').then(m => ({ default: m.PricesViewer })));

// Loading fallback component
const TabLoadingFallback = () => (
    <Center h="200px">
        <Spinner size="xl" color="blue.500" />
    </Center>
);

const AppContent = () => {
    // Use global data health context
    const { validationSummary } = useDataHealth();
    // Setup status for Setup tab badge
    const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
    // Sync job status for Sync tab badge
    const [syncStatus, setSyncStatus] = useState<SyncJobProgress | null>(null);

    // Fetch bundle suggestions count for Inbox tab badge
    const { data: bundleSuggestions = [] } = useQuery({
        queryKey: ['bundleSuggestions'],
        queryFn: async () => {
            const response = await fetch(`${API_URL}/bundles/suggestions?max_suggestions=100`);
            if (!response.ok) return [];
            return response.json() as Promise<BundleSuggestion[]>;
        },
    });

    // Fetch setup status for Setup tab badge
    useEffect(() => {
        const fetchSetupStatus = async () => {
            try {
                const response = await fetch(`${API_URL}/config/setup-status`);
                if (response.ok) {
                    const data: SetupStatus = await response.json();
                    setSetupStatus(data);
                }
            } catch (err) {
                console.error('Failed to fetch setup status:', err);
            }
        };
        fetchSetupStatus();
        // Refresh every 30 seconds
        const interval = setInterval(fetchSetupStatus, 30000);
        return () => clearInterval(interval);
    }, []);

    // Fetch sync job status for Sync tab badge
    useEffect(() => {
        const fetchSyncStatus = async () => {
            try {
                const response = await fetch(`${API_URL}/sync-job/status`);
                if (response.ok) {
                    const data: SyncJobProgress = await response.json();
                    setSyncStatus(data);
                }
            } catch (err) {
                console.error('Failed to fetch sync status:', err);
            }
        };
        fetchSyncStatus();
        // Refresh every 30 seconds (more frequently when running)
        const interval = setInterval(fetchSyncStatus, 30000);
        return () => clearInterval(interval);
    }, []);

    // Check if there are setup issues
    const [activeTab, setActiveTab] = useState('setup');

    // Lightweight P&L status polling for tab badge (30s interval)
    const [pnlCalcStatus, setPnlCalcStatus] = useState<PnLCalcStatus>('idle');
    useEffect(() => {
        const fetchPnlStatus = async () => {
            try {
                const response = await fetch(`${API_URL}/pnl/calculation-status`);
                if (response.ok) {
                    const data = await response.json();
                    setPnlCalcStatus(data.status as PnLCalcStatus);
                }
            } catch { /* ignore */ }
        };
        fetchPnlStatus();
        const interval = setInterval(fetchPnlStatus, 30_000);
        return () => clearInterval(interval);
    }, []);

    const hasSetupIssues = setupStatus && (
        !setupStatus.base_currency_set ||
        setupStatus.accounts_count === 0 ||
        (setupStatus.unmapped_raw_accounts_count ?? 0) > 0 ||
        (setupStatus.unmapped_raw_assets_count ?? 0) > 0
    );

    // Check if there are sync failures (persists until successful sync)
    const failedConnectorsCount = syncStatus?.connector_statuses
        ? Object.values(syncStatus.connector_statuses).filter(
            (c: ConnectorProgress) => c.status === 'failed'
        ).length
        : 0;
    const hasSyncFailures = syncStatus?.status === 'failed' || failedConnectorsCount > 0;

    const qaPinnedWidth = useQaPinnedWidth();

    return (
        <Box minH="100vh" bg="gray.50" marginRight={qaPinnedWidth ? `${qaPinnedWidth}px` : undefined} transition="margin-right 0.2s ease" pb={`${STATUS_BAR_HEIGHT_PX + 4}px`}>
            <Container maxW="8xl" py={2}>
                {/* Compact header: Title (left) + Workflow (center) + Data Health (right) */}
                <Flex align="center" justify="space-between" mb={2} flexWrap="wrap" gap={2}>
                    <Heading as="h1" size="md" color="blue.700" whiteSpace="nowrap">
                        <Flex align="center" gap={1.5} display="inline-flex">
                            <img src={logoSrc} alt="TradeTrail" width={24} height={24} />
                            TradeTrail
                        </Flex>
                    </Heading>

                    <HStack gap={1.5} flexWrap="wrap">
                        <Badge colorScheme="gray" size="sm" px={1.5} py={0.5}>1. Setup</Badge>
                        <Text color="gray.400" fontSize="xs">→</Text>
                        <Badge colorScheme="blue" size="sm" px={1.5} py={0.5}>2. Sync/Add</Badge>
                        <Text color="gray.400" fontSize="xs">→</Text>
                        <Badge colorScheme="orange" size="sm" px={1.5} py={0.5}>3. Review</Badge>
                        <Text color="gray.400" fontSize="xs">→</Text>
                        <Badge colorScheme="green" size="sm" px={1.5} py={0.5}>4. P&L</Badge>
                    </HStack>

                </Flex>

                <Tabs.Root defaultValue="setup" lazyMount value={activeTab} onValueChange={(e) => setActiveTab(e.value)}>
                    <Tabs.List>
                        <Box flex="1" display="flex" alignItems="center">
                            {/* Step 1: Configuration */}
                            <Tabs.Trigger value="setup">
                                <Flex align="center" gap={1}>
                                    ⚙️ Setup
                                    {hasSetupIssues && (
                                        <Badge colorPalette="orange" size="sm" variant="solid" ml={1}>
                                            ⚠
                                        </Badge>
                                    )}
                                </Flex>
                            </Tabs.Trigger>

                            {/* Step 2: Data Import */}
                            <Tabs.Trigger value="sync">
                                <Flex align="center" gap={1}>
                                    🔄 Sync
                                    {hasSyncFailures && (
                                        <Badge colorPalette="red" size="sm" variant="solid" ml={1}>
                                            {failedConnectorsCount > 0 ? `${failedConnectorsCount} failed` : '⚠'}
                                        </Badge>
                                    )}
                                </Flex>
                            </Tabs.Trigger>
                            <Tabs.Trigger value="add-transaction">➕ Add / Import</Tabs.Trigger>

                            {/* Step 3: Review */}
                            <Tabs.Trigger value="inbox">
                                <Flex align="center" gap={1}>
                                    📥 Inbox
                                    {validationSummary && validationSummary.pending_count > 0 && (
                                        <Badge colorPalette="blue" size="sm" ml={1}>
                                            {validationSummary.pending_count}
                                        </Badge>
                                    )}
                                    {bundleSuggestions.length > 0 && (
                                        <Badge colorPalette="teal" size="sm" ml={1}>
                                            {bundleSuggestions.length} 💡
                                        </Badge>
                                    )}
                                </Flex>
                            </Tabs.Trigger>
                            <Tabs.Trigger value="all-transactions">
                                📋 All
                            </Tabs.Trigger>
                            <Tabs.Trigger value="timeline">📅 Timeline</Tabs.Trigger>
                            <Tabs.Trigger value="positions">🎯 Positions</Tabs.Trigger>

                            {/* Step 4: Analysis */}
                            <Tabs.Trigger value="pnl">
                                <Flex align="center" gap={1}>
                                    📊 P&L
                                    {pnlCalcStatus === 'stale' && (
                                        <Box w={2} h={2} borderRadius="full" bg="orange.400" />
                                    )}
                                    {pnlCalcStatus === 'calculating' && (
                                        <Spinner size="xs" />
                                    )}
                                </Flex>
                            </Tabs.Trigger>

                            {/* Reference */}
                            <Tabs.Trigger value="prices">📈 Prices</Tabs.Trigger>
                        </Box>

                    </Tabs.List>

                    {/* Step 1: Configuration */}
                    <Tabs.Content value="setup">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <UnifiedSetupView isActive={activeTab === 'setup'} />
                        </Suspense>
                    </Tabs.Content>

                    {/* Step 2: Data Import */}
                    <Tabs.Content value="sync">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <SyncJobPanel isActive={activeTab === 'sync'} />
                        </Suspense>
                    </Tabs.Content>
                    <Tabs.Content value="add-transaction">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <AddImportPanel />
                        </Suspense>
                    </Tabs.Content>

                    {/* Step 3: Review */}
                    <Tabs.Content value="inbox">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <InboxView />
                        </Suspense>
                    </Tabs.Content>
                    <Tabs.Content value="all-transactions">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <AllTransactionsView />
                        </Suspense>
                    </Tabs.Content>
                    <Tabs.Content value="timeline">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <TimelineSection />
                        </Suspense>
                    </Tabs.Content>
                    <Tabs.Content value="positions">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <PositionsView />
                        </Suspense>
                    </Tabs.Content>

                    {/* Step 4: Analysis */}
                    <Tabs.Content value="pnl">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <PnLPanel
                                isActive={activeTab === 'pnl'}
                            />
                        </Suspense>
                    </Tabs.Content>

                    {/* Reference */}
                    <Tabs.Content value="prices">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <PricesViewer />
                        </Suspense>
                    </Tabs.Content>
                </Tabs.Root>
            </Container>
            <StatusBar />
        </Box>
    );
};

const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
            <AssetDetailPanelProvider>
                <DataHealthProvider>
                    <QaTestPlanProvider>
                        <AppContent />
                        <AssetDetailSlidePanel />
                    </QaTestPlanProvider>
                </DataHealthProvider>
            </AssetDetailPanelProvider>
        </QueryClientProvider>
    );
};

export default App;