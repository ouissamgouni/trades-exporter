/**
 * P&L Panel — Thin Orchestrator
 *
 * State lives in PnLContext (useReducer).
 * Data operations live in usePnLData and usePnLPrices hooks.
 * This file is the render layer + navigation handlers only.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Box, Button, Dialog, Flex, Heading, Spinner, Text } from '@chakra-ui/react';
import { FiRefreshCw, FiClock, FiSliders } from 'react-icons/fi';
import { LuReceipt } from 'react-icons/lu';
import { toaster } from '../ui/toaster';
import { formatDateTimeLocale } from '../../utils/dateUtils';
import { PnLStatusBadge } from './PnLStatusBadge';

// P&L Components
import { CalculationContext } from './CalculationContext';
import { PnLImpactPanel } from './PnLImpactPanel';
import { PriceStatusList } from './PriceStatusList';
import { SlidePanel } from './SlidePanel';
import { BalanceSlidePanel } from './BalanceSlidePanel';
import { UnitDetailSlidePanel } from './UnitDetailSlidePanel';
import { TransactionDetailDrawer } from '../TransactionDetailDrawer';
import { ContextView } from './ContextView';
import { FrenchTaxPanel } from './FrenchTaxPanel';
import { RefreshPricesCard, WarningsCard, BalanceHealthCard } from './SummaryCards';

// Context + hooks
import { PnLProvider, usePnL } from './PnLContext';
import { usePnLData } from '../../hooks/usePnLData';
import { usePnLPrices } from '../../hooks/usePnLPrices';

// Types
import type { PnLImpactEvent, RealizedPnLRow } from './types';
import type { DrillEntityType } from './pnlState';
import { computeContextScope, PNL_STATUS } from './pnlState';


interface PnLPanelProps {
    isActive?: boolean;
    onOpenHealthCheck?: () => void;
}

/**
 * Outer shell: wraps PnLContent with PnLProvider so context is available.
 */
export const PnLPanel: React.FC<PnLPanelProps> = ({ isActive = true, onOpenHealthCheck }) => (
    <PnLProvider isActive={isActive}>
        <PnLContent isActive={isActive} onOpenHealthCheck={onOpenHealthCheck} />
    </PnLProvider>
);

/**
 * Inner content: consumes PnLContext, usePnLData, usePnLPrices.
 * Navigation handlers + render JSX.
 */
