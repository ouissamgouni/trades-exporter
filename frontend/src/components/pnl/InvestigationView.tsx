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
import { Badge, Button, Spinner } from '../ui/primitives';
import { FiAlertTriangle, FiBox, FiDollarSign, FiList, FiLayers, FiTrendingUp } from 'react-icons/fi';
import { PnLAuditTransactionsView } from './PnLAuditTransactionsView';
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
import { IncomeSlidePanel } from './IncomeSlidePanel';
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
    /** Pre-applied filters from drill-down context (merged into local state) */
    initialFilters?: Partial<TransactionFilterState>;
    /** Descriptive label for the current scope (shown above filters) */
    scopeLabel?: string;
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

interface StatsColorSet {
    border: string;
    activeBorder: string;
    bg: string;
    hoverBorder: string;
    icon: string;
    value: string;
}

const STATS_COLORS: Record<string, StatsColorSet> = {
    purple: { border: 'border-slate-200', activeBorder: 'border-purple-400', bg: 'bg-purple-50', hoverBorder: 'hover:border-purple-300', icon: 'text-purple-500', value: 'text-purple-700' },
    green: { border: 'border-slate-200', activeBorder: 'border-green-400', bg: 'bg-green-50', hoverBorder: 'hover:border-green-300', icon: 'text-green-500', value: 'text-green-700' },
    red: { border: 'border-slate-200', activeBorder: 'border-red-400', bg: 'bg-red-50', hoverBorder: 'hover:border-red-300', icon: 'text-red-500', value: 'text-red-700' },
    orange: { border: 'border-slate-200', activeBorder: 'border-orange-400', bg: 'bg-orange-50', hoverBorder: 'hover:border-orange-300', icon: 'text-orange-500', value: 'text-orange-700' },
    blue: { border: 'border-slate-200', activeBorder: 'border-blue-400', bg: 'bg-blue-50', hoverBorder: 'hover:border-blue-300', icon: 'text-blue-500', value: 'text-blue-700' },
    cyan: { border: 'border-slate-200', activeBorder: 'border-cyan-400', bg: 'bg-cyan-50', hoverBorder: 'hover:border-cyan-300', icon: 'text-cyan-500', value: 'text-cyan-700' },
    gray: { border: 'border-slate-200', activeBorder: 'border-slate-400', bg: 'bg-slate-50', hoverBorder: 'hover:border-slate-300', icon: 'text-slate-500', value: 'text-slate-700' },
};

const getStatsColors = (color: string): StatsColorSet => STATS_COLORS[color] ?? STATS_COLORS.gray;

