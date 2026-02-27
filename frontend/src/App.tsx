
import React, { Suspense, useEffect, useState, useCallback } from 'react';
import { Box, Container, Heading, Tabs, Text, HStack, Badge, Center, Spinner, Flex, Button } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { TestModeBanner } from './components/TestModeBanner';
import { API_URL, SyncJobProgress, ConnectorProgress, Account, Asset, BundleSuggestion } from './types';
import { DataHealthProvider, useDataHealth } from './contexts/DataHealthContext';
import { defaultFilterState } from './components/TransactionFilters';
import { FiActivity, FiCheckCircle } from 'react-icons/fi';
import { DataHealthCheckDrawer } from './components/DataHealthCheckDrawer';
import { useAssets } from './hooks/useAssets';

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
            gcTime: 60_000, // Garbage-collect unused cache entries after 1 minute
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
    const { validationSummary, refreshHealthData } = useDataHealth();
    // Setup status for Setup tab badge
    const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
    // Sync job status for Sync tab badge
    const [syncStatus, setSyncStatus] = useState<SyncJobProgress | null>(null);
    // Data health drawer state
    const [isHealthCheckOpen, setIsHealthCheckOpen] = useState(false);
    const [healthCheckRefreshTrigger, setHealthCheckRefreshTrigger] = useState(0);
    const { assets, refetchAssets } = useAssets();
    const [accounts, setAccounts] = useState<Account[]>([]);

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

    // Fetch accounts for health check drawer
    const fetchAccounts = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/accounts/`);
            if (response.ok) {
                const data = await response.json();
                setAccounts(data);
            }
        } catch (err) {
            console.error('Failed to fetch accounts:', err);
        }
    }, []);

    // Fetch accounts when health check opens
    useEffect(() => {
        if (isHealthCheckOpen) {
            fetchAccounts();
        }
    }, [isHealthCheckOpen, fetchAccounts]);

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

    return (
        <Box minH="100vh" bg="gray.50">
            <TestModeBanner />
            <Container maxW="6xl" py={8}>
                <Heading as="h1" size="xl" mb={4} textAlign="center" color="blue.700">
                    Trades Exporter
                </Heading>

                {/* Workflow indicator */}
                <HStack justify="center" mb={6} flexWrap="wrap" gap={2}>
                    <Badge colorScheme="gray" px={2} py={1}>1. Setup</Badge>
                    <Text color="gray.400">→</Text>
                    <Badge colorScheme="blue" px={2} py={1}>2. Sync/Add</Badge>
                    <Text color="gray.400">→</Text>
                    <Badge colorScheme="orange" px={2} py={1}>3. Review</Badge>
                    <Text color="gray.400">→</Text>
                    <Badge colorScheme="green" px={2} py={1}>4. P&L</Badge>
                </HStack>

                <Tabs.Root defaultValue="setup" lazyMount unmountOnExit>
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

                            {/* Step 4: Analysis */}
                            <Tabs.Trigger value="pnl">📊 P&L</Tabs.Trigger>

                            {/* Reference */}
                            <Tabs.Trigger value="prices">📈 Prices</Tabs.Trigger>
                        </Box>

                        {/* Global Data Health Badge */}
                        <Box ml="auto" display="flex" alignItems="center" gap={2}>
                            {validationSummary && (
                                <Button
                                    variant="ghost"
                                    p={0}
                                    onClick={() => {
                                        refreshHealthData();
                                        setIsHealthCheckOpen(true);
                                    }}
                                    cursor="pointer"
                                    _hover={{ transform: 'scale(1.05)' }}
                                    transition="all 0.2s"
                                >
                                    {validationSummary.has_issues ? (
                                        <Badge colorPalette="orange" size="lg" variant="solid" px={3} py={1}>
                                            <Flex align="center" gap={1}>
                                                <FiActivity />
                                                <Text>Data Issues: {validationSummary.total_issues}</Text>
                                            </Flex>
                                        </Badge>
                                    ) : (
                                        <Badge colorPalette="green" size="lg" variant="subtle" px={3} py={1}>
                                            <Flex align="center" gap={1}>
                                                <FiCheckCircle />
                                                <Text>Data Healthy</Text>
                                            </Flex>
                                        </Badge>
                                    )}
                                </Button>
                            )}
                        </Box>
                    </Tabs.List>

                    {/* Step 1: Configuration */}
                    <Tabs.Content value="setup">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <UnifiedSetupView />
                        </Suspense>
                    </Tabs.Content>

                    {/* Step 2: Data Import */}
                    <Tabs.Content value="sync">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <SyncJobPanel />
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

                    {/* Step 4: Analysis */}
                    <Tabs.Content value="pnl">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <PnLPanel
                                onOpenHealthCheck={() => {
                                    refreshHealthData();
                                    setIsHealthCheckOpen(true);
                                }}
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
                {/* Global Data Health Check Drawer */}
                <DataHealthCheckDrawer
                    isOpen={isHealthCheckOpen}
                    onClose={() => setIsHealthCheckOpen(false)}
                    refreshTrigger={healthCheckRefreshTrigger}
                    assets={assets}
                    accounts={accounts}
                    onAssetsUpdated={refetchAssets}
                    onAccountsUpdated={fetchAccounts}
                    onIssueFixed={() => {
                        refreshHealthData();
                        setHealthCheckRefreshTrigger(prev => prev + 1);
                    }}
                />            </Container>
        </Box>
    );
};

const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
            <DataHealthProvider>
                <AppContent />
            </DataHealthProvider>
        </QueryClientProvider>
    );
};

export default App;