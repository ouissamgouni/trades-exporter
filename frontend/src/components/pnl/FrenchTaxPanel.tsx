/**
 * FrenchTaxPanel - French Tax Report Viewer (Option B: Card-Selectors)
 *
 * Layout:
 *  - Recompute hero bar (shown when stale / first time)
 *  - Two clickable summary cards: Crypto (blue) / Securities (purple)
 *  - Active card detail: year selector + export, annual summary table,
 *    disposal line items from /realized-pnl endpoint (server-paginated, with traceability)
 *
 * Props:
 *  - versionId: The calculation version to display taxes for
 *  - baseCurrency: Base currency symbol (e.g., "EUR")
 *  - onTransactionClick, onUnitClick, onAssetClick: traceability callbacks
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Spinner } from '../ui/primitives';
import { FiDownload, FiChevronsLeft, FiChevronLeft, FiChevronRight, FiChevronsRight } from 'react-icons/fi';
import { LuRefreshCw, LuCircleAlert, LuCircleCheck, LuFilter, LuChevronDown, LuRotateCcw, LuEye, LuArrowLeft } from 'react-icons/lu';
import { API_URL } from '../../types';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { ValueDisplay } from '../ValueDisplay';
import { Tooltip } from '../ui/tooltip';
import {
    RFilterCard, RDropdownCard, SortHeader, FilterChip, TH, TD,
    type FilterOption, type RealizedFilterOptions, type FilterChipData,
} from './RealizedPnLFilters';

// ─── Types ─────────────────────────────────────────────────────────────────

interface FrenchTaxAnnualSummary {
    id: number;
    fiscal_year: number;
    total_gains: number;
    total_losses: number;
    net_taxable: number;
    tax_before_carryforward: number;
    loss_carryforward_used: number;
    loss_carried_forward: number;
    tax_total: number;
    transaction_count: number;
}

interface FrenchTaxReport {
    version_id: number;
    tax_jurisdiction: string | null;
    total_tax: number;
    annual_summaries: FrenchTaxAnnualSummary[];
    entries: unknown[];
}

interface FrenchSecuritiesTaxReport {
    version_id: number;
    tax_jurisdiction: string | null;
    total_tax: number;
    annual_summaries: FrenchTaxAnnualSummary[];
    entries: unknown[];
}

interface FrenchIncomeTaxEntry {
    id: number;
    income_event_id: number | null;
    fiscal_year: number;
    asset_symbol: string;
    income_type: string;
    gross_income: number;
    withholding_tax_credit: number;
    net_taxable: number;
    tax_amount: number;
}

interface FrenchIncomeTaxAnnualSummary {
    id: number;
    fiscal_year: number;
    total_gross_income: number;
    total_withholding_credits: number;
    net_taxable: number;
    tax_total: number;
    event_count: number;
}

interface FrenchIncomeTaxReport {
    version_id: number;
    tax_jurisdiction: string | null;
    total_tax: number;
    annual_summaries: FrenchIncomeTaxAnnualSummary[];
    entries: FrenchIncomeTaxEntry[];
}

interface RealizedPnLEntry {
    pnl_id: number;
    asset: { id: number; symbol: string; label?: string };
    account_id?: number;
    account_name?: string;
    qty: number;
    proceeds_in_base: number;
    cost_basis_in_base: number;
    pnl_in_base: number;
    taxable: boolean;
    is_fee: boolean;
    transaction_id?: number;
    unit_id?: number;
    realized_at: string;
    holding_period_days?: number;
    proceeds_source?: string;
    proceeds_price?: number;
    proceeds_price_source?: string;
    proceeds_price_timestamp?: string;
    fr_tax_effective?: boolean;
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface FrenchTaxPanelProps {
    versionId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
    onAssetClick?: (assetId: number) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const formatCurrency = (value: number, currency: string) =>
    new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);

const GainBadge: React.FC<{ value: number; currency: string }> = ({ value, currency }) => (
    <span className={`text-xs font-semibold ${value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
        {value >= 0 ? '+' : ''}{formatCurrency(value, currency)}
    </span>
);

type TaxCategory = 'crypto' | 'securities' | 'income';
type TaxView = { type: 'year'; year: number } | { type: 'all' };

// ─── Component ──────────────────────────────────────────────────────────────

export const FrenchTaxPanel: React.FC<FrenchTaxPanelProps> = ({
    versionId,
    baseCurrency,
    onTransactionClick,
    onUnitClick,
    onAssetClick,
}) => {
    const [cryptoReport, setCryptoReport] = useState<FrenchTaxReport | null>(null);
    const [securitiesReport, setSecuritiesReport] = useState<FrenchSecuritiesTaxReport | null>(null);
    const [incomeReport, setIncomeReport] = useState<FrenchIncomeTaxReport | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isComputing, setIsComputing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasTaxResults, setHasTaxResults] = useState<boolean | null>(null);

    // Check tax status on mount
    useEffect(() => {
        const controller = new AbortController();
        fetch(`${API_URL}/pnl/versions/${versionId}/tax-status`, { signal: controller.signal })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data) {
                    setHasTaxResults(data.has_tax_results);
                    if (data.has_tax_results) {
                        fetchTaxData();
                    }
                }
            })
            .catch(() => { });
        return () => controller.abort();
    }, [versionId]);

    const fetchTaxData = (silent = false) => {
        if (!silent) setIsLoading(true);
        setError(null);

        Promise.all([
            fetch(`${API_URL}/pnl/versions/${versionId}/fr-crypto-tax`)
                .then(res => res.ok ? res.json() : null)
                .catch(() => null),
            fetch(`${API_URL}/pnl/versions/${versionId}/fr-securities-tax`)
                .then(res => res.ok ? res.json() : null)
                .catch(() => null),
            fetch(`${API_URL}/pnl/versions/${versionId}/fr-income-tax`)
                .then(res => res.ok ? res.json() : null)
                .catch(() => null),
        ])
            .then(([crypto, securities, income]) => {
                setCryptoReport(crypto);
                setSecuritiesReport(securities);
                setIncomeReport(income);
                setHasTaxResults(true);
            })
            .catch(err => {
                setError(err.message);
            })
            .finally(() => setIsLoading(false));
    };

    const handleComputeTax = async () => {
        setIsComputing(true);
        setError(null);
        try {
            const res = await fetch(`${API_URL}/pnl/versions/${versionId}/compute-tax`, {
                method: 'POST',
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to compute tax');
            }
            fetchTaxData();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to compute tax');
        } finally {
            setIsComputing(false);
        }
    };

    // Initial loading state
    if (hasTaxResults === null) {
        return (
            <div className="flex items-center justify-center gap-3 py-8">
                <Spinner size="sm" />
                <span className="text-sm text-slate-500">Checking tax status…</span>
            </div>
        );
    }

    // No tax results yet
    if (!hasTaxResults && !isLoading) {
        return (
            <div className="py-8 text-center">
                <p className="mb-3 text-sm text-slate-500">
                    French tax has not been computed for this version yet.
                </p>
                <Button
                    size="sm"
                    colorScheme="blue"
                    onClick={handleComputeTax}
                    loading={isComputing}
                >
                    Compute French Tax
                </Button>
                {error && (
                    <p className="mt-2 text-sm text-red-500">{error}</p>
                )}
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="flex items-center justify-center gap-3 py-12">
                <Spinner size="md" />
                <span className="text-sm text-slate-500">Loading tax data…</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="py-8 text-center">
                <span className="text-sm text-red-500">Failed to load tax data: {error}</span>
            </div>
        );
    }

    const hasCrypto = cryptoReport && (cryptoReport.annual_summaries?.length > 0 || cryptoReport.entries?.length > 0);
    const hasSecurities = securitiesReport && (securitiesReport.annual_summaries?.length > 0 || securitiesReport.entries?.length > 0);
    const hasIncome = incomeReport && (incomeReport.annual_summaries?.length > 0 || incomeReport.entries?.length > 0);

    if (!hasCrypto && !hasSecurities && !hasIncome) {
        return (
            <div className="py-8 text-center">
                <p className="mb-3 text-sm text-slate-400">No taxable disposals found for this version.</p>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={handleComputeTax} loading={isComputing}>
                    Recompute
                </Button>
            </div>
        );
    }

    return (
        <TaxContent
            cryptoReport={cryptoReport}
            securitiesReport={securitiesReport}
            incomeReport={incomeReport}
            hasCrypto={!!hasCrypto}
            hasSecurities={!!hasSecurities}
            hasIncome={!!hasIncome}
            baseCurrency={baseCurrency}
            versionId={versionId}
            onRecompute={handleComputeTax}
            onRefreshTaxData={fetchTaxData}
            isComputing={isComputing}
            onTransactionClick={onTransactionClick}
            onUnitClick={onUnitClick}
            onAssetClick={onAssetClick}
        />
    );
};

// ─── Card-based Content ─────────────────────────────────────────────────────

const TaxContent: React.FC<{
    cryptoReport: FrenchTaxReport | null;
    securitiesReport: FrenchSecuritiesTaxReport | null;
    incomeReport: FrenchIncomeTaxReport | null;
    hasCrypto: boolean;
    hasSecurities: boolean;
    hasIncome: boolean;
    baseCurrency: string;
    versionId: number;
    onRecompute: () => void;
    onRefreshTaxData: (silent?: boolean) => void;
    isComputing: boolean;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
    onAssetClick?: (assetId: number) => void;
}> = ({
    cryptoReport, securitiesReport, incomeReport, hasCrypto, hasSecurities, hasIncome,
    baseCurrency, versionId, onRecompute, onRefreshTaxData, isComputing,
    onTransactionClick, onUnitClick, onAssetClick,
}) => {
        const [activeCategory, setActiveCategory] = useState<TaxCategory>(hasCrypto ? 'crypto' : hasSecurities ? 'securities' : 'income');
        const [view, setView] = useState<TaxView>({ type: 'year', year: 0 }); // will be set in effect

        // Derive all available years from both reports
        const allYears = useMemo(() => {
            const yearSet = new Set<number>();
            cryptoReport?.annual_summaries?.forEach(s => yearSet.add(s.fiscal_year));
            securitiesReport?.annual_summaries?.forEach(s => yearSet.add(s.fiscal_year));
            incomeReport?.annual_summaries?.forEach(s => yearSet.add(s.fiscal_year));
            return [...yearSet].sort((a, b) => b - a); // descending
        }, [cryptoReport, securitiesReport, incomeReport]);

        const last3Years = useMemo(() => allYears.slice(0, 3), [allYears]);

        // Auto-select most recent year on mount / when data changes
        const allYearsKey = allYears.join(',');
        useEffect(() => {
            if (allYears.length > 0 && view.type === 'year' && view.year === 0) {
                setView({ type: 'year', year: allYears[0] });
            }
        }, [allYearsKey]);

        // selectedYear for filtering (null = all years)
        const selectedYear = view.type === 'year' ? view.year : null;
        const isOlderYear = view.type === 'year' && view.year !== 0 && !last3Years.includes(view.year);

        // Palette: always gray for year-level wrapper (professional neutral)
        const wrapperPalette = 'gray';

        const activeReport = activeCategory === 'crypto' ? cryptoReport : activeCategory === 'securities' ? securitiesReport : null;
        const summaries = activeReport?.annual_summaries ?? [];
        const exportPath = activeCategory === 'crypto' ? 'fr-crypto-tax' : 'fr-securities-tax';
        const exportLabel = activeCategory === 'crypto' ? 'Cerfa 2086' : 'Form 2074';

        // Handler for when an override changes in any DisposalTable
        const handleOverrideChange = useCallback(() => {
            // Recompute tax (picks up new override values) then refresh reports silently
            fetch(`${API_URL}/pnl/versions/${versionId}/compute-tax`, { method: 'POST' })
                .then(() => onRefreshTaxData(true))
                .catch(() => { });
        }, [versionId, onRefreshTaxData]);

        // Compute totals for category cards based on view
        const cryptoTotals = useMemo(() =>
            view.type === 'year' && view.year !== 0
                ? computeCardTotalsForYear(cryptoReport, view.year)
                : computeCardTotals(cryptoReport),
            [cryptoReport, view],
        );
        const securitiesTotals = useMemo(() =>
            view.type === 'year' && view.year !== 0
                ? computeCardTotalsForYear(securitiesReport, view.year)
                : computeCardTotals(securitiesReport),
            [securitiesReport, view],
        );
        const incomeTotals = useMemo(() =>
            view.type === 'year' && view.year !== 0
                ? computeIncomeTotalsForYear(incomeReport, view.year)
                : computeIncomeTotals(incomeReport),
            [incomeReport, view],
        );

        // Compute combined totals per year for year metric cards
        const yearCardTotals = useMemo(() => {
            const map = new Map<number, CardTotals>();
            for (const year of last3Years) {
                const combined = computeCombinedTotalsForYear(cryptoReport, securitiesReport, year);
                const inc = computeIncomeTotalsForYear(incomeReport, year);
                map.set(year, {
                    totalTax: combined.totalTax + inc.totalTax,
                    taxableDisposals: combined.taxableDisposals + inc.taxableDisposals,
                    totalGains: combined.totalGains + inc.totalGains,
                    totalLosses: combined.totalLosses + inc.totalLosses,
                });
            }
            return map;
        }, [cryptoReport, securitiesReport, incomeReport, last3Years]);

        // All-years combined totals for "ALL" card
        const allTotals = useMemo<CardTotals>(() => {
            const c = computeCardTotals(cryptoReport);
            const s = computeCardTotals(securitiesReport);
            const i = computeIncomeTotals(incomeReport);
            return {
                totalTax: c.totalTax + s.totalTax + i.totalTax,
                taxableDisposals: c.taxableDisposals + s.taxableDisposals + i.taxableDisposals,
                totalGains: c.totalGains + s.totalGains + i.totalGains,
                totalLosses: c.totalLosses + s.totalLosses + i.totalLosses,
            };
        }, [cryptoReport, securitiesReport, incomeReport]);

        // Combined annual summaries for ALL view (merge crypto + securities per year)
        const combinedSummaries = useMemo<FrenchTaxAnnualSummary[]>(() => {
            const byYear = new Map<number, FrenchTaxAnnualSummary>();
            const merge = (summaries: FrenchTaxAnnualSummary[] | undefined) => {
                summaries?.forEach(s => {
                    const existing = byYear.get(s.fiscal_year);
                    if (existing) {
                        existing.total_gains += s.total_gains;
                        existing.total_losses += s.total_losses;
                        existing.net_taxable += s.net_taxable;
                        existing.tax_before_carryforward += s.tax_before_carryforward;
                        existing.loss_carryforward_used += s.loss_carryforward_used;
                        existing.loss_carried_forward += s.loss_carried_forward;
                        existing.tax_total += s.tax_total;
                        existing.transaction_count += s.transaction_count;
                    } else {
                        byYear.set(s.fiscal_year, { ...s });
                    }
                });
            };
            merge(cryptoReport?.annual_summaries);
            merge(securitiesReport?.annual_summaries);
            return [...byYear.values()];
        }, [cryptoReport, securitiesReport]);

        const handleExport = () => {
            const yearParam = selectedYear ? `?fiscal_year=${selectedYear}` : '';
            window.open(`${API_URL}/pnl/versions/${versionId}/${exportPath}/export${yearParam}`, '_blank');
        };

        const handleExportAll = (path: string) => {
            window.open(`${API_URL}/pnl/versions/${versionId}/${path}/export`, '_blank');
        };

        return (
            <div>
                {/* ═══ Year Tab Bar — single wrapper (Approach B) ═══ */}
                <div className="border border-gray-200 overflow-hidden transition-colors">
                    {/* Card row */}
                    <div className="flex">
                        {last3Years.map((year) => {
                            const isActive = view.type === 'year' && view.year === year;
                            const totals = yearCardTotals.get(year) ?? { totalTax: 0, taxableDisposals: 0, totalGains: 0, totalLosses: 0 };
                            return (
                                <YearMetricCard
                                    key={year}
                                    label={String(year)}
                                    totals={totals}
                                    active={isActive}
                                    baseCurrency={baseCurrency}
                                    onClick={() => setView({ type: 'year', year })}
                                    activePalette={wrapperPalette}
                                    onRecompute={onRecompute}
                                    isComputing={isComputing}
                                />
                            );
                        })}
                        <YearMetricCard
                            label="ALL"
                            totals={allTotals}
                            active={view.type === 'all'}
                            baseCurrency={baseCurrency}
                            onClick={() => setView({ type: 'all' })}
                            isLast
                            activePalette="blue"
                        />
                    </div>

                    {/* Older year breadcrumb */}
                    {isOlderYear && (
                        <div
                            className="flex items-center gap-1 px-3 py-1.5 bg-gray-50/40 border-b border-gray-100 cursor-pointer transition-colors hover:bg-gray-50"
                            onClick={() => setView({ type: 'all' })}
                        >
                            <LuArrowLeft size={12} />
                            <span className="text-xs font-semibold text-gray-700">
                                Viewing {view.type === 'year' ? view.year : ''}
                            </span>
                        </div>
                    )}

                    {/* Content area */}
                    <div className="bg-gray-100 p-4 transition-colors">

                        {view.type === 'all' ? (
                            /* ── ALL view: combined annual summary, no category sub-cards ── */
                            <>
                                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        colorScheme="blue"
                                        className="h-6 px-2 text-xs"
                                        onClick={onRecompute}
                                        loading={isComputing}
                                    >
                                        <LuRefreshCw size={12} />
                                        <span className="ml-1">Recalc All</span>
                                    </Button>
                                    <div className="flex flex-wrap gap-2">
                                        {hasCrypto && (
                                            <Button size="sm" variant="outline" colorScheme="blue" className="h-6 px-2 text-xs" onClick={() => handleExportAll('fr-crypto-tax')}>
                                                <FiDownload size={12} />
                                                <span className="ml-1">Export All Cerfa 2086</span>
                                            </Button>
                                        )}
                                        {hasSecurities && (
                                            <Button size="sm" variant="outline" className="h-6 px-2 text-xs border-purple-300 text-purple-700 hover:bg-purple-50" onClick={() => handleExportAll('fr-securities-tax')}>
                                                <FiDownload size={12} />
                                                <span className="ml-1">Export All Form 2074</span>
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                {combinedSummaries.length > 0 && (
                                    <AnnualSummaryTable
                                        summaries={combinedSummaries}
                                        selectedYear={null}
                                        onSelectYear={() => { }}
                                        baseCurrency={baseCurrency}
                                        onViewYear={(year) => setView({ type: 'year', year })}
                                    />
                                )}
                            </>
                        ) : (
                            /* ── Year view: Crypto / Securities sub-cards ── */
                            <>
                                {/* Category sub-cards — Approach A */}
                                <div className="flex flex-col gap-0 mb-0 sm:flex-row">
                                    {hasCrypto && (
                                        <SummaryCard
                                            label="Crypto"
                                            subtitle="Art. 150 VH bis"
                                            palette="blue"
                                            totals={cryptoTotals}
                                            baseCurrency={baseCurrency}
                                            active={activeCategory === 'crypto'}
                                            onClick={() => setActiveCategory('crypto')}
                                        />
                                    )}
                                    {hasSecurities && (
                                        <SummaryCard
                                            label="Securities"
                                            subtitle="Art. 150-0 A"
                                            palette="purple"
                                            totals={securitiesTotals}
                                            baseCurrency={baseCurrency}
                                            active={activeCategory === 'securities'}
                                            onClick={() => setActiveCategory('securities')}
                                        />
                                    )}
                                    {hasIncome && (
                                        <SummaryCard
                                            label="Income"
                                            subtitle="PFU 30%"
                                            palette="teal"
                                            totals={incomeTotals}
                                            baseCurrency={baseCurrency}
                                            active={activeCategory === 'income'}
                                            onClick={() => setActiveCategory('income')}
                                        />
                                    )}
                                </div>

                                {/* Category content area — border merges with active sub-card tab */}
                                {(() => {
                                    const contentClass = activeCategory === 'crypto'
                                        ? 'bg-blue-50/60 border-blue-200'
                                        : activeCategory === 'securities'
                                            ? 'bg-purple-50/60 border-purple-200'
                                            : 'bg-teal-50/60 border-teal-200';
                                    return (
                                        <div className={`border border-t-0 p-4 transition-colors ${contentClass}`}>
                                            {activeCategory === 'income' ? (
                                                /* ── Income content: PFU entries table ── */
                                                <IncomeTaxContent
                                                    incomeReport={incomeReport}
                                                    selectedYear={selectedYear}
                                                    baseCurrency={baseCurrency}
                                                />
                                            ) : (
                                                <>
                                                    {/* Export button */}
                                                    <div className="flex justify-end mb-3">
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className={`h-6 px-2 text-xs ${activeCategory === 'crypto' ? 'border-blue-300 text-blue-700 hover:bg-blue-50' : 'border-purple-300 text-purple-700 hover:bg-purple-50'}`}
                                                            onClick={handleExport}
                                                        >
                                                            <FiDownload size={12} />
                                                            <span className="ml-1">Export {exportLabel}</span>
                                                        </Button>
                                                    </div>

                                                    {/* Annual summary table */}
                                                    {summaries.length > 0 && (
                                                        <AnnualSummaryTable
                                                            summaries={summaries.filter(s => s.fiscal_year === selectedYear)}
                                                            selectedYear={selectedYear}
                                                            onSelectYear={() => { }}
                                                            baseCurrency={baseCurrency}
                                                        />
                                                    )}

                                                    {/* Disposal line items (server-paginated from /realized-pnl) */}
                                                    <DisposalTable
                                                        versionId={versionId}
                                                        baseCurrency={baseCurrency}
                                                        selectedYear={selectedYear}
                                                        frTaxCategory={activeCategory}
                                                        onTransactionClick={onTransactionClick}
                                                        onUnitClick={onUnitClick}
                                                        onAssetClick={onAssetClick}
                                                        onOverrideChange={handleOverrideChange}
                                                    />
                                                </>
                                            )}
                                        </div>
                                    );
                                })()}
                            </>
                        )}
                    </div>
                </div>
            </div>
        );
    };