const StatsCard: React.FC<StatsCardProps> = ({ label, value, icon, color, detail, onClick, isActive }) => {
    const colors = getStatsColors(color);
    return (
        <div
            className={`flex-1 min-w-[100px] cursor-pointer border ${colors.bg} ${colors.hoverBorder} transition-all hover:shadow-sm ${isActive ? `border-2 ${colors.activeBorder}` : `border ${colors.border}`}`}
            onClick={onClick}
        >
            <div className="px-2.5 py-1.5">
                <div className="flex items-center gap-1.5">
                    <div className={`flex-shrink-0 ${colors.icon}`}>{icon}</div>
                    <div className="min-w-0 flex-1">
                        <span className="block text-[10px] font-medium leading-none text-slate-500">{label}</span>
                        <div className="flex items-baseline gap-1">
                            <span className={`text-base font-bold leading-tight ${colors.value}`}>{value}</span>
                            {detail && <span className="text-[10px] text-slate-400">{detail}</span>}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

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
    initialFilters,
    scopeLabel,
}) => {
    // ── Context filters (unit-mediated scoping) ─────────────────────────────
    const pnlDefaultFilters = useMemo<TransactionFilterState>(() => ({
        ...defaultFilterState,
        reviewStatus: [],      // not relevant in PnL audit context
        taxability: [],
        connectorRunIds: [],
        ...initialFilters,
    }), [initialFilters]);
    const [txFilters, setTxFilters] = useState<TransactionFilterState>(pnlDefaultFilters);
    const txFilterParams = useMemo(() => buildPnLFilterParams(txFilters), [txFilters]);

    // Re-apply initial filters when scope changes (e.g. drill into different asset)
    useEffect(() => {
        setTxFilters(pnlDefaultFilters);
    }, [pnlDefaultFilters]);

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
    const [openPanel, setOpenPanel] = useState<'lots' | 'realized' | 'fees' | 'warnings' | 'events' | 'transactions' | 'income' | null>(defaultPanel);

    useEffect(() => { setOpenPanel(defaultPanel); }, [defaultPanel]);

    const handleOpenPanel = useCallback((panel: 'lots' | 'realized' | 'fees' | 'warnings' | 'events' | 'transactions' | 'income') => {
        const next = openPanel === panel ? null : panel;
        setOpenPanel(next);
        onPanelChange?.(next);
    }, [openPanel, onPanelChange]);

    const handleClosePanel = useCallback(() => {
        setOpenPanel(null);
        onPanelChange?.(null);
    }, [onPanelChange]);

    // ── Render ──────────────────────────────────────────────────────────────
    const s = summary;

    return (
        <div>
            {/* ── Scope Label ────────────────────────────────────── */}
            {scopeLabel && (
                <div className="mb-2 flex items-center gap-2 px-1">
                    <Badge colorScheme="blue">
                        {scopeLabel}
                    </Badge>
                </div>
            )}

            {/* ── Context Filter Bar ─────────────────────────────────── */}
            <div className="mb-1 border-b border-slate-100 bg-white pb-1">
                <TransactionFilters
                    filters={txFilters}
                    onChange={setTxFilters}
                    onClear={() => setTxFilters(pnlDefaultFilters)}
                    expanded={filtersExpanded}
                    onExpandedChange={setFiltersExpanded}
                    resetFilters={pnlDefaultFilters}
                    filterOptionsUrl={`${API_URL}/pnl/versions/${versionId}/filter-options`}
                    hiddenFilters={['reviewStatus', 'connectorRunIds']}
                />
            </div>

            {/* ── Quick Stats Bar ─────────────────────────────────────── */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
                {summaryLoading ? (
                    <div className="flex w-full items-center justify-center gap-2 py-4">
                        <Spinner size="sm" />
                        <span className="text-xs text-slate-400">Loading summary…</span>
                    </div>
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
            </div>

            {/* ── Transactions View ─────────────────────────────────────── */}
            <div className="overflow-hidden border-2 border-blue-200">
                <PnLAuditTransactionsView
                    versionId={versionId}
                    baseCurrency={baseCurrency}
                    txFilterParams={txFilterParams}
                    onTransactionClick={onTransactionClick}
                />
            </div>

            {/* ── Slide Panels ─────────────────────────────────────────── */}
            <LotsSlidePanel
                isOpen={openPanel === 'lots'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onAssetClick={onAssetClick}
                onTransactionClick={onTransactionClick}
                onUnitClick={onUnitClick}
            />
            <RealizedPnLSlidePanel
                isOpen={openPanel === 'realized'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onAssetClick={onAssetClick}
                onTransactionClick={onTransactionClick}
                onUnitClick={onUnitClick}
            />
            <FeesSlidePanel
                isOpen={openPanel === 'fees'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onAssetClick={onAssetClick}
                onTransactionClick={onTransactionClick}
                onUnitClick={onUnitClick}
            />
            <WarningsSlidePanel
                isOpen={openPanel === 'warnings'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onPriceAdded={onPriceAdded}
                onTransactionClick={onTransactionClick}
                onUnitClick={onUnitClick}
            />
            <LotEventsSlidePanel
                isOpen={openPanel === 'events'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                txFilterParams={txFilterParams}
                onTransactionClick={onTransactionClick}
                onUnitClick={onUnitClick}
            />
            <TransactionsSlidePanel
                isOpen={openPanel === 'transactions'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                onTransactionClick={onTransactionClick}
                contextFilters={txFilters}
            />
            <IncomeSlidePanel
                isOpen={openPanel === 'income'}
                onClose={handleClosePanel}
                versionId={versionId}
                baseCurrency={baseCurrency}
                onAssetClick={onAssetClick}
            />
        </div>
    );
};
