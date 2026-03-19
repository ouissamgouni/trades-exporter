/**
 * InvestigationView — Context-driven audit workflow.
 *
 * Layout:
 *   ┌─ Sticky Context Bar (TransactionFilters) ─────────────────────┐
 *   ├─ Quick Stats Bar (clickable cards → open slide panels) ───────┤
 *   ├─ Activity Feed (primary, server-filtered, paginated) ─────────┤
 *   └───────────────────────────────────────────────────────────────-┘
 *
 * Slide panels (Lots, Realized P&L, Fees, Warnings) open from the
 * right on click of a stats card, each with its own server-side
 * filter bar and pagination.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Badge,
    Box,
    Card,
    Flex,
    Heading,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { FiAlertTriangle, FiBox, FiDollarSign, FiList, FiLayers, FiTrendingUp } from 'react-icons/fi';
import { ActivityFeed } from './ActivityFeed';
import { SlidePanel } from './SlidePanel';
import { TransactionFilters, TransactionFilterState, defaultFilterState } from '../TransactionFilters';
import { buildPnLFilterParams } from '../../utils/pnlFilterParams';
import { API_URL } from '../../types';
import { LotsSlidePanel } from './LotsSlidePanel';
import { RealizedPnLSlidePanel } from './RealizedPnLSlidePanel';
import { FeesSlidePanel } from './FeesSlidePanel';
import { WarningsSlidePanel } from './WarningsSlidePanel';
import { LotEventsSlidePanel } from './LotEventsSlidePanel';
import { TransactionsSlidePanel } from './TransactionsSlidePanel';
import { UnitDetailSlidePanel } from './UnitDetailSlidePanel';
import { ValueDisplay } from '../ValueDisplay';

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditSummary {
    units_count: number;
    lots: {
        total: number;
        open: number;
        exhausted: number;
        negative: number;
    };
    realized: {
        total: number;
        taxable: number;
        non_taxable: number;
        total_gain: number;
        total_loss: number;
        short_term: number;
        long_term: number;
    };
    fees: {
        total: number;
        total_value_in_base: number;
        by_source: Array<{ source: string; count: number }>;
    };
    warnings: {
        total: number;
        by_level: { error: number; warning: number; info: number };
        by_type: Array<{ type: string; count: number }>;
    };
    events_count: number;
    transactions: {
        included: number;
        excluded: number;
    };
}

export interface InvestigationViewProps {
    versionId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    onAssetClick?: (assetId: number) => void;
    onUnitClick?: (unitId: number) => void;
    /** Optional pre-set audit sub-tab to auto-open a slide panel */
    defaultPanel?: 'lots' | 'realized' | 'fees' | 'warnings' | 'events' | 'transactions' | null;
    /** Called when the open panel changes (so parent can track) */
    onPanelChange?: (panel: string | null) => void;
    assets?: Array<{ id: number; symbol: string; label?: string }>;
    assetBalanceMap?: Map<string, number>;
    quoteAssetId?: number;
    onPriceAdded?: (assetId: number, warningId: string) => void;
}

// ─── Quick Stats Bar ────────────────────────────────────────────────────────

interface StatsCardProps {
    label: string;
    value: React.ReactNode;
    icon: React.ReactNode;
    color: string;
    detail?: string;
    onClick: () => void;
    isActive?: boolean;
}

const StatsCard: React.FC<StatsCardProps> = ({ label, value, icon, color, detail, onClick, isActive }) => (
    <Card.Root
        size="sm"
        cursor="pointer"
        onClick={onClick}
        borderWidth={isActive ? 2 : 1}
        borderColor={isActive ? `${color}.400` : 'gray.200'}
        bg={isActive ? `${color}.50` : 'white'}
        _hover={{ borderColor: `${color}.300`, shadow: 'sm' }}
        transition="all 0.15s"
        flex="1"
        minW="140px"
    >
        <Card.Body p={3}>
            <Flex align="center" gap={2}>
                <Box color={`${color}.500`}>{icon}</Box>
                <Box>
                    <Text fontSize="2xs" color="gray.500" fontWeight="medium">{label}</Text>
                    <Flex align="baseline" gap={1}>
                        <Text fontSize="lg" fontWeight="bold" color={`${color}.700`}>{value}</Text>
                        {detail && <Text fontSize="2xs" color="gray.400">{detail}</Text>}
                    </Flex>
                </Box>
            </Flex>
        </Card.Body>
    </Card.Root>
);