const PnLContent: React.FC<PnLPanelProps> = ({ isActive = true, onOpenHealthCheck }) => {
    const {
        state,
        dispatch,
        assets,
        displayAssets,
        scorecardSummary,
        balanceHealth,
        assetBalanceMap,
        unmappedLiveAssets,
        availableAccountIds,
        availableCategoryIds,
        versionsQuery,
        heroTimeline,
        versionMetrics,
        bookMetrics,
        liveMetrics,
        performers,
        pricesReady,
        liveBalanceMap,
        liveAccountBalanceMap,
        liveAccountBalances,
        liveFetchedAccountIds,
        liveAccountErrors,
        liveBalanceLoading,
        hasAutoLoaded,
        baseCurrency,
        baseCurrencyId,
    } = usePnL();

    // Destructure heavily-used state fields
    const {
        status, config, isCalculating, isPersisting, isDeleting, error,
        calculationMode, currentVersionId, currentVersionStatus, loadedVersionCreatedAt,
        accounts, isLoadingAccounts, dimensions,
        accountBalances, isLoadingAccountBalances, isLoadingBalances,
        summary, pnlAssets, fees, warnings, warningTypeCounts, idCounts,
        prices, isRefreshingPrices, showPriceDrawer, showBalanceDrawer, loadingPriceAssetIds,
        currentView, selectedAsset, assetRealizedEntries, initialAccountFilter,
        showHealthConfirm, healthCheckIssueCount, showCustomCalcDrawer, showHistoryPanel,
        showImpactPanel, impactEvent, selectedTransactionId, isTransactionDrawerOpen,
        performerGroupBy, performerDimensionId, deltaThreshold, timeframeRange, showMismatchedOnly,
        pnlActiveTab,
    } = state;

    const availableVersions = versionsQuery.data ?? [];
    const isLoadingVersions = versionsQuery.isLoading;

    // ── Price operations ──
    const { fetchPrices, handlePriceAdded, handleRefreshPrices, retryFailedPrices } = usePnLPrices();

    // ── Data operations ──
    const {
        runCalculation,
        loadVersionById,
        commitVersion,
        handleDeleteVersion,
        refreshVersionsList,
        handleConfigChange,
        handleModeChange,
        handleContinueAnyway,
        handleFixIssues,
        loadAccountBalances,
        calcServiceStatus,
        isCalcStale,
        isCalcServiceCalculating,
        staleReasons,
        serviceVersionId,
        lastCalculatedAt,
        triggerPnLRefresh,
        calcServiceError,
    } = usePnLData({ isActive, onOpenHealthCheck, fetchPrices });

    const { drill } = state;

    // ── Compute ContextScope from drill + timeframe ──
    const scope = useMemo(
        () => computeContextScope(drill, timeframeRange),
        [drill, timeframeRange],
    );

    // ══════════════════════════════════════════════════════════
    // Navigation handlers (UI-specific, stay in render layer)
    // ══════════════════════════════════════════════════════════

    /** Asset click from L0 table or L1 detail — enters drill L2 */
    const handleAssetClick = useCallback((assetId: number | null | undefined) => {
        if (assetId == null) return;
        const asset = assets.find(a => a.asset.id === assetId);
        if (!asset) return;
        const sym = asset.asset.symbol ?? `#${assetId}`;
        const lbl = asset.asset.label ?? undefined;
        if (drill.level === 0) {
            dispatch({ type: 'DRILL_INTO', assetId, assetSymbol: sym, assetLabel: lbl });
        } else {
            dispatch({ type: 'DRILL_TO_ASSET', assetId, assetSymbol: sym, assetLabel: lbl });
        }
    }, [assets, dispatch, drill.level]);

    /** Account click within an asset card → drill to asset with account filter */
    const handleAccountClick = useCallback((assetId: number, accountId: number) => {
        const asset = assets.find(a => a.asset.id === assetId);
        if (!asset) return;
        dispatch({ type: 'DRILL_INTO', assetId, assetSymbol: asset.asset.symbol ?? `#${assetId}`, assetLabel: asset.asset.label ?? undefined, accountFilter: accountId });
    }, [assets, dispatch]);

    const handleRealizedClick = useCallback((entryId: string) => {
        const entry = assetRealizedEntries.find((e: RealizedPnLRow) => e.id === entryId);
        if (!entry) return;
        const isFeeEntry = entry.event_type === 'fee';
        const event: PnLImpactEvent = {
            id: entryId,
            event_type: isFeeEntry ? 'fee' : entry.event_type,
            event_date: entry.realized_at,
            disposal_taxable: entry.disposal_taxable,
            total_pnl: entry.pnl_in_base,
            total_proceeds: entry.proceeds_in_base,
            total_cost_basis: entry.cost_basis_in_base,
            total_fees: isFeeEntry ? entry.proceeds_in_base : 0,
            consumed_lots: [],
            transactions: [],
            unit_id: entry.unit_id,
        };
        dispatch({ type: 'SET_SHOW_IMPACT_PANEL', value: true, event });
    }, [assetRealizedEntries, dispatch]);

    const handleTransactionClick = useCallback((txId: number) => {
        dispatch({ type: 'SET_TRANSACTION_DRAWER', transactionId: txId, isOpen: true });
    }, [dispatch]);

    const handleCloseTransactionDrawer = useCallback(() => {
        dispatch({ type: 'SET_TRANSACTION_DRAWER', transactionId: null, isOpen: false });
    }, [dispatch]);

    const [selectedUnitId, setSelectedUnitId] = useState<number | null>(null);
    const [isUnitDetailOpen, setIsUnitDetailOpen] = useState(false);

    const handleUnitClick = useCallback((unitId: number) => {
        setSelectedUnitId(unitId);
        setIsUnitDetailOpen(true);
    }, []);

    const handleCloseUnitDetail = useCallback(() => {
        setIsUnitDetailOpen(false);
        setSelectedUnitId(null);
    }, []);

    const handleLoadVersion = useCallback(async (versionId: number) => {
        await loadVersionById(versionId);
    }, [loadVersionById]);

    const handlePersistVersion = useCallback(async () => {
        await commitVersion();
    }, [commitVersion]);

    // ── Toolbar handlers (extracted from inline JSX) ──

    const handleTriggerRefresh = useCallback(async () => {
        const started = await triggerPnLRefresh();
        if (started) {
            toaster.success({ title: 'P&L recalculation started' });
        } else {
            toaster.info({ title: 'Calculation already in progress' });
        }
    }, [triggerPnLRefresh]);

    const handleOpenHistory = useCallback(() => {
        dispatch({ type: 'SET_SHOW_HISTORY_PANEL', value: true });
        refreshVersionsList();
    }, [dispatch, refreshVersionsList]);

    const handleFeesClick = useCallback(() => {
        // Fees are visible in the PnL Audit section (inline in Portfolio)
    }, []);

    const handleWarningsClick = useCallback(() => {
        dispatch({ type: 'DRILL_RESET' });
        dispatch({ type: 'SET_AUDIT_DEFAULT_PANEL', panel: 'warnings' });
    }, [dispatch]);

    const handleToggleMismatchFilter = useCallback(() => {
        dispatch({ type: 'SET_SHOW_MISMATCHED_ONLY', value: !showMismatchedOnly });
    }, [dispatch, showMismatchedOnly]);

    // ══════════════════════════════════════════════════════════
    // Drill-down handlers — progressive disclosure navigation
    // ══════════════════════════════════════════════════════════

    /** Unified performer click (asset/category/account) from TimeframeIndicators.
     *  All types dispatch DRILL_INTO which updates breadcrumb. Sections stay visible. */
    const handlePerformerDrill = useCallback((id: number, groupType: string, name: string) => {
        if (groupType === 'asset') {
            const asset = assets.find(a => a.asset.id === id);
            dispatch({ type: 'DRILL_INTO', assetId: id, assetSymbol: asset?.asset.symbol ?? name, assetLabel: asset?.asset.label ?? undefined });
        } else if (groupType === 'category') {
            dispatch({ type: 'DRILL_INTO', entityType: 'category' as DrillEntityType, entityId: id, entityLabel: name });
        } else if (groupType === 'account') {
            dispatch({ type: 'DRILL_INTO', entityType: 'account' as DrillEntityType, entityId: id, entityLabel: name });
        }
    }, [assets, dispatch]);

    /** Asset navigate from treemap (double-click) */
    const handleAssetNavigate = useCallback((assetId: number, assetSymbol: string) => {
        const asset = assets.find(a => a.asset.id === assetId);
        const lbl = asset?.asset.label ?? undefined;
        if (drill.level === 0) {
            dispatch({ type: 'DRILL_INTO', assetId, assetSymbol, assetLabel: lbl });
        } else {
            dispatch({ type: 'DRILL_TO_ASSET', assetId, assetSymbol, assetLabel: lbl });
        }
    }, [assets, dispatch, drill.level]);

    const statusBadgeStatus = status === PNL_STATUS.ERROR
        ? 'error'
        : calcServiceStatus === 'idle' && currentVersionId != null
            ? 'completed'
            : calcServiceStatus;

    const statusBadgeError = status === PNL_STATUS.ERROR ? error : calcServiceError;

    return (
        <Box p={2} pt={1}>
            {/* Header: Title + Status Badge + Action Buttons */}
            <Flex justify="space-between" align="center" mb={1.5} flexWrap="wrap" gap={1}>
                <Flex align="center" gap={3} flex={1} minW={0}>
                    <Heading size="lg" flexShrink={0}>📊 P&L</Heading>
                    <PnLStatusBadge
                        status={statusBadgeStatus}
                        staleReasons={staleReasons}
                        lastCalculatedAt={lastCalculatedAt ?? loadedVersionCreatedAt}
                        currentVersionId={serviceVersionId ?? currentVersionId}
                        errorMessage={statusBadgeError}
                        compactWhenCompleted
                    />
                </Flex>

                <Flex gap={1} align="center">
                    <Button
                        size="xs"
                        colorPalette={isCalcStale ? 'orange' : 'blue'}
                        variant={isCalcStale ? 'solid' : 'outline'}
                        onClick={handleTriggerRefresh}
                        disabled={isCalcServiceCalculating}
                        loading={isCalcServiceCalculating}
                        fontSize="xs"
                    >
                        <FiRefreshCw size={12} />
                        <Text ml={0.5}>{isCalcStale ? 'Refresh' : currentVersionId ? 'Recalc' : 'Calculate'}</Text>
                    </Button>
                    <Button
                        size="xs"
                        variant="outline"
                        onClick={() => dispatch({ type: 'SET_SHOW_CUSTOM_CALC_DRAWER', value: true })}
                        fontSize="xs"
                    >
                        <FiSliders size={12} />
                        <Text ml={0.5}>Custom</Text>
                    </Button>
                    <Button
                        size="xs"
                        variant="outline"
                        onClick={handleOpenHistory}
                        fontSize="xs"
                    >
                        <FiClock size={12} />
                        <Text ml={0.5}>History</Text>
                    </Button>
                </Flex>
            </Flex>

            {status === PNL_STATUS.ERROR && error && (
                <Box mb={2} borderWidth="1px" borderColor="red.200" bg="red.50" color="red.700" px={3} py={2}>
                    <Text fontSize="sm" fontWeight="medium">Unable to load P&L data</Text>
                    <Text fontSize="xs" mt={0.5}>{error}</Text>
                </Box>
            )}

            {/* Show loading state while auto-loading initial version */}
            {status === 'idle' && !hasAutoLoaded.current && (
                <Flex justify="center" align="center" py={16} bg="gray.50" borderRadius="md" direction="column" gap={3}>
                    <Spinner size="lg" />
                    <Text color="gray.500">Loading P&L...</Text>
                </Flex>
            )}

            {/* Show empty state only if no versions exist at all */}
            {status === 'idle' && hasAutoLoaded.current && availableVersions.length === 0 && (
                <Box textAlign="center" py={16} bg="gray.50" borderRadius="md">
                    <Heading size="md" color="gray.500" mb={2}>
                        No P&L Calculation Yet
                    </Heading>
                    <Text color="gray.400" mb={4}>
                        Click "Refresh P&L" to calculate using your default settings, or "Custom Calculation" for advanced options.
                    </Text>
                    <Button
                        colorPalette="blue"
                        onClick={handleTriggerRefresh}
                    >
                        Calculate P&L
                    </Button>
                </Box>
            )}

            {(status === 'preview' || status === 'persisted') && summary && (
                <>
                    {/* ═══ Tab bar — Portfolio / Tax + Status Cards ═══ */}
                    <Flex gap={0} borderBottom="1px solid" borderColor="gray.200" align="center">
                        {(['portfolio', 'tax'] as const).map(tab => {
                            const active = pnlActiveTab === tab;
                            const label = tab === 'portfolio' ? 'Portfolio' : 'Tax (FR)';
                            return (
                                <Box
                                    key={tab}
                                    px={4}
                                    py={2}
                                    cursor="pointer"
                                    fontWeight={active ? '600' : '400'}
                                    fontSize="sm"
                                    color={active ? 'blue.600' : 'gray.500'}
                                    borderBottom="2px solid"
                                    borderColor={active ? 'blue.500' : 'transparent'}
                                    mb="-1px"
                                    _hover={{ color: active ? 'blue.600' : 'gray.700', bg: 'gray.50' }}
                                    transition="all 0.15s"
                                    onClick={() => dispatch({ type: 'SET_PNL_ACTIVE_TAB', tab })}
                                    display="flex"
                                    alignItems="center"
                                    gap={1.5}
                                    flexShrink={0}
                                >
                                    {tab === 'tax' && <LuReceipt size={13} />}
                                    {label}
                                </Box>
                            );
                        })}

                        {/* Status cards — right of tab strip */}
                        <Flex gap={1.5} ml="auto" align="center" flexShrink={0} py={1} pr={1}>
                            <RefreshPricesCard
                                onRefreshPrices={handleRefreshPrices}
                                isRefreshingPrices={isRefreshingPrices || isLoadingBalances}
                                priceSuccessCount={prices.filter(p => !p.error && p.price != null && !p.is_stale).length}
                                priceStaleCount={prices.filter(p => !p.error && p.price != null && p.is_stale).length}
                                priceErrorCount={prices.filter(p => !!p.error || p.price == null).length}
                                onPriceBadgeClick={() => dispatch({ type: 'SET_SHOW_PRICE_DRAWER', value: true })}
                                refreshDisabled={!currentVersionId}
                                naCount={displayAssets.filter(da => !pnlAssets.some(pa => pa.asset.id === da.asset.id)).length}
                                pendingCount={loadingPriceAssetIds.size}
                                pnlAssetCount={pnlAssets.length}
                            />
                            <WarningsCard
                                summary={summary}
                                onWarningsClick={handleWarningsClick}
                                warningTypeCounts={warningTypeCounts}
                            />
                            <BalanceHealthCard
                                balanceHealth={balanceHealth}
                                onBalanceHealthClick={() => dispatch({ type: 'SET_SHOW_BALANCE_DRAWER', value: true })}
                                deltaThreshold={deltaThreshold}
                                onDeltaThresholdChange={(v: number) => dispatch({ type: 'SET_DELTA_THRESHOLD', threshold: v })}
                                unmappedLiveAssets={unmappedLiveAssets}
                            />
                        </Flex>
                    </Flex>

                    {/* ═══ Portfolio tab — ContextView (breadcrumb + tree sections) ═══ */}
                    {pnlActiveTab === 'portfolio' && (
                        <Box>
                            <ContextView
                                scope={scope}
                                onAssetClick={(id) => handleAssetClick(id)}
                                onAccountClick={handleAccountClick}
                                onAssetNavigate={handleAssetNavigate}
                                onTransactionClick={handleTransactionClick}
                                onUnitClick={handleUnitClick}
                                onPerformerClick={handlePerformerDrill}
                                onWarningsClick={handleWarningsClick}
                                onRefreshPrices={handleRefreshPrices}
                                isRefreshingPrices={isRefreshingPrices || isLoadingBalances}
                                onLoadAccountBalances={() => currentVersionId && loadAccountBalances(currentVersionId)}
                            />
                        </Box>
                    )}

                    {/* ═══ Tax tab — French Tax ═══ */}
                    <Box display={pnlActiveTab === 'tax' ? 'block' : 'none'} mt={0}>
                        {currentVersionId && (
                            <FrenchTaxPanel
                                versionId={currentVersionId}
                                baseCurrency={baseCurrency}
                                onTransactionClick={handleTransactionClick}
                                onUnitClick={handleUnitClick}
                                onAssetClick={(id) => handleAssetClick(id)}
                            />
                        )}
                    </Box>
                </>
            )}

            {showImpactPanel && impactEvent && (
                <PnLImpactPanel
                    event={impactEvent}
                    baseCurrency={config.base_currency_symbol}
                    onClose={() => dispatch({ type: 'SET_SHOW_IMPACT_PANEL', value: false })}
                    onTransactionClick={handleTransactionClick}
                    onUnitClick={handleUnitClick}
                />
            )}

            <SlidePanel
                isOpen={showPriceDrawer}
                onClose={() => dispatch({ type: 'SET_SHOW_PRICE_DRAWER', value: false })}
                title="Price Fetch Results"
                width="600px"
            >
                <PriceStatusList
                    prices={prices}
                    baseCurrency={config.base_currency_symbol}
                    quoteAssetId={config.base_currency_id ?? undefined}
                    onPriceAdded={(assetId) => handlePriceAdded(assetId)}
                    onRetryFailed={retryFailedPrices}
                    onBulkGapFixComplete={handleRefreshPrices}
                    loadingAssetIds={loadingPriceAssetIds}
                    assetNameMap={new Map(pnlAssets.map(a => [a.asset.id!, a.asset.symbol ?? `#${a.asset.id}`]))}
                    totalAssetCount={displayAssets.length}
                    naAssets={displayAssets
                        .filter(da => !pnlAssets.some(pa => pa.asset.id === da.asset.id))
                        .map(da => ({ id: da.asset.id!, symbol: da.asset.symbol ?? `#${da.asset.id}` }))
                    }
                />
            </SlidePanel>

            {/* Balance Comparison Drawer */}
            <BalanceSlidePanel
                isOpen={showBalanceDrawer}
                onClose={() => dispatch({ type: 'SET_SHOW_BALANCE_DRAWER', value: false })}
                pnlAssets={pnlAssets.map(a => ({ symbol: a.asset.symbol ?? '', quantity: a.quantity }))}
                liveAccountBalances={liveAccountBalances}
                deltaThreshold={deltaThreshold}
                onDeltaThresholdChange={(v: number) => dispatch({ type: 'SET_DELTA_THRESHOLD', threshold: v })}
                unmappedLiveAssets={unmappedLiveAssets}
            />

            {/* Unit Detail Slide Panel - opens when clicking unit from impact panel etc. */}
            {currentVersionId && (
                <UnitDetailSlidePanel
                    isOpen={isUnitDetailOpen}
                    onClose={handleCloseUnitDetail}
                    versionId={currentVersionId}
                    unitId={selectedUnitId}
                    baseCurrency={config.base_currency_symbol}
                    onTransactionClick={handleTransactionClick}
                />
            )}

            {/* Transaction Detail Drawer - opens when clicking any transaction badge */}
            <TransactionDetailDrawer
                transactionId={selectedTransactionId}
                isOpen={isTransactionDrawerOpen}
                onClose={handleCloseTransactionDrawer}
                accounts={accounts}
            />

            {/* Data Health Confirmation Dialog */}
            <Dialog.Root
                open={showHealthConfirm}
                onOpenChange={(e) => { if (!e.open) dispatch({ type: 'SET_SHOW_HEALTH_CONFIRM', value: false }); }}
            >
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content>
                        <Dialog.Header>
                            <Dialog.Title>Data Health Issues Detected</Dialog.Title>
                        </Dialog.Header>
                        <Dialog.Body>
                            <Text>
                                Found <strong>{healthCheckIssueCount}</strong> data issue
                                {healthCheckIssueCount !== 1 ? 's' : ''}
                                (linkage, transfers, etc.). P&L calculation may be incomplete or inaccurate.
                            </Text>
                            <Text mt={3} fontSize="sm" color="gray.600">
                                What would you like to do?
                            </Text>
                        </Dialog.Body>
                        <Dialog.Footer>
                            <Flex gap={2} width="100%">
                                <Button
                                    variant="outline"
                                    onClick={() => dispatch({ type: 'SET_SHOW_HEALTH_CONFIRM', value: false })}
                                    flex={1}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    colorPalette="orange"
                                    variant="outline"
                                    onClick={handleContinueAnyway}
                                    flex={1}
                                >
                                    Continue Anyway
                                </Button>
                                <Button
                                    colorPalette="blue"
                                    onClick={handleFixIssues}
                                    flex={1}
                                >
                                    Fix Issues
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Dialog.Root>

            {/* Custom Calculation Drawer */}
            <SlidePanel
                isOpen={showCustomCalcDrawer}
                onClose={() => dispatch({ type: 'SET_SHOW_CUSTOM_CALC_DRAWER', value: false })}
                title="Custom P&L Calculation"
                width="480px"
            >
                <CalculationContext
                    status={status}
                    config={config}
                    onConfigChange={handleConfigChange}
                    onCalculate={() => {
                        dispatch({ type: 'SET_SHOW_CUSTOM_CALC_DRAWER', value: false });
                        runCalculation();
                    }}
                    mode={calculationMode}
                    onModeChange={handleModeChange}
                    accounts={accounts}
                    isLoadingAccounts={isLoadingAccounts}
                    availableVersions={availableVersions}
                    isLoadingVersions={isLoadingVersions}
                    selectedVersionId={currentVersionId ?? undefined}
                    onLoadVersion={(versionId) => {
                        dispatch({ type: 'SET_SHOW_CUSTOM_CALC_DRAWER', value: false });
                        handleLoadVersion(versionId);
                    }}
                    onPersist={handlePersistVersion}
                    onDeleteVersion={handleDeleteVersion}
                    isCalculating={isCalculating}
                    isPersisting={isPersisting}
                    isDeleting={isDeleting}
                    error={error}
                />
            </SlidePanel>

            {/* History Panel Drawer */}
            <SlidePanel
                isOpen={showHistoryPanel}
                onClose={() => dispatch({ type: 'SET_SHOW_HISTORY_PANEL', value: false })}
                title="P&L Calculation History"
                width="600px"
            >
                <Box>
                    {isLoadingVersions ? (
                        <Flex justify="center" py={8}>
                            <Spinner size="lg" />
                        </Flex>
                    ) : availableVersions.length === 0 ? (
                        <Text color="gray.500" textAlign="center" py={8}>
                            No calculation history yet
                        </Text>
                    ) : (
                        <Box display="flex" flexDirection="column" gap={2}>
                            {availableVersions.map((version) => (
                                <Box
                                    key={version.version_id}
                                    p={3}
                                    borderWidth={1}
                                    borderRadius="md"
                                    borderColor={currentVersionId === version.version_id ? 'blue.400' : 'gray.200'}
                                    bg={currentVersionId === version.version_id ? 'blue.50' : 'white'}
                                    cursor="pointer"
                                    _hover={{ borderColor: 'blue.300', bg: currentVersionId === version.version_id ? 'blue.50' : 'gray.50' }}
                                    onClick={() => {
                                        dispatch({ type: 'SET_SHOW_HISTORY_PANEL', value: false });
                                        handleLoadVersion(version.version_id);
                                    }}
                                >
                                    <Flex justify="space-between" align="center">
                                        <Flex gap={2} align="center">
                                            <Badge
                                                colorPalette={version.status === 'committed' ? 'green' : 'gray'}
                                                size="sm"
                                                variant="subtle"
                                            >
                                                {version.status}
                                            </Badge>
                                            {version.trigger && (
                                                <Badge
                                                    colorPalette={
                                                        version.trigger === 'refresh' ? 'blue' :
                                                            version.trigger === 'manual' ? 'purple' : 'gray'
                                                    }
                                                    size="sm"
                                                    variant="outline"
                                                >
                                                    {version.trigger}
                                                </Badge>
                                            )}
                                            <Text fontSize="sm" fontWeight="medium">
                                                {version.lot_method} / {version.lot_mode}
                                            </Text>
                                        </Flex>
                                        <Text fontSize="xs" color="gray.500">
                                            {version.created_at
                                                ? formatDateTimeLocale(version.created_at)
                                                : 'Unknown date'}
                                        </Text>
                                    </Flex>
                                    {version.description && (
                                        <Text fontSize="xs" color="gray.600" mt={1}>{version.description}</Text>
                                    )}
                                    <Flex gap={3} mt={1} flexWrap="wrap">
                                        <Text fontSize="xs" color="gray.400">
                                            Base: {version.base_currency_symbol || '—'}
                                        </Text>
                                        <Text fontSize="xs" color="gray.400">
                                            ID: {version.version_id}
                                        </Text>
                                    </Flex>
                                    <Text fontSize="xs" color="gray.400" mt={1}>
                                        Tolerance: {version.residual_tolerance_pct === 0 ? 'OFF' : `${version.residual_tolerance_pct}%`} ·{' '}
                                        Neg. balances: {version.allow_negative_balances ? '✓' : '✗'} ·{' '}
                                        Swaps taxable: {version.crypto_swap_taxable ? '✓' : '✗'} ·{' '}
                                        Fees taxable: {version.fee_taxable ? '✓' : '✗'}
                                        {version.use_price_fallback !== undefined && (
                                            <> · Price fallback: {version.use_price_fallback ? `✓ (${version.price_staleness_window_days ?? 7}d)` : '✗'}</>
                                        )}
                                    </Text>
                                </Box>
                            ))}
                        </Box>
                    )}
                </Box>
            </SlidePanel>
        </Box>
    );
};

export default PnLPanel;
