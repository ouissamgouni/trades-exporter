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
import {
    Badge,
    Box,
    Button,
    Flex,
    Heading,
    SimpleGrid,
    Spinner,
    Table,
    Text,
} from '@chakra-ui/react';
import { FiDownload, FiChevronsLeft, FiChevronLeft, FiChevronRight, FiChevronsRight } from 'react-icons/fi';
import { LuRefreshCw, LuCircleAlert, LuCircleCheck, LuFilter, LuChevronDown, LuRotateCcw } from 'react-icons/lu';
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
    <Text
        fontWeight="semibold"
        color={value >= 0 ? 'green.600' : 'red.600'}
        fontSize="xs"
    >
        {value >= 0 ? '+' : ''}{formatCurrency(value, currency)}
    </Text>
);

type TaxCategory = 'crypto' | 'securities';

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
        ])
            .then(([crypto, securities]) => {
                setCryptoReport(crypto);
                setSecuritiesReport(securities);
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
            <Flex justify="center" align="center" py={8} gap={3}>
                <Spinner size="sm" />
                <Text color="gray.500" fontSize="sm">Checking tax status…</Text>
            </Flex>
        );
    }

    // No tax results yet
    if (!hasTaxResults && !isLoading) {
        return (
            <Box py={8} textAlign="center">
                <Text color="gray.500" fontSize="sm" mb={3}>
                    French tax has not been computed for this version yet.
                </Text>
                <Button
                    size="sm"
                    colorPalette="blue"
                    onClick={handleComputeTax}
                    loading={isComputing}
                >
                    Compute French Tax
                </Button>
                {error && (
                    <Text color="red.500" fontSize="sm" mt={2}>{error}</Text>
                )}
            </Box>
        );
    }

    if (isLoading) {
        return (
            <Flex justify="center" align="center" py={12} gap={3}>
                <Spinner size="md" />
                <Text color="gray.500" fontSize="sm">Loading tax data…</Text>
            </Flex>
        );
    }

    if (error) {
        return (
            <Box py={8} textAlign="center">
                <Text color="red.500" fontSize="sm">Failed to load tax data: {error}</Text>
            </Box>
        );
    }

    const hasCrypto = cryptoReport && (cryptoReport.annual_summaries?.length > 0 || cryptoReport.entries?.length > 0);
    const hasSecurities = securitiesReport && (securitiesReport.annual_summaries?.length > 0 || securitiesReport.entries?.length > 0);

    if (!hasCrypto && !hasSecurities) {
        return (
            <Box py={8} textAlign="center">
                <Text color="gray.400" fontSize="sm" mb={3}>No taxable disposals found for this version.</Text>
                <Button size="xs" variant="ghost" onClick={handleComputeTax} loading={isComputing}>
                    Recompute
                </Button>
            </Box>
        );
    }

    return (
        <TaxContent
            cryptoReport={cryptoReport}
            securitiesReport={securitiesReport}
            hasCrypto={!!hasCrypto}
            hasSecurities={!!hasSecurities}
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
    hasCrypto: boolean;
    hasSecurities: boolean;
    baseCurrency: string;
    versionId: number;
    onRecompute: () => void;
    onRefreshTaxData: (silent?: boolean) => void;
    isComputing: boolean;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
    onAssetClick?: (assetId: number) => void;
}> = ({
    cryptoReport, securitiesReport, hasCrypto, hasSecurities,
    baseCurrency, versionId, onRecompute, onRefreshTaxData, isComputing,
    onTransactionClick, onUnitClick, onAssetClick,
}) => {
        const [activeCategory, setActiveCategory] = useState<TaxCategory>(hasCrypto ? 'crypto' : 'securities');
        const [selectedYear, setSelectedYear] = useState<number | null>(null);

        const activeReport = activeCategory === 'crypto' ? cryptoReport : securitiesReport;
        const summaries = activeReport?.annual_summaries ?? [];
        const exportPath = activeCategory === 'crypto' ? 'fr-crypto-tax' : 'fr-securities-tax';
        const exportLabel = activeCategory === 'crypto' ? 'Cerfa 2086' : 'Form 2074';

        // Auto-select most recent year when switching category or on mount
        const summariesKey = summaries.map(s => s.fiscal_year).sort().join(',');
        useEffect(() => {
            if (summaries.length > 0) {
                const years = summaries.map(s => s.fiscal_year);
                setSelectedYear(Math.max(...years));
            } else {
                setSelectedYear(null);
            }
        }, [activeCategory, summariesKey]);

        // Handler for when an override changes in any DisposalTable
        const handleOverrideChange = useCallback(() => {
            // Recompute tax (picks up new override values) then refresh reports silently
            fetch(`${API_URL}/pnl/versions/${versionId}/compute-tax`, { method: 'POST' })
                .then(() => onRefreshTaxData(true))
                .catch(() => { });
        }, [versionId, onRefreshTaxData]);

        // Compute totals per category for cards
        const cryptoTotals = useMemo(() => computeCardTotals(cryptoReport), [cryptoReport]);
        const securitiesTotals = useMemo(() => computeCardTotals(securitiesReport), [securitiesReport]);

        const handleExport = () => {
            const yearParam = selectedYear ? `?fiscal_year=${selectedYear}` : '';
            window.open(`${API_URL}/pnl/versions/${versionId}/${exportPath}/export${yearParam}`, '_blank');
        };

        return (
            <Box>
                {/* Recompute row */}
                <Flex justify="flex-end" mb={3} px={1}>
                    <Button
                        size="xs"
                        variant="ghost"
                        onClick={onRecompute}
                        loading={isComputing}
                        colorPalette="gray"
                    >
                        <LuRefreshCw size={12} />
                        <Text ml={1}>Recompute</Text>
                    </Button>
                </Flex>

                {/* Global total summary */}
                <Box
                    p={3}
                    mb={3}
                    bg="gray.50"
                    border="1px solid"
                    borderColor="gray.200"
                    borderRadius="md"
                >
                    <Flex justify="space-between" align="center">
                        <Text fontWeight="700" fontSize="sm" color="gray.700">Tax Total</Text>
                        <Text fontWeight="bold" fontSize="lg" color={(cryptoTotals.totalTax + securitiesTotals.totalTax) > 0 ? 'red.600' : 'gray.500'}>
                            {formatCurrency(cryptoTotals.totalTax + securitiesTotals.totalTax, baseCurrency)}
                        </Text>
                    </Flex>
                    <Flex gap={6} mt={1}>
                        <Box>
                            <Text fontSize="2xs" color="gray.400">Total Disposals</Text>
                            <Text fontWeight="600" fontSize="sm">{cryptoTotals.taxableDisposals + securitiesTotals.taxableDisposals}</Text>
                        </Box>
                        <Box>
                            <Text fontSize="2xs" color="gray.400">Gains</Text>
                            <Text fontWeight="600" fontSize="sm" color="green.600">
                                +{formatCurrency(cryptoTotals.totalGains + securitiesTotals.totalGains, baseCurrency)}
                            </Text>
                        </Box>
                        <Box>
                            <Text fontSize="2xs" color="gray.400">Losses</Text>
                            <Text fontWeight="600" fontSize="sm" color="red.600">
                                {(cryptoTotals.totalLosses + securitiesTotals.totalLosses) > 0
                                    ? `-${formatCurrency(cryptoTotals.totalLosses + securitiesTotals.totalLosses, baseCurrency)}`
                                    : formatCurrency(0, baseCurrency)}
                            </Text>
                        </Box>
                    </Flex>
                </Box>

                {/* Tab-style category cards + content */}
                {(() => {
                    const palette = activeCategory === 'crypto' ? 'blue' : 'purple';
                    const contentBg = activeCategory === 'crypto' ? 'blue.50/40' : 'purple.50/40';
                    return (
                        <Box>
                            {/* Tab headers */}
                            <Flex gap={0} mb={0}>
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
                            </Flex>

                            {/* Content area — border merges with active tab */}
                            <Box
                                bg={contentBg}
                                border="1px solid"
                                borderColor={`${palette}.200`}
                                borderTop="none"
                                borderRadius="0 0 lg lg"
                                p={4}
                                transition="all 0.15s"
                            >

                                {/* Year selector + export */}
                                {summaries.length > 0 && (
                                    <Flex justify="space-between" align="center" mb={3}>
                                        <Flex gap={2} align="center" wrap="wrap">
                                            <Text fontSize="xs" color="gray.500" mr={1}>Fiscal Year:</Text>
                                            <Button
                                                size="xs"
                                                variant={selectedYear === null ? 'solid' : 'outline'}
                                                colorPalette="gray"
                                                onClick={() => setSelectedYear(null)}
                                            >
                                                All Years
                                            </Button>
                                            {[...summaries].sort((a, b) => b.fiscal_year - a.fiscal_year).map(s => {
                                                const isSelected = selectedYear === s.fiscal_year;
                                                const palette = s.tax_total > 0 ? 'red' : 'green';
                                                return (
                                                    <Button
                                                        key={s.fiscal_year}
                                                        size="xs"
                                                        variant={isSelected ? 'subtle' : 'outline'}
                                                        colorPalette={isSelected ? palette : 'gray'}
                                                        onClick={() => setSelectedYear(s.fiscal_year)}
                                                    >
                                                        {s.fiscal_year}
                                                        <Badge ml={1} size="xs" variant="plain"
                                                            color={isSelected ? `${palette}.700` : undefined}
                                                        >{formatCurrency(s.tax_total, baseCurrency)}</Badge>
                                                    </Button>
                                                );
                                            })}
                                        </Flex>
                                        <Button size="sm" variant="outline" colorPalette={activeCategory === 'crypto' ? 'blue' : 'purple'} onClick={handleExport}>
                                            <FiDownload />
                                            <Text ml={1}>Export {exportLabel}</Text>
                                        </Button>
                                    </Flex>
                                )}

                                {/* Annual summary table */}
                                {summaries.length > 0 && (
                                    <AnnualSummaryTable
                                        summaries={summaries}
                                        selectedYear={selectedYear}
                                        onSelectYear={setSelectedYear}
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
                            </Box>
                        </Box>
                    );
                })()}
            </Box>
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

const SummaryCard: React.FC<{
    label: string;
    subtitle: string;
    palette: string;
    totals: CardTotals;
    baseCurrency: string;
    active: boolean;
    onClick: () => void;
}> = ({ label, subtitle, palette, totals, baseCurrency, active, onClick }) => (
    <Box
        flex={1}
        p={4}
        bg={active ? `${palette}.50/40` : 'white'}
        border="1px solid"
        borderColor={active ? `${palette}.200` : 'gray.200'}
        borderBottom={active ? 'none' : '1px solid'}
        borderBottomColor={active ? 'transparent' : 'gray.200'}
        borderRadius={active ? 'lg lg 0 0' : 'lg'}
        cursor="pointer"
        onClick={onClick}
        transition="all 0.15s"
        position="relative"
        zIndex={active ? 1 : 0}
        mb={active ? '-1px' : '0'}
        _hover={{ borderColor: `${palette}.300`, bg: active ? `${palette}.50/40` : 'gray.50' }}
    >
        <Flex justify="space-between" align="start" mb={2}>
            <Box>
                <Text fontWeight="700" fontSize="sm" color={active ? `${palette}.700` : 'gray.700'}>
                    {label}
                </Text>
                <Text fontSize="2xs" color="gray.400">{subtitle}</Text>
            </Box>
            <Text fontWeight="bold" fontSize="lg" color={totals.totalTax > 0 ? 'red.600' : 'gray.500'}>
                {formatCurrency(totals.totalTax, baseCurrency)}
            </Text>
        </Flex>
        <Flex gap={4}>
            <Box>
                <Text fontSize="2xs" color="gray.400">Taxable Disposals</Text>
                <Text fontWeight="600" fontSize="sm">{totals.taxableDisposals}</Text>
            </Box>
            <Box>
                <Text fontSize="2xs" color="gray.400">Gains</Text>
                <Text fontWeight="600" fontSize="sm" color="green.600">
                    +{formatCurrency(totals.totalGains, baseCurrency)}
                </Text>
            </Box>
            <Box>
                <Text fontSize="2xs" color="gray.400">Losses</Text>
                <Text fontWeight="600" fontSize="sm" color="red.600">
                    {totals.totalLosses > 0 ? `-${formatCurrency(totals.totalLosses, baseCurrency)}` : formatCurrency(0, baseCurrency)}
                </Text>
            </Box>
        </Flex>
    </Box>
);

// ─── Annual Summary Table ───────────────────────────────────────────────────

const AnnualSummaryTable: React.FC<{
    summaries: FrenchTaxAnnualSummary[];
    selectedYear: number | null;
    onSelectYear: (y: number | null) => void;
    baseCurrency: string;
}> = ({ summaries, selectedYear, onSelectYear, baseCurrency }) => (
    <Box mb={5}>
        <Heading size="xs" mb={2} color="gray.600">Annual Summary</Heading>
        <Box overflowX="auto">
            <Table.Root size="sm" variant="outline" striped>
                <Table.Header>
                    <Table.Row>
                        <Table.ColumnHeader fontSize="xs">Year</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right" fontSize="xs">Gains</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right" fontSize="xs">Losses</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right" fontSize="xs">Net Taxable</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right" fontSize="xs">Tax</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right" fontSize="xs">Carryforward</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right" fontSize="xs">Taxable Disposals</Table.ColumnHeader>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {[...summaries].sort((a, b) => b.fiscal_year - a.fiscal_year).map(s => (
                        <Table.Row
                            key={s.fiscal_year}
                            bg={selectedYear === s.fiscal_year ? 'blue.50' : undefined}
                            cursor="pointer"
                            onClick={() => onSelectYear(s.fiscal_year === selectedYear ? null : s.fiscal_year)}
                        >
                            <Table.Cell fontWeight="semibold" fontSize="xs">{s.fiscal_year}</Table.Cell>
                            <Table.Cell textAlign="right" color="green.600" fontSize="xs">{formatCurrency(s.total_gains, baseCurrency)}</Table.Cell>
                            <Table.Cell textAlign="right" color="red.600" fontSize="xs">
                                {s.total_losses > 0 ? `-${formatCurrency(s.total_losses, baseCurrency)}` : '—'}
                            </Table.Cell>
                            <Table.Cell textAlign="right" fontSize="xs"><GainBadge value={s.net_taxable} currency={baseCurrency} /></Table.Cell>
                            <Table.Cell textAlign="right" fontWeight="semibold" color={s.tax_total > 0 ? 'red.600' : 'gray.500'} fontSize="xs">
                                {formatCurrency(s.tax_total, baseCurrency)}
                            </Table.Cell>
                            <Table.Cell textAlign="right" color="orange.600" fontSize="xs">
                                {s.loss_carried_forward < 0 ? formatCurrency(s.loss_carried_forward, baseCurrency) : '—'}
                            </Table.Cell>
                            <Table.Cell textAlign="right" fontSize="xs">{s.transaction_count}</Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table.Root>
        </Box>
    </Box>
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
            <Flex justify="space-between" align="center" width="100%" py={2} px={3}>
                <Flex align="center" gap={2}>
                    <Text fontSize="2xs" color="gray.500">Rows:</Text>
                    <Flex borderRadius="md" border="1px solid" borderColor="gray.200" overflow="hidden" display="inline-flex">
                        {DISPOSAL_PAGE_SIZES.map(size => (
                            <Button key={size} size="2xs"
                                variant={pageSize === size ? 'subtle' : 'ghost'}
                                colorPalette={pageSize === size ? 'blue' : 'gray'}
                                borderRadius="0"
                                onClick={() => { setPageSize(size); setPage(1); }}
                                px={2} fontSize="xs">
                                {size}
                            </Button>
                        ))}
                    </Flex>
                </Flex>
                <Text fontSize="2xs" color="gray.500">
                    {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
                </Text>
                <Flex align="center" gap={1}>
                    <Button size="2xs" variant="ghost" onClick={() => setPage(1)} disabled={page <= 1} px={1}>
                        <FiChevronsLeft size={12} />
                    </Button>
                    <Button size="2xs" variant="ghost" onClick={() => setPage(page - 1)} disabled={page <= 1} px={1}>
                        <FiChevronLeft size={14} />
                    </Button>
                    <Text fontSize="xs" color="gray.600" mx={1}>{page} / {pageCount}</Text>
                    <Button size="2xs" variant="ghost" onClick={() => setPage(page + 1)} disabled={page >= pageCount} px={1}>
                        <FiChevronRight size={14} />
                    </Button>
                    <Button size="2xs" variant="ghost" onClick={() => setPage(pageCount)} disabled={page >= pageCount} px={1}>
                        <FiChevronsRight size={12} />
                    </Button>
                </Flex>
            </Flex>
        ) : null;

        return (
            <Box>
                <Flex justify="space-between" align="center" mb={2}>
                    <Flex align="center" gap={2}>
                        <Heading size="xs" color="gray.600">
                            {headingText}
                        </Heading>
                        <Flex gap={1.5}>
                            <Button
                                size="2xs"
                                variant={showTaxable ? 'subtle' : 'outline'}
                                colorPalette={showTaxable ? 'red' : 'gray'}
                                onClick={() => setShowTaxable(p => !p)}
                                borderRadius="full"
                                px={2.5}
                            >
                                Taxable ({taxableCount})
                            </Button>
                            <Button
                                size="2xs"
                                variant={showNonTaxable ? 'subtle' : 'outline'}
                                colorPalette={showNonTaxable ? 'green' : 'gray'}
                                onClick={() => setShowNonTaxable(p => !p)}
                                borderRadius="full"
                                px={2.5}
                            >
                                Non-Taxable ({nonTaxableCount})
                            </Button>
                        </Flex>
                    </Flex>
                    <Text fontSize="2xs" color="gray.400">
                        {isRefreshing ? 'Refreshing…' : `${total} / ${totalEntries} entries`}
                    </Text>
                </Flex>

                {/* ─── Collapsible Filter Section ─── */}
                <Box mb={3}>
                    <Box bg="gray.50" borderRadius="md" border="1px solid" borderColor={hasAnyFilter ? 'blue.300' : 'gray.200'} overflow="visible">
                        <Flex align="center" justify="space-between" p={2.5}
                            cursor="pointer" transition="background 0.15s" _hover={{ bg: 'gray.100' }}
                            onClick={() => setFiltersExpanded(p => !p)} borderRadius="md">
                            <Flex align="center" gap={1.5} flexWrap="wrap">
                                <Box transition="transform 0.2s" transform={filtersExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'}>
                                    <LuChevronDown size={14} />
                                </Box>
                                <LuFilter size={12} />
                                <Text fontWeight="semibold" fontSize="xs">Filters</Text>
                                {activeChips.length > 0 && (
                                    <Badge size="xs" colorPalette="blue">{activeChips.length} active</Badge>
                                )}
                                {activeChips.map(chip => <FilterChip key={chip.id} chip={chip} />)}
                            </Flex>
                            <Flex gap={1.5} onClick={e => e.stopPropagation()}>
                                {hasAnyFilter && (
                                    <Button size="xs" variant="ghost" onClick={clearFilters} color="gray.500" _hover={{ color: 'gray.700' }}>
                                        <LuRotateCcw size={10} />
                                        <Text ml={0.5} fontSize="2xs">Clear All</Text>
                                    </Button>
                                )}
                            </Flex>
                        </Flex>

                        {filtersExpanded && (
                            <Box p={3} pt={1} overflow="visible">
                                <SimpleGrid columns={{ base: 2, md: 3, lg: 5 }} gap={2}>
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
                                </SimpleGrid>
                            </Box>
                        )}
                    </Box>
                </Box>

                {isLoading ? (
                    <Flex justify="center" py={8}>
                        <Spinner size="sm" />
                        <Text ml={2} fontSize="xs" color="gray.500">Loading disposals…</Text>
                    </Flex>
                ) : entries.length === 0 ? (
                    <Box py={6} textAlign="center">
                        <Text color="gray.400" fontSize="xs">
                            {hasAnyFilter ? 'No entries match filters.' : 'No disposals found.'}
                        </Text>
                    </Box>
                ) : (
                    <Box>
                        {paginationBar}
                        <Box overflowX="auto">
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
                                                <Text fontSize="3xs" color="gray.400" fontFamily="mono">#{e.pnl_id}</Text>
                                            </td>
                                            <td style={{ ...TD }}>
                                                <Text fontSize="2xs" color="gray.600" whiteSpace="nowrap">
                                                    {e.realized_at ? fmtDate(e.realized_at) : '-'}
                                                </Text>
                                            </td>
                                            <td style={{ ...TD }}>
                                                {onAssetClick ? (
                                                    <Text fontSize="2xs" fontWeight="medium" color="purple.600"
                                                        cursor="pointer"
                                                        _hover={{ textDecoration: 'underline' }}
                                                        onClick={() => e.asset.id && onAssetClick(e.asset.id)}
                                                        maxW="80px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                                        {e.asset.label || e.asset.symbol}
                                                    </Text>
                                                ) : (
                                                    <Text fontSize="2xs" fontWeight="medium">{e.asset.label || e.asset.symbol}</Text>
                                                )}
                                            </td>
                                            <td style={{ ...TD }}>
                                                <Flex align="center" gap={1}>
                                                    <Text fontSize="2xs" color="gray.500" maxW="80px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                                        {e.account_name || '-'}
                                                    </Text>
                                                </Flex>
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
                                                <Text color={e.pnl_in_base >= 0 ? 'green.600' : 'red.600'} fontWeight="medium" fontSize="2xs">
                                                    <ValueDisplay value={e.pnl_in_base} currency={baseCurrency} />
                                                </Text>
                                            </td>
                                            <td style={{ ...TD, textAlign: 'center' }}>
                                                <Tooltip content={e.taxable ? 'Taxable (computed)' : 'Non-Taxable (computed)'}>
                                                    <Flex align="center" justify="center">
                                                        <Box display="inline-flex" alignItems="center" justifyContent="center"
                                                            w="18px" h="18px" borderRadius="full"
                                                            bg={e.taxable ? 'red.100' : 'green.100'}
                                                            color={e.taxable ? 'red.600' : 'green.600'}>
                                                            {e.taxable ? <LuCircleAlert size={11} /> : <LuCircleCheck size={11} />}
                                                        </Box>
                                                    </Flex>
                                                </Tooltip>
                                            </td>
                                            <td style={{ ...TD, textAlign: 'center' }}>
                                                <Tooltip content={
                                                    (e.fr_tax_effective ?? e.taxable) !== e.taxable
                                                        ? `Override: ${(e.fr_tax_effective ?? e.taxable) ? 'Taxable' : 'Non-Taxable'} (click to reset)`
                                                        : `${(e.fr_tax_effective ?? e.taxable) ? 'Taxable' : 'Non-Taxable'} for FR tax (click to override)`
                                                }>
                                                    <Flex align="center" justify="center"
                                                        cursor="pointer"
                                                        onClick={() => handleTaxOverrideToggle(e)}
                                                    >
                                                        <Box display="inline-flex" alignItems="center" justifyContent="center"
                                                            w="18px" h="18px" borderRadius="full"
                                                            bg={(e.fr_tax_effective ?? e.taxable) ? 'red.100' : 'green.100'}
                                                            color={(e.fr_tax_effective ?? e.taxable) ? 'red.600' : 'green.600'}
                                                            outline={(e.fr_tax_effective ?? e.taxable) !== e.taxable ? '2px dashed' : 'none'}
                                                            outlineColor={(e.fr_tax_effective ?? e.taxable) !== e.taxable ? ((e.fr_tax_effective ?? e.taxable) ? 'red.400' : 'green.400') : undefined}
                                                            outlineOffset="2px">
                                                            {(e.fr_tax_effective ?? e.taxable) ? <LuCircleAlert size={11} /> : <LuCircleCheck size={11} />}
                                                        </Box>
                                                    </Flex>
                                                </Tooltip>
                                            </td>
                                            <td style={{ ...TD, textAlign: 'center' }}>
                                                <Badge size="xs" colorPalette={e.is_fee ? 'orange' : 'blue'} variant="subtle">
                                                    {e.is_fee ? 'Fee' : 'Disposal'}
                                                </Badge>
                                            </td>
                                            <td style={{ ...TD, textAlign: 'right' }}>
                                                <Text fontSize="2xs" color="gray.500">{e.holding_period_days ?? '-'}</Text>
                                            </td>
                                            <td style={{ ...TD }}>
                                                {e.transaction_id ? (
                                                    <Text fontSize="2xs" color="blue.500" fontFamily="mono"
                                                        cursor={onTransactionClick ? 'pointer' : undefined}
                                                        _hover={onTransactionClick ? { textDecoration: 'underline' } : undefined}
                                                        onClick={() => onTransactionClick?.(e.transaction_id!)}>
                                                        #{e.transaction_id}
                                                    </Text>
                                                ) : <Text fontSize="2xs" color="gray.400">-</Text>}
                                            </td>
                                            <td style={{ ...TD }}>
                                                {e.unit_id ? (
                                                    <Text fontSize="2xs" color="blue.500" fontFamily="mono"
                                                        cursor={onUnitClick ? 'pointer' : undefined}
                                                        _hover={onUnitClick ? { textDecoration: 'underline' } : undefined}
                                                        onClick={() => onUnitClick?.(e.unit_id!)}>
                                                        #{e.unit_id}
                                                    </Text>
                                                ) : <Text fontSize="2xs" color="gray.400">-</Text>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Box>
                        {paginationBar}
                    </Box>
                )}
            </Box>
        );
    };

export default FrenchTaxPanel;