// ─── Component ──────────────────────────────────────────────────────────────

export const InvestigationView: React.FC<InvestigationViewProps> = ({
    versionId,
    baseCurrency,
    onTransactionClick,
    onAssetClick,
    onUnitClick,
    defaultPanel = null,
    onPanelChange,
    assets,
    assetBalanceMap,
    quoteAssetId,
    onPriceAdded,
}) => {
    // ── Context filters (unit-mediated scoping) ─────────────────────────────
    const pnlDefaultFilters = useMemo<TransactionFilterState>(() => ({
        ...defaultFilterState,
        reviewStatus: [],      // not relevant in PnL audit context
        taxability: [],
        connectorRunIds: [],
    }), []);
    const [txFilters, setTxFilters] = useState<TransactionFilterState>(pnlDefaultFilters);
    const txFilterParams = useMemo(() => buildPnLFilterParams(txFilters), [txFilters]);

    // ── Filter panel collapse state ─────────────────────────────────────────
    const [filtersExpanded, setFiltersExpanded] = useState(false);

    // ── Quick stats ─────────────────────────────────────────────────────────
    const [summary, setSummary] = useState<AuditSummary | null>(null);
    const [summaryLoading, setSummaryLoading] = useState(false);

    useEffect(() => {
        if (!versionId) return;
        setSummaryLoading(true);
        const qs = new URLSearchParams();
        Object.entries(txFilterParams).forEach(([k, v]) => {
            if (v !== undefined && v !== '') qs.set(k, String(v));
        });
        fetch(`${API_URL}/pnl/versions/${versionId}/audit-summary?${qs}`)
            .then(r => r.json())
            .then(data => { setSummary(data); setSummaryLoading(false); })
            .catch(() => setSummaryLoading(false));
    }, [versionId, txFilterParams]);

    // ── Slide panel state ───────────────────────────────────────────────────
    const [openPanel, setOpenPanel] = useState<'lots' | 'realized' | 'fees' | 'warnings' | 'events' | 'transactions' | null>(defaultPanel);

    useEffect(() => { setOpenPanel(defaultPanel); }, [defaultPanel]);

    const handleOpenPanel = useCallback((panel: 'lots' | 'realized' | 'fees' | 'warnings' | 'events' | 'transactions') => {
        const next = openPanel === panel ? null : panel;
        setOpenPanel(next);
        onPanelChange?.(next);
    }, [openPanel, onPanelChange]);

    const handleClosePanel = useCallback(() => {
        setOpenPanel(null);
        onPanelChange?.(null);
    }, [onPanelChange]);

    // ── Unit detail side panel ──────────────────────────────────────────────
    const [selectedUnitId, setSelectedUnitId] = useState<number | null>(null);
    const [isUnitDetailOpen, setIsUnitDetailOpen] = useState(false);

    const handleUnitClick = useCallback((unitId: number) => {
        setSelectedUnitId(unitId);
        setIsUnitDetailOpen(true);
        // Also propagate to parent if provided
        onUnitClick?.(unitId);
    }, [onUnitClick]);

    const handleCloseUnitDetail = useCallback(() => {
        setIsUnitDetailOpen(false);
        setSelectedUnitId(null);
    }, []);

    // ── Render ──────────────────────────────────────────────────────────────
    const s = summary;

    return (
        <Box>
            {/* ── Context Filter Bar ─────────────────────────────────── */}
            <Box
                bg="white"
                borderBottomWidth={1}
                borderColor="gray.100"
                pb={2}
                mb={3}
            >
                <TransactionFilters
                    filters={txFilters}
                    onChange={setTxFilters}
                    onClear={() => setTxFilters(pnlDefaultFilters)}
                    expanded={filtersExpanded}
                    onExpandedChange={setFiltersExpanded}
                    resetFilters={pnlDefaultFilters}
                    filterOptionsUrl={`${API_URL}/pnl/versions/${versionId}/filter-options`}
                    hiddenFilters={['reviewStatus', 'taxability', 'connectorRunIds']}
                />
            </Box>

            {/* ── Quick Stats Bar ─────────────────────────────────────── */}
            <Flex gap={2} mb={4} wrap="wrap">
                {summaryLoading ? (
                    <Flex align="center" gap={2} py={4} w="100%" justify="center">
                        <Spinner size="sm" />
                        <Text fontSize="xs" color="gray.400">Loading summary…</Text>
                    </Flex>
                ) : s ? (
                    <>
                        <StatsCard
                            label="Lot Events"
                            value={s.events_count}
                            icon={<FiLayers size={16} />}
                            color="purple"
                            onClick={() => handleOpenPanel('events')}
                            isActive={openPanel === 'events'}
                        />
                        <StatsCard
                            label="Realized P&L"
                            value={
                                <ValueDisplay
                                    value={s.realized.total_gain - s.realized.total_loss}
                                    currency={baseCurrency}
                                />
                            }
                            icon={<FiTrendingUp size={16} />}
                            color={(s.realized.total_gain - s.realized.total_loss) >= 0 ? 'green' : 'red'}
                            detail={`${s.realized.total} entries`}
                            onClick={() => handleOpenPanel('realized')}
                            isActive={openPanel === 'realized'}
                        />
                        <StatsCard
                            label="Fees"
                            value={
                                <ValueDisplay
                                    value={s.fees.total_value_in_base}
                                    currency={baseCurrency}
                                />
                            }
                            icon={<FiDollarSign size={16} />}
                            color="orange"
                            detail={`${s.fees.total} entries`}
                            onClick={() => handleOpenPanel('fees')}
                            isActive={openPanel === 'fees'}
                        />
                        <StatsCard
                            label="Cost Lots"
                            value={s.lots.total}
                            icon={<FiBox size={16} />}
                            color="blue"
                            detail={`${s.lots.open} open`}
                            onClick={() => handleOpenPanel('lots')}
                            isActive={openPanel === 'lots'}
                        />
                        <StatsCard
                            label="Transactions"
                            value={s.transactions.included}
                            icon={<FiList size={16} />}
                            color="cyan"
                            detail={s.transactions.excluded > 0 ? `${s.transactions.excluded} excl.` : undefined}
                            onClick={() => handleOpenPanel('transactions')}
                            isActive={openPanel === 'transactions'}
                        />
                        <StatsCard
                            label="Warnings"
                            value={s.warnings.total}
                            icon={<FiAlertTriangle size={16} />}
                            color={s.warnings.by_level.error > 0 ? 'red' : s.warnings.total > 0 ? 'orange' : 'gray'}
                            detail={s.warnings.by_level.error > 0 ? `${s.warnings.by_level.error} errors` : undefined}
                            onClick={() => handleOpenPanel('warnings')}
                            isActive={openPanel === 'warnings'}
                        />

                    </>
                ) : null}
            </Flex>

            {/* ── Activity Feed (primary view) ─────────────────────────── */}
            <ActivityFeed
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onTransactionClick={onTransactionClick}
                onAssetClick={onAssetClick}
                onUnitClick={handleUnitClick}
                assetBalanceMap={assetBalanceMap}
            />

            {/* ── Slide Panels ─────────────────────────────────────────── */}
            <LotsSlidePanel
                isOpen={openPanel === 'lots'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onAssetClick={onAssetClick}
                onTransactionClick={onTransactionClick}
                onUnitClick={handleUnitClick}
            />
            <RealizedPnLSlidePanel
                isOpen={openPanel === 'realized'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onAssetClick={onAssetClick}
                onTransactionClick={onTransactionClick}
                onUnitClick={handleUnitClick}
            />
            <FeesSlidePanel
                isOpen={openPanel === 'fees'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onAssetClick={onAssetClick}
                onTransactionClick={onTransactionClick}
                onUnitClick={handleUnitClick}
            />
            <WarningsSlidePanel
                isOpen={openPanel === 'warnings'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onPriceAdded={onPriceAdded}
                onTransactionClick={onTransactionClick}
                onUnitClick={handleUnitClick}
            />
            <LotEventsSlidePanel
                isOpen={openPanel === 'events'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onTransactionClick={onTransactionClick}
                onUnitClick={handleUnitClick}
            />
            <TransactionsSlidePanel
                isOpen={openPanel === 'transactions'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                onTransactionClick={onTransactionClick}
                contextFilters={txFilters}
            />
            <UnitDetailSlidePanel
                isOpen={isUnitDetailOpen}
                onClose={handleCloseUnitDetail}
                versionId={versionId}
                unitId={selectedUnitId}
                baseCurrency={baseCurrency}
                onTransactionClick={onTransactionClick}
            />
        </Box>
    );
};
