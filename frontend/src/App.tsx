
import React, { Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Badge, Spinner, Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/primitives';
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
    <div className="flex h-[200px] items-center justify-center">
        <Spinner size="lg" className="text-blue-500" />
    </div>
);

// ── Tab routing config ──
// Top-level tab ids (nav order) and, for tabs with a first-level sub-tab, the
// set of valid sub-tab values + the default sub-tab to redirect to.
const KNOWN_TABS = [
    'setup', 'sync', 'add-transaction', 'inbox', 'all-transactions',
    'timeline', 'positions', 'pnl', 'prices',
] as const;
type TabId = typeof KNOWN_TABS[number];

const TAB_SUBTABS: Partial<Record<TabId, readonly string[]>> = {
    setup: ['accounts', 'assets', 'pnl-defaults'],
    sync: ['control', 'history'],
    'add-transaction': ['manual', 'import'],
    pnl: ['portfolio', 'tax'],
};

const DEFAULT_SUBTAB: Partial<Record<TabId, string>> = {
    setup: 'accounts',
    sync: 'control',
    'add-transaction': 'manual',
    pnl: 'portfolio',
};

const DEFAULT_TAB: TabId = 'setup';
const DEFAULT_ROUTE = `/${DEFAULT_TAB}/${DEFAULT_SUBTAB[DEFAULT_TAB]}`;