// ─── Summary Card ───────────────────────────────────────────────────────────

interface CardTotals {
    totalTax: number;
    taxableDisposals: number;
    totalGains: number;
    totalLosses: number;
}

function computeCardTotals(report: FrenchTaxReport | FrenchSecuritiesTaxReport | null): CardTotals {
    if (!report || !report.annual_summaries) {
        return { totalTax: 0, taxableDisposals: 0, totalGains: 0, totalLosses: 0 };
    }
    return report.annual_summaries.reduce(
        (acc, s) => ({
            totalTax: acc.totalTax + s.tax_total,
            taxableDisposals: acc.taxableDisposals + s.transaction_count,
            totalGains: acc.totalGains + s.total_gains,
            totalLosses: acc.totalLosses + s.total_losses,
        }),
        { totalTax: 0, taxableDisposals: 0, totalGains: 0, totalLosses: 0 },
    );
}

function computeCardTotalsForYear(report: FrenchTaxReport | FrenchSecuritiesTaxReport | null, year: number): CardTotals {
    if (!report || !report.annual_summaries) {
        return { totalTax: 0, taxableDisposals: 0, totalGains: 0, totalLosses: 0 };
    }
    const filtered = report.annual_summaries.filter(s => s.fiscal_year === year);
    return filtered.reduce(
        (acc, s) => ({
            totalTax: acc.totalTax + s.tax_total,
            taxableDisposals: acc.taxableDisposals + s.transaction_count,
            totalGains: acc.totalGains + s.total_gains,
            totalLosses: acc.totalLosses + s.total_losses,
        }),
        { totalTax: 0, taxableDisposals: 0, totalGains: 0, totalLosses: 0 },
    );
}

