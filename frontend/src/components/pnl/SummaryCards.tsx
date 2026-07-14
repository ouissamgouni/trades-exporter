/**
 * P&L Status Cards
 *
 * Three full-size cards displayed in a horizontal row:
 * 1. RefreshPricesCard — shows fresh / stale / error counts + refresh button
 * 2. WarningsCard — warning count + type breakdown badges
 * 3. BalanceHealthCard — mismatch count + tolerance slider + issue tooltip
 *
 * Also re-exports SummaryBar for the detail view.
 */

import React from 'react';
import { Badge, Button } from '../ui/primitives';
import { FiAlertTriangle, FiActivity, FiRefreshCw } from 'react-icons/fi';
import { Tooltip } from '../ui/tooltip';
import { PnLSummary, UnmappedLiveAsset } from './types';

export interface BalanceHealthIssue {
    symbol: string;
    delta: number;
    pct: number;
}

export interface BalanceHealthData {
    mismatchCount: number;
    totalCompared: number;
    issues: BalanceHealthIssue[];
    assetsFetched?: number;
    assetsTotal?: number;
    failedAssets?: string[];
    uncoveredAssets?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// RefreshPricesCard
// ═══════════════════════════════════════════════════════════════════

interface RefreshPricesCardProps {
    onRefreshPrices?: () => void;
    isRefreshingPrices?: boolean;
    priceSuccessCount?: number;
    priceStaleCount?: number;
    priceErrorCount?: number;
    onPriceBadgeClick?: () => void;
    refreshDisabled?: boolean;
    /** Number of assets not tracked in P&L (no cost lots — consistent with PriceStatusList) */
    naCount?: number;
    /** Number of P&L assets whose price fetch hasn't completed yet */
    pendingCount?: number;
    /** Total number of P&L assets (with cost lots) */
    pnlAssetCount?: number;
}

export const RefreshPricesCard: React.FC<RefreshPricesCardProps> = ({
    onRefreshPrices,
    isRefreshingPrices,
    priceSuccessCount = 0,
    priceStaleCount = 0,
    priceErrorCount = 0,
    onPriceBadgeClick,
    refreshDisabled,
    naCount = 0,
    pendingCount = 0,
    pnlAssetCount,
}) => {
    const priceableCount = priceSuccessCount + priceStaleCount + priceErrorCount;
    const highErrorRate = priceableCount > 0 && priceErrorCount / priceableCount > 0.2;

    return (
        <div className="flex h-full items-center overflow-hidden rounded-lg border border-gray-200 bg-white px-2.5 py-1">
            <div className="flex flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
                <FiRefreshCw size={12} color="#3182ce" style={{ flexShrink: 0 }} />
                <span className="whitespace-nowrap text-[10px] font-semibold text-gray-700">Prices</span>
                {pnlAssetCount != null && (
                    <span className="whitespace-nowrap text-[10px] text-gray-400">{pnlAssetCount}a</span>
                )}
                {priceSuccessCount > 0 && (
                    <Badge colorScheme="green" className="cursor-pointer" onClick={onPriceBadgeClick}>✅{priceSuccessCount}</Badge>
                )}
                {priceStaleCount > 0 && (
                    <Badge colorScheme="orange" className="cursor-pointer" onClick={onPriceBadgeClick}>⏳{priceStaleCount}</Badge>
                )}
                {priceErrorCount > 0 && (
                    <Badge colorScheme="red" className="cursor-pointer" onClick={onPriceBadgeClick}>⚠️{priceErrorCount}</Badge>
                )}
                {priceSuccessCount === 0 && priceStaleCount === 0 && priceErrorCount === 0 && (
                    <span className="text-[10px] text-gray-400">—</span>
                )}
                {naCount > 0 && (
                    <Tooltip content="Only assets with cost lots need live pricing">
                        <Badge colorScheme="gray">{naCount} N/A</Badge>
                    </Tooltip>
                )}
                {pendingCount > 0 && (
                    <Badge colorScheme="gray" className="cursor-pointer" onClick={onPriceBadgeClick}>⏳{pendingCount}</Badge>
                )}
                {highErrorRate && (
                    <Badge colorScheme="orange">⚠️</Badge>
                )}
                <Button
                    onClick={onRefreshPrices}
                    loading={isRefreshingPrices}
                    colorScheme="blue"
                    variant="outline"
                    size="sm"
                    disabled={refreshDisabled}
                    title="Refresh all prices"
                    className="ml-auto h-6 w-6 shrink-0 px-0"
                >
                    <FiRefreshCw size={12} />
                </Button>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════
// WarningsCard
// ═══════════════════════════════════════════════════════════════════

interface WarningsCardProps {
    summary: PnLSummary;
    onWarningsClick?: () => void;
    warningTypeCounts?: Record<string, number>;
}

export const WarningsCard: React.FC<WarningsCardProps> = ({
    summary,
    onWarningsClick,
    warningTypeCounts,
}) => {
    const hasWarnings = summary.warning_count > 0;

    return (
        <Tooltip
            showArrow
            content={
                warningTypeCounts && Object.keys(warningTypeCounts).length > 0 ? (
                    <div className="p-1">
                        {Object.entries(warningTypeCounts)
                            .sort((a, b) => b[1] - a[1])
                            .map(([type, count]) => (
                                <div key={type} className="text-xs">{type.replace(/_/g, ' ')}: {count}</div>
                            ))}
                    </div>
                ) : hasWarnings ? `${summary.warning_count} warnings detected` : 'No warnings'
            }
        >
            <div
                className={`flex h-full items-center overflow-hidden rounded-lg border bg-white px-2.5 py-1 transition-all duration-150 ${hasWarnings && onWarningsClick ? 'cursor-pointer hover:border-orange-300 hover:shadow-sm' : 'cursor-default'} border-gray-200`}
                onClick={hasWarnings ? onWarningsClick : undefined}
            >
                <div className="flex flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
                    <FiAlertTriangle size={12} color={hasWarnings ? '#dd6b20' : '#38a169'} style={{ flexShrink: 0 }} />
                    <span className="whitespace-nowrap text-[10px] font-semibold text-gray-700">Warnings</span>
                    <Badge colorScheme={summary.error_count > 0 ? 'red' : hasWarnings ? 'orange' : 'green'}>
                        {hasWarnings ? summary.warning_count : '✓'}
                    </Badge>
                    {/* Inline type breakdown */}
                    {warningTypeCounts && Object.keys(warningTypeCounts).length > 0 && (
                        <>
                            {Object.entries(warningTypeCounts)
                                .sort((a, b) => b[1] - a[1])
                                .slice(0, 3)
                                .map(([type, count]) => (
                                    <Badge key={type} colorScheme="orange">
                                        {type.replace(/_/g, ' ').substring(0, 12)}:{count}
                                    </Badge>
                                ))}
                            {Object.keys(warningTypeCounts).length > 3 && (
                                <Badge colorScheme="gray">
                                    +{Object.keys(warningTypeCounts).length - 3}
                                </Badge>
                            )}
                        </>
                    )}
                    {!hasWarnings && !warningTypeCounts && (
                        <span className="text-[10px] text-green-600">✓ ok</span>
                    )}
                </div>
            </div>
        </Tooltip>
    );
};

// ═══════════════════════════════════════════════════════════════════
// BalanceHealthCard
// ═══════════════════════════════════════════════════════════════════

interface BalanceHealthCardProps {
    balanceHealth?: BalanceHealthData;
    onBalanceHealthClick?: () => void;
    deltaThreshold?: number;
    onDeltaThresholdChange?: (value: number) => void;
    unmappedLiveAssets?: UnmappedLiveAsset[];
}

export const BalanceHealthCard: React.FC<BalanceHealthCardProps> = ({
    balanceHealth,
    onBalanceHealthClick,
    deltaThreshold = 5,
    onDeltaThresholdChange,
    unmappedLiveAssets = [],
}) => {
    if (!balanceHealth) return null;

    const hasMismatches = balanceHealth.mismatchCount > 0;
    const hasFailed = (balanceHealth.failedAssets?.length ?? 0) > 0;
    const covered = balanceHealth.assetsFetched ?? balanceHealth.totalCompared;
    const total = balanceHealth.assetsTotal ?? 0;
    const uncovered = balanceHealth.uncoveredAssets ?? [];

    return (
        <div
            className={`flex h-full items-center overflow-hidden rounded-lg border bg-white px-2.5 py-1 transition-all duration-150 ${hasFailed ? 'border-red-200' : 'border-gray-200'} ${onBalanceHealthClick ? 'cursor-pointer hover:border-orange-300 hover:shadow-sm' : 'cursor-default'}`}
            onClick={onBalanceHealthClick}
        >
            <div className="flex flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
                <FiActivity size={12} color={hasFailed ? '#e53e3e' : hasMismatches ? '#dd6b20' : '#38a169'} style={{ flexShrink: 0 }} />
                <span className="whitespace-nowrap text-[10px] font-semibold text-gray-700">Balance</span>
                <Badge colorScheme={hasMismatches ? 'orange' : 'green'}>
                    {covered}/{total}
                </Badge>
                {hasMismatches && (
                    <Badge colorScheme="orange">{balanceHealth.mismatchCount}Δ</Badge>
                )}
                {hasFailed && (
                    <Badge colorScheme="red">⚠{balanceHealth.failedAssets!.length}</Badge>
                )}
                {!hasMismatches && !hasFailed && (
                    <Badge colorScheme="green">✓</Badge>
                )}
                {unmappedLiveAssets.length > 0 && (
                    <Badge colorScheme="purple">📦{unmappedLiveAssets.length}</Badge>
                )}
                {/* Inline tolerance slider */}
                <div className="ml-auto flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <span className="whitespace-nowrap text-[10px] text-gray-400">{deltaThreshold}%</span>
                    <input
                        type="range"
                        min={0}
                        max={50}
                        step={1}
                        value={deltaThreshold}
                        onChange={(e) => onDeltaThresholdChange?.(Number(e.target.value))}
                        className="h-1 w-[50px] accent-blue-500"
                    />
                </div>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════
// Legacy exports (kept for compatibility)
// ═══════════════════════════════════════════════════════════════════

/** @deprecated Use RefreshPricesCard + WarningsCard + BalanceHealthCard instead */
export const CompactStatusBar: React.FC<any> = () => null;

interface SummaryCardsProps {
    summary: PnLSummary;
    baseCurrency: string;
    onFeesClick?: () => void;
    onWarningsClick?: () => void;
    balanceHealth?: BalanceHealthData;
    onBalanceHealthClick?: () => void;
    deltaThreshold?: number;
    onDeltaThresholdChange?: (value: number) => void;
    warningTypeCounts?: Record<string, number>;
}

/** @deprecated Replaced by individual card exports */
export const SummaryCards: React.FC<SummaryCardsProps> = () => null;

/**
 * Compact summary bar for when detail view is active
 */
const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
};

export const SummaryBar: React.FC<{
    summary: PnLSummary;
    baseCurrency: string;
}> = ({ summary, baseCurrency }) => {
    const realizedColor = summary.total_realized_pnl >= 0 ? 'text-green-600' : 'text-red-600';

    return (
        <div className="mb-4 flex flex-wrap items-center gap-6 rounded-md bg-gray-50 px-4 py-2">
            <div>
                <div className="text-xs text-gray-500">Portfolio</div>
                <div className="text-sm font-bold">
                    {formatCurrency(summary.total_portfolio_value, baseCurrency)}
                </div>
            </div>
            <div>
                <div className="text-xs text-gray-500">Unrealized</div>
                <div className={`text-sm font-bold ${summary.total_unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(summary.total_unrealized_pnl, baseCurrency)}
                </div>
            </div>
            <div>
                <div className="text-xs text-gray-500">Realized</div>
                <div className={`text-sm font-bold ${realizedColor}`}>
                    {formatCurrency(summary.total_realized_pnl, baseCurrency)}
                </div>
                {summary.taxable_realized_pnl !== 0 && (
                    <div className="text-[10px] text-gray-500">
                        Taxable: {formatCurrency(summary.taxable_realized_pnl, baseCurrency)}
                    </div>
                )}
            </div>
            <div>
                <div className="text-xs text-gray-500">Fees</div>
                <div className="text-sm font-bold">
                    {formatCurrency(summary.total_fees, baseCurrency)}
                </div>
            </div>
            {summary.warning_count > 0 && (
                <Badge colorScheme="orange">
                    <FiAlertTriangle style={{ marginRight: 4 }} />
                    {summary.warning_count} warnings
                </Badge>
            )}
        </div>
    );
};

export default SummaryCards;