function isKnownTab(value: string | undefined): value is TabId {
    return !!value && (KNOWN_TABS as readonly string[]).includes(value);
}

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

    // Route-driven tab/sub-tab state (replaces local useState so tabs are deep-linkable)
    const navigate = useNavigate();
    const { tab: rawTab, subtab: rawSubtab } = useParams<{ tab?: string; subtab?: string }>();
    const activeTab: TabId = isKnownTab(rawTab) ? rawTab : DEFAULT_TAB;
    const allowedSubtabs = TAB_SUBTABS[activeTab];
    const activeSubtab = allowedSubtabs
        ? (rawSubtab && allowedSubtabs.includes(rawSubtab) ? rawSubtab : DEFAULT_SUBTAB[activeTab]!)
        : undefined;

    // Redirect to the canonical URL when the current path doesn't match a known
    // tab/sub-tab (unknown tab, missing/invalid sub-tab, or a stray sub-tab on a
    // tab that doesn't have one).
    useEffect(() => {
        if (!isKnownTab(rawTab)) {
            navigate(DEFAULT_ROUTE, { replace: true });
            return;
        }
        if (allowedSubtabs) {
            if (!rawSubtab || !allowedSubtabs.includes(rawSubtab)) {
                navigate(`/${activeTab}/${DEFAULT_SUBTAB[activeTab]}`, { replace: true });
            }
        } else if (rawSubtab) {
            navigate(`/${activeTab}`, { replace: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rawTab, rawSubtab, activeTab, allowedSubtabs, navigate]);

    const handleTabChange = (newTab: string) => {
        const defaultSub = DEFAULT_SUBTAB[newTab as TabId];
        navigate(defaultSub ? `/${newTab}/${defaultSub}` : `/${newTab}`);
    };

    const navigateSubtab = (newSubtab: string) => navigate(`/${activeTab}/${newSubtab}`);

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
        <div
            className="min-h-screen bg-slate-50 transition-[margin-right] duration-200 ease-in-out"
            style={{
                marginRight: qaPinnedWidth ? `${qaPinnedWidth}px` : undefined,
                paddingBottom: `${STATUS_BAR_HEIGHT_PX + 4}px`,
            }}
        >
            <div className="mx-auto max-w-[1400px] px-4 py-2">
                {/* Compact header: Title (left) + Workflow (center) + Data Health (right) */}
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h1 className="whitespace-nowrap text-xl font-bold text-blue-700">
                        <span className="inline-flex items-center gap-1.5">
                            <img src={logoSrc} alt="TradeTrail" width={24} height={24} />
                            TradeTrail
                        </span>
                    </h1>

                    <div className="flex flex-wrap items-center gap-1.5">
                        <Badge colorScheme="gray" className="px-1.5 py-0.5">1. Setup</Badge>
                        <span className="text-xs text-slate-400">→</span>
                        <Badge colorScheme="blue" className="px-1.5 py-0.5">2. Sync/Add</Badge>
                        <span className="text-xs text-slate-400">→</span>
                        <Badge colorScheme="orange" className="px-1.5 py-0.5">3. Review</Badge>
                        <span className="text-xs text-slate-400">→</span>
                        <Badge colorScheme="green" className="px-1.5 py-0.5">4. P&L</Badge>
                    </div>

                </div>

                <Tabs value={activeTab} onValueChange={handleTabChange}>
                    <TabsList>
                        {/* Step 1: Configuration */}
                        <TabsTrigger value="setup">
                            <span className="inline-flex items-center gap-1">
                                ⚙️ Setup
                                {hasSetupIssues && (
                                    <Badge colorScheme="orange" className="ml-1">
                                        ⚠
                                    </Badge>
                                )}
                            </span>
                        </TabsTrigger>

                        {/* Step 2: Data Import */}
                        <TabsTrigger value="sync">
                            <span className="inline-flex items-center gap-1">
                                🔄 Sync
                                {hasSyncFailures && (
                                    <Badge colorScheme="red" className="ml-1">
                                        {failedConnectorsCount > 0 ? `${failedConnectorsCount} failed` : '⚠'}
                                    </Badge>
                                )}
                            </span>
                        </TabsTrigger>
                        <TabsTrigger value="add-transaction">➕ Add / Import</TabsTrigger>

                        {/* Step 3: Review */}
                        <TabsTrigger value="inbox">
                            <span className="inline-flex items-center gap-1">
                                📥 Inbox
                                {validationSummary && validationSummary.pending_count > 0 && (
                                    <Badge colorScheme="blue" className="ml-1">
                                        {validationSummary.pending_count}
                                    </Badge>
                                )}
                                {bundleSuggestions.length > 0 && (
                                    <Badge colorScheme="green" className="ml-1">
                                        {bundleSuggestions.length} 💡
                                    </Badge>
                                )}
                            </span>
                        </TabsTrigger>
                        <TabsTrigger value="all-transactions">
                            📋 All
                        </TabsTrigger>
                        <TabsTrigger value="timeline">📅 Timeline</TabsTrigger>
                        <TabsTrigger value="positions">🎯 Positions</TabsTrigger>

                        {/* Step 4: Analysis */}
                        <TabsTrigger value="pnl">
                            <span className="inline-flex items-center gap-1">
                                📊 P&L
                                {pnlCalcStatus === 'stale' && (
                                    <span className="h-2 w-2 rounded-full bg-orange-400" />
                                )}
                                {pnlCalcStatus === 'calculating' && (
                                    <Spinner size="xs" />
                                )}
                            </span>
                        </TabsTrigger>

                        {/* Reference */}
                        <TabsTrigger value="prices">📈 Prices</TabsTrigger>
                    </TabsList>

                    {/* Step 1: Configuration */}
                    <TabsContent value="setup">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <UnifiedSetupView
                                isActive={activeTab === 'setup'}
                                activePrimaryTab={activeSubtab as string}
                                onPrimaryTabChange={navigateSubtab}
                            />
                        </Suspense>
                    </TabsContent>

                    {/* Step 2: Data Import */}
                    <TabsContent value="sync">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <SyncJobPanel
                                isActive={activeTab === 'sync'}
                                activeTab={activeSubtab as 'control' | 'history'}
                                onActiveTabChange={navigateSubtab}
                            />
                        </Suspense>
                    </TabsContent>
                    <TabsContent value="add-transaction">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <AddImportPanel
                                activeTab={activeSubtab as 'manual' | 'import'}
                                onActiveTabChange={navigateSubtab}
                            />
                        </Suspense>
                    </TabsContent>

                    {/* Step 3: Review */}
                    <TabsContent value="inbox">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <InboxView />
                        </Suspense>
                    </TabsContent>
                    <TabsContent value="all-transactions">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <AllTransactionsView />
                        </Suspense>
                    </TabsContent>
                    <TabsContent value="timeline">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <TimelineSection />
                        </Suspense>
                    </TabsContent>
                    <TabsContent value="positions">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <PositionsView />
                        </Suspense>
                    </TabsContent>

                    {/* Step 4: Analysis */}
                    <TabsContent value="pnl">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <PnLPanel
                                isActive={activeTab === 'pnl'}
                                subtab={activeSubtab as 'portfolio' | 'tax'}
                                onSubtabChange={navigateSubtab}
                            />
                        </Suspense>
                    </TabsContent>

                    {/* Reference */}
                    <TabsContent value="prices">
                        <Suspense fallback={<TabLoadingFallback />}>
                            <PricesViewer />
                        </Suspense>
                    </TabsContent>
                </Tabs>
            </div>
            <StatusBar />
        </div>
    );
};


const App = () => {
    return (
        <QueryClientProvider client={queryClient}>
            <AssetDetailPanelProvider>
                <DataHealthProvider>
                    <QaTestPlanProvider>
                        <Routes>
                            <Route path="/" element={<Navigate to={DEFAULT_ROUTE} replace />} />
                            <Route path="/:tab" element={<AppContent />} />
                            <Route path="/:tab/:subtab" element={<AppContent />} />
                            <Route path="*" element={<Navigate to={DEFAULT_ROUTE} replace />} />
                        </Routes>
                        <AssetDetailSlidePanel />
                    </QaTestPlanProvider>
                </DataHealthProvider>
            </AssetDetailPanelProvider>
        </QueryClientProvider>
    );
};

export default App;