/** Combine totals from both crypto and securities for a given year */
function computeCombinedTotalsForYear(
    cryptoReport: FrenchTaxReport | null,
    securitiesReport: FrenchSecuritiesTaxReport | null,
    year: number,
): CardTotals {
    const c = computeCardTotalsForYear(cryptoReport, year);
    const s = computeCardTotalsForYear(securitiesReport, year);
    return {
        totalTax: c.totalTax + s.totalTax,
        taxableDisposals: c.taxableDisposals + s.taxableDisposals,
        totalGains: c.totalGains + s.totalGains,
        totalLosses: c.totalLosses + s.totalLosses,
    };
}

/** Map income tax report to CardTotals (gains=gross, losses=withholding credits) */
function computeIncomeTotals(report: FrenchIncomeTaxReport | null): CardTotals {
    if (!report || !report.annual_summaries) {
        return { totalTax: 0, taxableDisposals: 0, totalGains: 0, totalLosses: 0 };
    }
    return report.annual_summaries.reduce(
        (acc, s) => ({
            totalTax: acc.totalTax + s.tax_total,
            taxableDisposals: acc.taxableDisposals + s.event_count,
            totalGains: acc.totalGains + s.total_gross_income,
            totalLosses: acc.totalLosses + s.total_withholding_credits,
        }),
        { totalTax: 0, taxableDisposals: 0, totalGains: 0, totalLosses: 0 },
    );
}

function computeIncomeTotalsForYear(report: FrenchIncomeTaxReport | null, year: number): CardTotals {
    if (!report || !report.annual_summaries) {
        return { totalTax: 0, taxableDisposals: 0, totalGains: 0, totalLosses: 0 };
    }
    const filtered = report.annual_summaries.filter(s => s.fiscal_year === year);
    return filtered.reduce(
        (acc, s) => ({
            totalTax: acc.totalTax + s.tax_total,
            taxableDisposals: acc.taxableDisposals + s.event_count,
            totalGains: acc.totalGains + s.total_gross_income,
            totalLosses: acc.totalLosses + s.total_withholding_credits,
        }),
        { totalTax: 0, taxableDisposals: 0, totalGains: 0, totalLosses: 0 },
    );
}

// Tailwind JIT can't resolve `bg-${palette}-50`-style interpolation, so every
// shade actually used by SummaryCard is pre-declared here as a literal class
// string and looked up by the fixed 3-value `palette` prop at render time.
const SUMMARY_PALETTE: Record<'blue' | 'purple' | 'teal', {
    bgActive: string; bgInactive: string; borderActive: string; borderInactive: string;
    borderBottomActive: string; borderBottomInactive: string; textActive: string;
    hoverBorder: string; hoverBgActive: string; hoverBgInactive: string;
}> = {
    blue: {
        bgActive: 'bg-blue-50', bgInactive: 'bg-blue-50/60',
        borderActive: 'border-blue-200', borderInactive: 'border-blue-100',
        borderBottomActive: 'border-b-blue-50', borderBottomInactive: 'border-b-blue-100',
        textActive: 'text-blue-700',
        hoverBorder: 'hover:border-blue-300', hoverBgActive: 'hover:bg-blue-50', hoverBgInactive: 'hover:bg-blue-100/50',
    },
    purple: {
        bgActive: 'bg-purple-50', bgInactive: 'bg-purple-50/60',
        borderActive: 'border-purple-200', borderInactive: 'border-purple-100',
        borderBottomActive: 'border-b-purple-50', borderBottomInactive: 'border-b-purple-100',
        textActive: 'text-purple-700',
        hoverBorder: 'hover:border-purple-300', hoverBgActive: 'hover:bg-purple-50', hoverBgInactive: 'hover:bg-purple-100/50',
    },
    teal: {
        bgActive: 'bg-teal-50', bgInactive: 'bg-teal-50/60',
        borderActive: 'border-teal-200', borderInactive: 'border-teal-100',
        borderBottomActive: 'border-b-teal-50', borderBottomInactive: 'border-b-teal-100',
        textActive: 'text-teal-700',
        hoverBorder: 'hover:border-teal-300', hoverBgActive: 'hover:bg-teal-50', hoverBgInactive: 'hover:bg-teal-100/50',
    },
};

const SummaryCard: React.FC<{
    label: string;
    subtitle: string;
    palette: 'blue' | 'purple' | 'teal';
    totals: CardTotals;
    baseCurrency: string;
    active: boolean;
    onClick: () => void;
}> = ({ label, subtitle, palette, totals, baseCurrency, active, onClick }) => {
    const p = SUMMARY_PALETTE[palette];
    return (
        <div
            className={`relative flex-1 cursor-pointer border border-b-2 px-3 py-2 transition-colors ${p.hoverBorder} ${active
                ? `z-10 -mb-px ${p.bgActive} ${p.borderActive} ${p.borderBottomActive} ${p.hoverBgActive}`
                : `${p.bgInactive} ${p.borderInactive} ${p.borderBottomInactive} ${p.hoverBgInactive}`
                }`}
            onClick={onClick}
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-2">
                    <span className={`text-sm font-bold ${active ? p.textActive : 'text-gray-700'}`}>
                        {label}
                    </span>
                    <span className="text-[10px] text-gray-400">{subtitle}</span>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
                    <span className="text-[10px] text-gray-500">{totals.taxableDisposals} disposals</span>
                    <span className="text-xs font-semibold text-green-600">+{formatCurrency(totals.totalGains, baseCurrency)}</span>
                    <span className="text-xs font-semibold text-red-600">{totals.totalLosses > 0 ? `-${formatCurrency(totals.totalLosses, baseCurrency)}` : formatCurrency(0, baseCurrency)}</span>
                    <span className={`text-sm font-bold ${totals.totalTax > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        Tax: {formatCurrency(totals.totalTax, baseCurrency)}
                    </span>
                </div>
            </div>
        </div>
    );
};

// ─── Year Metric Card (tab header inside single wrapper) ────────────────────

const YEAR_METRIC_PALETTE: Record<'gray' | 'blue', {
    bgActive: string; bgInactive: string; borderRight: string;
    borderBottomActive: string; borderBottomInactive: string; hoverBgInactive: string;
}> = {
    gray: {
        bgActive: 'bg-gray-100', bgInactive: 'bg-gray-50/60', borderRight: 'border-gray-200',
        borderBottomActive: 'border-b-gray-100', borderBottomInactive: 'border-b-gray-200',
        hoverBgInactive: 'hover:bg-gray-100/50',
    },
    blue: {
        bgActive: 'bg-blue-100', bgInactive: 'bg-blue-50/60', borderRight: 'border-blue-200',
        borderBottomActive: 'border-b-blue-100', borderBottomInactive: 'border-b-blue-200',
        hoverBgInactive: 'hover:bg-blue-100/50',
    },
};

const YearMetricCard: React.FC<{
    label: string;
    totals: CardTotals;
    active: boolean;
    baseCurrency: string;
    onClick: () => void;
    isLast?: boolean;
    activePalette: 'gray' | 'blue';
    onRecompute?: () => void;
    isComputing?: boolean;
}> = ({ label, totals, active, baseCurrency, onClick, isLast, activePalette, onRecompute, isComputing }) => {
    const p = YEAR_METRIC_PALETTE[activePalette];
    return (
        <div
            className={`flex-1 cursor-pointer border-b-2 p-3 transition-colors ${isLast ? '' : `border-r ${p.borderRight}`} ${active ? `${p.bgActive} ${p.borderBottomActive}` : `${p.bgInactive} ${p.borderBottomInactive} ${p.hoverBgInactive}`}`}
            onClick={onClick}
        >
            <div className="mb-1 flex items-start justify-between">
                <Badge colorScheme={activePalette} className={`text-sm font-extrabold ${active ? '' : 'opacity-70'}`}>
                    {label}
                </Badge>
                <span className="text-lg font-bold text-gray-700">
                    {formatCurrency(totals.totalTax, baseCurrency)}
                </span>
            </div>
            <div className="flex items-end justify-between">
                <div className="flex items-center gap-3">
                    <span className="text-[10px] text-gray-500">{totals.taxableDisposals} disposals</span>
                    <span className="text-xs font-semibold text-green-600">
                        +{formatCurrency(totals.totalGains, baseCurrency)}
                    </span>
                    <span className="text-xs font-semibold text-red-600">
                        {totals.totalLosses > 0 ? `-${formatCurrency(totals.totalLosses, baseCurrency)}` : formatCurrency(0, baseCurrency)}
                    </span>
                </div>
                {active && onRecompute && (
                    <Button
                        size="sm"
                        variant="ghost"
                        colorScheme="gray"
                        className="h-5 px-1"
                        onClick={(e) => { e.stopPropagation(); onRecompute(); }}
                        loading={isComputing}
                        title={`Recalculate ${label}`}
                    >
                        <LuRefreshCw size={11} />
                    </Button>
                )}
            </div>
        </div>
    );
};

// ─── Annual Summary Table ───────────────────────────────────────────────────

const AnnualSummaryTable: React.FC<{
    summaries: FrenchTaxAnnualSummary[];
    selectedYear: number | null;
    onSelectYear: (y: number | null) => void;
    baseCurrency: string;
    onViewYear?: (year: number) => void;
}> = ({ summaries, selectedYear, onSelectYear, baseCurrency, onViewYear }) => (
    <div className="mb-5">
        <div className="mb-2 text-xs font-semibold text-gray-600">Annual Summary</div>
        <div className="overflow-x-auto">
            <table className="w-full text-xs">
                <thead>
                    <tr className="border-b border-gray-200">
                        <th className="px-2 py-1 text-left">Year</th>
                        <th className="px-2 py-1 text-right">Gains</th>
                        <th className="px-2 py-1 text-right">Losses</th>
                        <th className="px-2 py-1 text-right">Net Taxable</th>
                        <th className="px-2 py-1 text-right">Tax</th>
                        <th className="px-2 py-1 text-right">Carryforward</th>
                        <th className="px-2 py-1 text-right">Taxable Disposals</th>
                        {onViewYear && <th className="w-10 px-2 py-1 text-center" />}
                    </tr>
                </thead>
                <tbody>
                    {[...summaries].sort((a, b) => b.fiscal_year - a.fiscal_year).map((s, idx) => (
                        <tr
                            key={s.fiscal_year}
                            className={`cursor-pointer border-b border-gray-100 ${selectedYear === s.fiscal_year ? 'bg-blue-50' : idx % 2 === 1 ? 'bg-gray-50/50' : ''}`}
                            onClick={() => onSelectYear(s.fiscal_year === selectedYear ? null : s.fiscal_year)}
                        >
                            <td className="px-2 py-1 font-semibold">{s.fiscal_year}</td>
                            <td className="px-2 py-1 text-right text-green-600">{formatCurrency(s.total_gains, baseCurrency)}</td>
                            <td className="px-2 py-1 text-right text-red-600">
                                {s.total_losses > 0 ? `-${formatCurrency(s.total_losses, baseCurrency)}` : '—'}
                            </td>
                            <td className="px-2 py-1 text-right"><GainBadge value={s.net_taxable} currency={baseCurrency} /></td>
                            <td className={`px-2 py-1 text-right font-semibold ${s.tax_total > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                                {formatCurrency(s.tax_total, baseCurrency)}
                            </td>
                            <td className="px-2 py-1 text-right text-orange-600">
                                {s.loss_carried_forward < 0 ? formatCurrency(s.loss_carried_forward, baseCurrency) : '—'}
                            </td>
                            <td className="px-2 py-1 text-right">{s.transaction_count}</td>
                            {onViewYear && (
                                <td className="px-2 py-1 text-center">
                                    <button
                                        type="button"
                                        className="inline-flex h-[22px] w-[22px] items-center justify-center text-blue-500 transition-colors hover:bg-blue-50 hover:text-blue-700"
                                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onViewYear(s.fiscal_year); }}
                                    >
                                        <LuEye size={13} />
                                    </button>
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    </div>
);

// ─── Disposal Table (server-paginated from /realized-pnl, with filters + sort) ──

const DISPOSAL_PAGE_SIZES = [25, 50, 100] as const;

const DisposalTable: React.FC<{
    versionId: number;
    baseCurrency: string;
    selectedYear: number | null;
    frTaxCategory?: string;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
    onAssetClick?: (assetId: number) => void;
    onOverrideChange?: () => void;
}> = ({
    versionId, baseCurrency, selectedYear,
    frTaxCategory,
    onTransactionClick, onUnitClick, onAssetClick,
    onOverrideChange,
}) => {
        const [page, setPage] = useState(1);
        const [pageSize, setPageSize] = useState(25);

        // Sorting
        const [sortBy, setSortBy] = useState<string | null>(null);
        const [sortOrder, setSortOrder] = useState<string>('asc');

        // Taxable / Non-Taxable pill toggles (both off = show all)
        const [showTaxable, setShowTaxable] = useState(false);
        const [showNonTaxable, setShowNonTaxable] = useState(false);

        // Multi-select filters
        const [signFilter, setSignFilter] = useState<string[]>([]);
        const [holdingFilter, setHoldingFilter] = useState<string[]>([]);
        const [originFilter, setOriginFilter] = useState<string[]>([]);
        const [assetFilter, setAssetFilter] = useState<string[]>([]);
        const [accountFilter, setAccountFilter] = useState<string[]>([]);

        // Filter UI state
        const [filtersExpanded, setFiltersExpanded] = useState(false);
        const [assetDropdownOpen, setAssetDropdownOpen] = useState(false);
        const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);

        // Filter options from API
        const [filterOpts, setFilterOpts] = useState<RealizedFilterOptions | null>(null);
        const [filterVersion, setFilterVersion] = useState(0);

        const handleSort = (field: string) => {
            if (sortBy === field) {
                setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
            } else {
                setSortBy(field);
                setSortOrder(field === 'pnl' ? 'desc' : 'asc');
            }
        };

        // Toggle fr_tax_effective: flip the boolean, or reset if already overridden back to default
        const handleTaxOverrideToggle = useCallback(async (entry: RealizedPnLEntry) => {
            const currentEffective = entry.fr_tax_effective ?? entry.taxable;
            const newValue = !currentEffective;
            // If toggling back to the original computed value, send null to clear the override
            const isResetToDefault = newValue === entry.taxable;
            try {
                const res = await fetch(
                    `${API_URL}/pnl/versions/${versionId}/realized-pnl/${entry.pnl_id}/fr-tax-override`,
                    {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ is_taxable: isResetToDefault ? null : newValue }),
                    },
                );
                if (!res.ok) throw new Error('Failed to update override');
                const result = await res.json();
                // Update entry in-place
                entry.fr_tax_effective = result.fr_tax_effective;
                // Force re-render + re-fetch filter counts
                setFilterVersion(v => v + 1);
                onOverrideChange?.();
            } catch {
                // Silently fail — could add toast later
            }
        }, [versionId]);

        // Reset page on changes
        useEffect(() => { setPage(1); }, [selectedYear, showTaxable, showNonTaxable, frTaxCategory, sortBy, sortOrder, signFilter, holdingFilter, originFilter, assetFilter, accountFilter]);

        // Build query params
        const queryParams = useMemo(() => {
            const params: Record<string, string | number | boolean | undefined> = {};
            // Pill logic: both on or both off = show all; one on = filter to that
            if (showTaxable && !showNonTaxable) params.is_taxable = true;
            else if (showNonTaxable && !showTaxable) params.is_taxable = false;
            // both on or both off → no is_taxable param → all entries
            if (selectedYear) {
                params.date_from = `${selectedYear}-01-01`;
                params.date_to = `${selectedYear}-12-31`;
            }
            if (frTaxCategory) params.fr_tax_category = frTaxCategory;
            if (signFilter.length === 1) params.pnl_sign = signFilter[0];
            if (holdingFilter.length === 1) params.holding_period = holdingFilter[0];
            if (originFilter.length === 1) params.is_fee = originFilter[0] === 'fee';
            if (assetFilter.length === 1) params.asset_id = Number(assetFilter[0]);
            if (accountFilter.length === 1) params.account_id = Number(accountFilter[0]);
            if (sortBy) { params.sort_by = sortBy; params.order = sortOrder; }
            return params;
        }, [selectedYear, showTaxable, showNonTaxable, frTaxCategory, signFilter, holdingFilter, originFilter, assetFilter, accountFilter, sortBy, sortOrder]);

        // Fetch data
        const { data: entries, total, isLoading, isRefreshing } = useLazyPaginatedQuery<RealizedPnLEntry>({
            endpoint: `/pnl/versions/${versionId}/realized-pnl`,
            page,
            limit: pageSize,
            params: queryParams,
        });

        // Fetch filter options
        useEffect(() => {
            const qs = new URLSearchParams();
            if (frTaxCategory) qs.set('fr_tax_category', frTaxCategory);
            if (selectedYear) {
                qs.set('date_from', `${selectedYear}-01-01`);
                qs.set('date_to', `${selectedYear}-12-31`);
            }
            fetch(`${API_URL}/pnl/versions/${versionId}/realized-pnl/filter-options?${qs}`)
                .then(r => r.json())
                .then(setFilterOpts)
                .catch(() => { });
        }, [versionId, frTaxCategory, selectedYear, filterVersion]);

        // Total entries for the category/year (unfiltered by pills)
        const totalEntries = useMemo(() => {
            if (!filterOpts?.taxable_options) return 0;
            return filterOpts.taxable_options.reduce((sum, o) => sum + (o.count ?? 0), 0);
        }, [filterOpts]);

        const taxableCount = filterOpts?.taxable_options?.find(o => o.value === 'true')?.count ?? 0;
        const nonTaxableCount = filterOpts?.taxable_options?.find(o => o.value === 'false')?.count ?? 0;

        const hasAnyFilter = signFilter.length > 0 || holdingFilter.length > 0
            || originFilter.length > 0 || assetFilter.length > 0 || accountFilter.length > 0;

        const clearFilters = () => {
            setSignFilter([]); setHoldingFilter([]);
            setOriginFilter([]); setAssetFilter([]); setAccountFilter([]);
        };

        // Active filter chips
        const activeChips = useMemo<FilterChipData[]>(() => {
            const chips: FilterChipData[] = [];
            signFilter.forEach(v => {
                const opt = filterOpts?.pnl_sign_options?.find(o => o.value === v);
                chips.push({ id: `sign-${v}`, label: opt?.label || v, color: v === 'gain' ? 'green' : 'red', onClear: () => setSignFilter(p => p.filter(x => x !== v)) });
            });
            holdingFilter.forEach(v => {
                const opt = filterOpts?.holding_period_options?.find(o => o.value === v);
                chips.push({ id: `holding-${v}`, label: opt?.label || v, color: 'gray', onClear: () => setHoldingFilter(p => p.filter(x => x !== v)) });
            });
            originFilter.forEach(v => {
                const opt = filterOpts?.origin_type_options?.find(o => o.value === v);
                chips.push({ id: `origin-${v}`, label: opt?.label || v, color: v === 'fee' ? 'orange' : 'blue', onClear: () => setOriginFilter(p => p.filter(x => x !== v)) });
            });
            assetFilter.forEach(v => {
                const opt = filterOpts?.assets?.find(o => o.value === v);
                chips.push({ id: `asset-${v}`, label: `Asset: ${opt?.label || v}`, color: 'purple', onClear: () => setAssetFilter(p => p.filter(x => x !== v)) });
            });
            accountFilter.forEach(v => {
                const opt = filterOpts?.accounts?.find(o => o.value === v);
                chips.push({ id: `account-${v}`, label: `Acct: ${opt?.label || v}`, color: 'teal', onClear: () => setAccountFilter(p => p.filter(x => x !== v)) });
            });
            return chips;
        }, [signFilter, holdingFilter, originFilter, assetFilter, accountFilter, filterOpts]);

        const fmtDate = (iso: string) => {
            const d = new Date(iso);
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
        };

        const pageCount = Math.max(1, Math.ceil(total / pageSize));
        const headingText = `Disposal Line Items ${selectedYear ? `— ${selectedYear}` : '— All Years'}`;

        const paginationBar = total > DISPOSAL_PAGE_SIZES[0] ? (
            <div className="flex w-full items-center justify-between py-2 px-3">
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500">Rows:</span>
                    <div className="inline-flex overflow-hidden border border-gray-200">
                        {DISPOSAL_PAGE_SIZES.map(size => (
                            <Button key={size} size="sm"
                                variant={pageSize === size ? 'subtle' : 'ghost'}
                                colorScheme={pageSize === size ? 'blue' : 'gray'}
                                onClick={() => { setPageSize(size); setPage(1); }}
                                className="h-6 px-2 text-xs">
                                {size}
                            </Button>
                        ))}
                    </div>
                </div>
                <span className="text-[10px] text-gray-500">
                    {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
                </span>
                <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => setPage(1)} disabled={page <= 1}>
                        <FiChevronsLeft size={12} />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => setPage(page - 1)} disabled={page <= 1}>
                        <FiChevronLeft size={14} />
                    </Button>
                    <span className="mx-1 text-xs text-gray-600">{page} / {pageCount}</span>
                    <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => setPage(page + 1)} disabled={page >= pageCount}>
                        <FiChevronRight size={14} />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => setPage(pageCount)} disabled={page >= pageCount}>
                        <FiChevronsRight size={12} />
                    </Button>
                </div>
            </div>
        ) : null;

        return (
            <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="text-xs font-semibold text-gray-600">
                            {headingText}
                        </div>
                        <div className="flex gap-1.5">
                            <Button
                                size="sm"
                                variant={showTaxable ? 'subtle' : 'outline'}
                                colorScheme={showTaxable ? 'red' : 'gray'}
                                onClick={() => setShowTaxable(p => !p)}
                                className="h-6 px-2.5 text-xs"
                            >
                                Taxable ({taxableCount})
                            </Button>
                            <Button
                                size="sm"
                                variant={showNonTaxable ? 'subtle' : 'outline'}
                                colorScheme={showNonTaxable ? 'green' : 'gray'}
                                onClick={() => setShowNonTaxable(p => !p)}
                                className="h-6 px-2.5 text-xs"
                            >
                                Non-Taxable ({nonTaxableCount})
                            </Button>
                        </div>
                    </div>
                    <span className="text-[10px] text-gray-400">
                        {isRefreshing ? 'Refreshing…' : `${total} / ${totalEntries} entries`}
                    </span>
                </div>

                {/* ─── Collapsible Filter Section ─── */}
                <div className="mb-3">
                    <div className={`overflow-visible border bg-gray-50 ${hasAnyFilter ? 'border-blue-300' : 'border-gray-200'}`}>
                        <div
                            className="flex flex-wrap items-center justify-between p-2.5 cursor-pointer transition-colors hover:bg-gray-100"
                            onClick={() => setFiltersExpanded(p => !p)}
                        >
                            <div className="flex flex-wrap items-center gap-1.5">
                                <div className={`transition-transform duration-200 ${filtersExpanded ? 'rotate-0' : '-rotate-90'}`}>
                                    <LuChevronDown size={14} />
                                </div>
                                <LuFilter size={12} />
                                <span className="text-xs font-semibold">Filters</span>
                                {activeChips.length > 0 && (
                                    <Badge colorScheme="blue">{activeChips.length} active</Badge>
                                )}
                                {activeChips.map(chip => <FilterChip key={chip.id} chip={chip} />)}
                            </div>
                            <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                                {hasAnyFilter && (
                                    <Button size="sm" variant="ghost" className="h-6 px-1 text-gray-500 hover:text-gray-700" onClick={clearFilters}>
                                        <LuRotateCcw size={10} />
                                        <span className="ml-0.5 text-[10px]">Clear All</span>
                                    </Button>
                                )}
                            </div>
                        </div>

                        {filtersExpanded && (
                            <div className="overflow-visible p-3 pt-1">
                                <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
                                    {filterOpts?.origin_type_options && filterOpts.origin_type_options.length > 0 && (
                                        <RFilterCard label="Origin" icon="📋" options={filterOpts.origin_type_options}
                                            selected={originFilter} onChange={setOriginFilter} color="blue" />
                                    )}
                                    {filterOpts?.pnl_sign_options && filterOpts.pnl_sign_options.length > 0 && (
                                        <RFilterCard label="Gain / Loss" icon="📊" options={filterOpts.pnl_sign_options}
                                            selected={signFilter} onChange={setSignFilter} color="green" />
                                    )}
                                    {filterOpts?.holding_period_options && filterOpts.holding_period_options.length > 0 && (
                                        <RFilterCard label="Holding" icon="⏱️" options={filterOpts.holding_period_options}
                                            selected={holdingFilter} onChange={setHoldingFilter} color="gray" />
                                    )}
                                    {filterOpts && filterOpts.assets.length > 1 && (
                                        <RDropdownCard label="Asset" icon="🪙" options={filterOpts.assets}
                                            selected={assetFilter} onChange={setAssetFilter} color="purple"
                                            isOpen={assetDropdownOpen}
                                            onToggle={() => { setAssetDropdownOpen(p => !p); setAccountDropdownOpen(false); }}
                                            onClose={() => setAssetDropdownOpen(false)} />
                                    )}
                                    {filterOpts && filterOpts.accounts.length > 1 && (
                                        <RDropdownCard label="Account" icon="👤" options={filterOpts.accounts}
                                            selected={accountFilter} onChange={setAccountFilter} color="teal"
                                            isOpen={accountDropdownOpen}
                                            onToggle={() => { setAccountDropdownOpen(p => !p); setAssetDropdownOpen(false); }}
                                            onClose={() => setAccountDropdownOpen(false)} />
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {isLoading ? (
                    <div className="flex justify-center py-8">
                        <Spinner size="sm" />
                        <span className="ml-2 text-xs text-gray-500">Loading disposals…</span>
                    </div>
                ) : entries.length === 0 ? (
                    <div className="py-6 text-center">
                        <span className="text-xs text-gray-400">
                            {hasAnyFilter ? 'No entries match filters.' : 'No disposals found.'}
                        </span>
                    </div>
                ) : (
                    <div>
                        {paginationBar}
                        <div className="overflow-x-auto">
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                        <th style={{ ...TH, textAlign: 'left', fontSize: 9 }}>ID</th>
                                        <SortHeader label="Date" field="date" current={sortBy} order={sortOrder} onSort={handleSort} />
                                        <th style={{ ...TH, textAlign: 'left' }}>Asset</th>
                                        <th style={{ ...TH, textAlign: 'left' }}>Account</th>
                                        <th style={{ ...TH, textAlign: 'right' }}>Qty</th>
                                        <th style={{ ...TH, textAlign: 'right' }}>Proceeds</th>
                                        <th style={{ ...TH, textAlign: 'right' }}>Cost Basis</th>
                                        <SortHeader label="P&L" field="pnl" current={sortBy} order={sortOrder} align="right" onSort={handleSort} />
                                        <th style={{ ...TH, textAlign: 'center' }}>Taxable</th>
                                        <th style={{ ...TH, textAlign: 'center' }}>FR Tax</th>
                                        <th style={{ ...TH, textAlign: 'center' }}>Origin</th>
                                        <SortHeader label="Days" field="holding_period" current={sortBy} order={sortOrder} align="right" onSort={handleSort} />
                                        <th style={{ ...TH, textAlign: 'left' }}>TX</th>
                                        <th style={{ ...TH, textAlign: 'left' }}>Unit</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {entries.map((e, idx) => (
                                        <tr key={e.pnl_id ?? idx} style={{ borderBottom: '1px solid #f1f3f5' }}>
                                            <td style={{ ...TD }}>
                                                <span className="font-mono text-[9px] text-gray-400">#{e.pnl_id}</span>
                                            </td>
                                            <td style={{ ...TD }}>
                                                <span className="whitespace-nowrap text-[10px] text-gray-600">
                                                    {e.realized_at ? fmtDate(e.realized_at) : '-'}
                                                </span>
                                            </td>
                                            <td style={{ ...TD }}>
                                                {onAssetClick ? (
                                                    <span
                                                        className="block max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-medium text-purple-600 cursor-pointer hover:underline"
                                                        onClick={() => e.asset.id && onAssetClick(e.asset.id)}
                                                    >
                                                        {e.asset.label || e.asset.symbol}
                                                    </span>
                                                ) : (
                                                    <span className="text-[10px] font-medium">{e.asset.label || e.asset.symbol}</span>
                                                )}
                                            </td>
                                            <td style={{ ...TD }}>
                                                <div className="flex items-center gap-1">
                                                    <span className="block max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-gray-500">
                                                        {e.account_name || '-'}
                                                    </span>
                                                </div>
                                            </td>
                                            <td style={{ ...TD, textAlign: 'right' }}>
                                                <ValueDisplay value={e.qty} />
                                            </td>
                                            <td style={{ ...TD, textAlign: 'right' }}>
                                                <ValueDisplay value={e.proceeds_in_base} currency={baseCurrency} />
                                            </td>
                                            <td style={{ ...TD, textAlign: 'right' }}>
                                                <ValueDisplay value={e.cost_basis_in_base} currency={baseCurrency} />
                                            </td>
                                            <td style={{ ...TD, textAlign: 'right' }}>
                                                <span className={`text-[10px] font-medium ${e.pnl_in_base >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                    <ValueDisplay value={e.pnl_in_base} currency={baseCurrency} />
                                                </span>
                                            </td>
                                            <td style={{ ...TD, textAlign: 'center' }}>
                                                <Tooltip content={e.taxable ? 'Taxable (computed)' : 'Non-Taxable (computed)'}>
                                                    <div className="flex items-center justify-center">
                                                        <div className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-full ${e.taxable ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                                                            {e.taxable ? <LuCircleAlert size={11} /> : <LuCircleCheck size={11} />}
                                                        </div>
                                                    </div>
                                                </Tooltip>
                                            </td>
                                            <td style={{ ...TD, textAlign: 'center' }}>
                                                <Tooltip content={
                                                    (e.fr_tax_effective ?? e.taxable) !== e.taxable
                                                        ? `Override: ${(e.fr_tax_effective ?? e.taxable) ? 'Taxable' : 'Non-Taxable'} (click to reset)`
                                                        : `${(e.fr_tax_effective ?? e.taxable) ? 'Taxable' : 'Non-Taxable'} for FR tax (click to override)`
                                                }>
                                                    <div
                                                        className="flex cursor-pointer items-center justify-center"
                                                        onClick={() => handleTaxOverrideToggle(e)}
                                                    >
                                                        <div
                                                            className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-full ${(e.fr_tax_effective ?? e.taxable) ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'} ${(e.fr_tax_effective ?? e.taxable) !== e.taxable ? `outline outline-2 outline-dashed outline-offset-2 ${(e.fr_tax_effective ?? e.taxable) ? 'outline-red-400' : 'outline-green-400'}` : ''}`}
                                                        >
                                                            {(e.fr_tax_effective ?? e.taxable) ? <LuCircleAlert size={11} /> : <LuCircleCheck size={11} />}
                                                        </div>
                                                    </div>
                                                </Tooltip>
                                            </td>
                                            <td style={{ ...TD, textAlign: 'center' }}>
                                                <Badge colorScheme={e.is_fee ? 'orange' : 'blue'}>
                                                    {e.is_fee ? 'Fee' : 'Disposal'}
                                                </Badge>
                                            </td>
                                            <td style={{ ...TD, textAlign: 'right' }}>
                                                <span className="text-[10px] text-gray-500">{e.holding_period_days ?? '-'}</span>
                                            </td>
                                            <td style={{ ...TD }}>
                                                {e.transaction_id ? (
                                                    <span
                                                        className={`font-mono text-[10px] text-blue-500 ${onTransactionClick ? 'cursor-pointer hover:underline' : ''}`}
                                                        onClick={() => onTransactionClick?.(e.transaction_id!)}
                                                    >
                                                        #{e.transaction_id}
                                                    </span>
                                                ) : <span className="text-[10px] text-gray-400">-</span>}
                                            </td>
                                            <td style={{ ...TD }}>
                                                {e.unit_id ? (
                                                    <span
                                                        className={`font-mono text-[10px] text-blue-500 ${onUnitClick ? 'cursor-pointer hover:underline' : ''}`}
                                                        onClick={() => onUnitClick?.(e.unit_id!)}
                                                    >
                                                        #{e.unit_id}
                                                    </span>
                                                ) : <span className="text-[10px] text-gray-400">-</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {paginationBar}
                    </div>
                )}
            </div>
        );
    };

export default FrenchTaxPanel;

// ─── Income Tax Content ─────────────────────────────────────────────────────

const IncomeTaxContent: React.FC<{
    incomeReport: FrenchIncomeTaxReport | null;
    selectedYear: number | null;
    baseCurrency: string;
}> = ({ incomeReport, selectedYear, baseCurrency }) => {
    if (!incomeReport) return null;

    const summaries = selectedYear
        ? incomeReport.annual_summaries.filter(s => s.fiscal_year === selectedYear)
        : incomeReport.annual_summaries;
    const entries = selectedYear
        ? incomeReport.entries.filter(e => e.fiscal_year === selectedYear)
        : incomeReport.entries;

    return (
        <div>
            {/* Annual summary */}
            {summaries.length > 0 && (
                <div className="mb-4">
                    <div className="mb-2 text-xs font-bold text-teal-700">
                        Annual Summary — Form 2042
                    </div>
                    <div className="overflow-x-auto">
                        <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid #d5dce6' }}>
                                    <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 600 }}>Year</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Gross (2DC)</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>WHT Credit</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Net Taxable</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>PFU Tax</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Events</th>
                                </tr>
                            </thead>
                            <tbody>
                                {summaries.map(s => (
                                    <tr key={s.id} style={{ borderBottom: '1px solid #eef1f5' }}>
                                        <td style={{ padding: '4px 6px', fontWeight: 600 }}>{s.fiscal_year}</td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                                            {formatCurrency(s.total_gross_income, baseCurrency)}
                                        </td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right', color: '#d97706' }}>
                                            -{formatCurrency(s.total_withholding_credits, baseCurrency)}
                                        </td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                                            {formatCurrency(s.net_taxable, baseCurrency)}
                                        </td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 600, color: '#0d9488' }}>
                                            {formatCurrency(s.tax_total, baseCurrency)}
                                        </td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right' }}>{s.event_count}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Line item entries */}
            {entries.length > 0 && (
                <div>
                    <div className="mb-2 text-xs font-bold text-teal-700">
                        Income Events ({entries.length})
                    </div>
                    <div className="overflow-x-auto">
                        <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid #d5dce6' }}>
                                    <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 600 }}>Asset</th>
                                    <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 600 }}>Type</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Gross</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>WHT Credit</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Net Taxable</th>
                                    <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>PFU Tax</th>
                                </tr>
                            </thead>
                            <tbody>
                                {entries.map(e => (
                                    <tr key={e.id} style={{ borderBottom: '1px solid #eef1f5' }}>
                                        <td style={{ padding: '4px 6px', fontWeight: 600 }}>{e.asset_symbol}</td>
                                        <td style={{ padding: '4px 6px' }}>
                                            <Badge colorScheme="green">{e.income_type}</Badge>
                                        </td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                                            {formatCurrency(e.gross_income, baseCurrency)}
                                        </td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right', color: '#d97706' }}>
                                            {e.withholding_tax_credit > 0 ? `-${formatCurrency(e.withholding_tax_credit, baseCurrency)}` : '-'}
                                        </td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                                            {formatCurrency(e.net_taxable, baseCurrency)}
                                        </td>
                                        <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 600, color: '#0d9488' }}>
                                            {formatCurrency(e.tax_amount, baseCurrency)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {summaries.length === 0 && entries.length === 0 && (
                <div className="py-4 text-center text-xs text-gray-400">
                    No income tax entries for this period
                </div>
            )}
        </div>
    );
};
