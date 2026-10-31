
import React, { useState, useMemo } from 'react';
import { Badge, Button, Input, Spinner } from '../ui/primitives';
import { FiCheckCircle, FiAlertCircle, FiAlertTriangle, FiSearch, FiDatabase, FiLoader, FiRefreshCw, FiChevronDown } from 'react-icons/fi';
import { AssetRef, PriceResponse } from '../../types';
import { formatRelativeTime } from '../../utils/dateUtils';
import { Tooltip } from '../ui/tooltip';
import { PriceSetterDialog } from './PriceSetterDialog';
import { GapFixPanel } from '../GapFixPanel';
import { PriceGapBulkFix } from '../PriceGapBulkFix';
import { usePriceGapsSummary } from '../../hooks/usePriceGaps';

interface PriceStatusListProps {
    prices: PriceResponse[];
    baseCurrency: string;
    quoteAssetId?: number;  // Base currency asset ID for manual price entry
    onPriceAdded?: (assetId: number) => void;  // Callback after manual price is saved
    onRetryFailed?: () => void;  // Callback to retry all failed price fetches
    onBulkGapFixComplete?: () => void | Promise<void>;  // Callback after global gap backfill completes
    loadingAssetIds?: Set<number>;  // Asset IDs currently being fetched
    assetNameMap?: Map<number, string>;  // id → display name for loading placeholders
    totalAssetCount?: number;  // Total assets in table (including non-PnL)
    naAssets?: Array<{ id: number; symbol: string }>;  // Assets with no lots / zero qty
}

type StatusFilter = 'all' | 'ok' | 'stale' | 'error' | 'na' | 'loading';

// Using formatTimeLocale from utils/dateUtils for time formatting

const formatCurrency = (value: number | null | undefined, currency: string): string => {
    if (value == null) return '—';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
    }).format(value);
};

export const PriceStatusList: React.FC<PriceStatusListProps> = ({
    prices,
    baseCurrency,
    quoteAssetId,
    onPriceAdded,
    onRetryFailed,
    onBulkGapFixComplete,
    loadingAssetIds,
    assetNameMap,
    totalAssetCount,
    naAssets,
}) => {
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [expandedAssetId, setExpandedAssetId] = useState<number | null>(null);

    // Fetch gap summary for all assets in the list
    const assetIds = useMemo(
        () => prices.map(p => p.asset.id).filter((id): id is number => id != null),
        [prices],
    );
    const { data: gapSummary } = usePriceGapsSummary(assetIds);
    const gapMap = useMemo(() => {
        const m = new Map<number, number>();
        if (gapSummary?.items) {
            for (const item of gapSummary.items) {
                if (item.total_missing_days > 0) m.set(item.asset_id, item.total_missing_days);
            }
        }
        return m;
    }, [gapSummary]);

    // State for manual price dialog (triggered from expanded GapFixPanel or direct CTA)
    const [dialogOpen, setDialogOpen] = useState(false);
    const [selectedAsset, setSelectedAsset] = useState<{ id: number; symbol: string } | null>(null);

    const handleOpenPriceSetter = (asset: AssetRef) => {
        if (asset.id == null || asset.symbol == null) return;
        setSelectedAsset({ id: asset.id, symbol: asset.symbol });
        setDialogOpen(true);
    };

    const handlePriceSaved = () => {
        if (selectedAsset && onPriceAdded) {
            onPriceAdded(selectedAsset.id);
        }
        setDialogOpen(false);
        setSelectedAsset(null);
    };

    // Merge loading-only assets (in loadingAssetIds but not yet in prices) as placeholder rows
    const allItems = useMemo(() => {
        const priceAssetIds = new Set(prices.map(p => p.asset.id).filter(Boolean));
        const placeholders: PriceResponse[] = [];
        if (loadingAssetIds) {
            for (const id of loadingAssetIds) {
                if (!priceAssetIds.has(id)) {
                    placeholders.push({
                        asset: { id, symbol: assetNameMap?.get(id) ?? `#${id}` },
                        price: null,
                        price_quote: baseCurrency,
                        fetched_at: undefined,
                    });
                }
            }
        }
        // Add N/A assets as placeholder rows
        const naPlaceholders: PriceResponse[] = [];
        if (naAssets) {
            for (const na of naAssets) {
                if (!priceAssetIds.has(na.id) && !(loadingAssetIds?.has(na.id))) {
                    naPlaceholders.push({
                        asset: { id: na.id, symbol: na.symbol },
                        price: null,
                        price_quote: baseCurrency,
                        fetched_at: undefined,
                        _isNa: true,
                    } as PriceResponse & { _isNa?: boolean });
                }
            }
        }
        return [...prices, ...placeholders, ...naPlaceholders];
    }, [prices, loadingAssetIds, baseCurrency, naAssets]);

    const filtered = allItems.filter(p =>
        (p.asset.symbol && p.asset.symbol.toLowerCase().includes(search.toLowerCase())) ||
        (p.source && p.source.toLowerCase().includes(search.toLowerCase()))
    );

    // Sort: Loading first (if panel is open during fetch), then errors, stale, then by name
    const sorted = [...filtered].sort((a, b) => {
        const aLoading = loadingAssetIds?.has(a.asset.id!) ?? false;
        const bLoading = loadingAssetIds?.has(b.asset.id!) ?? false;
        if (aLoading && !bLoading) return -1;
        if (!aLoading && bLoading) return 1;
        const aErr = !!a.error;
        const bErr = !!b.error;
        const aStale = !!a.is_stale;
        const bStale = !!b.is_stale;
        if (aErr && !bErr) return -1;
        if (!aErr && bErr) return 1;
        if (aStale && !bStale) return -1;
        if (!aStale && bStale) return 1;
        return (a.asset.symbol || '').localeCompare(b.asset.symbol || '');
    });

    // Apply status filter
    const displayed = statusFilter === 'all' ? sorted : sorted.filter(item => {
        const isLoading = loadingAssetIds?.has(item.asset.id!) ?? false;
        const isNa = (item as any)._isNa === true;
        const isError = !isLoading && !isNa && (!!item.error || item.price == null);
        const isStale = !isLoading && !isNa && !!item.is_stale;
        const isOk = !isLoading && !isNa && !isError && !isStale;
        switch (statusFilter) {
            case 'loading': return isLoading;
            case 'ok': return isOk;
            case 'stale': return isStale;
            case 'error': return isError;
            case 'na': return isNa;
            default: return true;
        }
    });

    // Count stats
    const loadingCount = loadingAssetIds?.size ?? 0;
    const okCount = allItems.filter(p => !p.error && p.price != null && !p.is_stale && !(loadingAssetIds?.has(p.asset.id!)) && !(p as any)._isNa).length;
    const staleCount = allItems.filter(p => p.is_stale && p.price != null).length;
    const failedCount = allItems.filter(p => (!!p.error || p.price == null) && !(loadingAssetIds?.has(p.asset.id!)) && !(p as any)._isNa).length;
    const naCount = naAssets?.length ?? 0;
    const pricedTotal = okCount + staleCount + failedCount + loadingCount;
    const skippedCount = totalAssetCount != null ? Math.max(totalAssetCount - pricedTotal - naCount, 0) : 0;

    const toggleFilter = (f: StatusFilter) => setStatusFilter(prev => prev === f ? 'all' : f);

    return (
        <div className="flex h-full flex-col">
            {/* Header / Stats */}
            <div className="border-b border-gray-100 bg-gray-50 p-4">
                <div className="mb-4 flex items-center justify-between">
                    <div>
                        <div className="text-lg font-bold">Price Status</div>
                        <div className="mt-1 flex gap-2">
                            {loadingCount > 0 && (
                                <Badge colorScheme="blue" className={`cursor-pointer ${statusFilter === 'loading' ? 'ring-2 ring-blue-400' : ''}`} onClick={() => toggleFilter('loading')}>
                                    {loadingCount} Loading
                                </Badge>
                            )}
                            <Badge colorScheme="green" className={`cursor-pointer ${statusFilter === 'ok' ? 'ring-2 ring-green-400' : ''}`} onClick={() => toggleFilter('ok')}>
                                {okCount} OK
                            </Badge>
                            {staleCount > 0 && (
                                <Badge colorScheme="orange" className={`cursor-pointer ${statusFilter === 'stale' ? 'ring-2 ring-orange-400' : ''}`} onClick={() => toggleFilter('stale')}>
                                    {staleCount} Stale
                                </Badge>
                            )}
                            <Badge colorScheme="red" className={`cursor-pointer ${statusFilter === 'error' ? 'ring-2 ring-red-400' : ''}`} onClick={() => toggleFilter('error')}>
                                {failedCount} Failed
                            </Badge>
                            {failedCount > 0 && onRetryFailed && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    colorScheme="gray"
                                    onClick={onRetryFailed}
                                    disabled={loadingCount > 0}
                                    className="h-6 px-2 text-xs"
                                >
                                    <FiRefreshCw size={12} />
                                    <span className="ml-1 text-xs">Retry Failed</span>
                                </Button>
                            )}
                            {naCount > 0 && (
                                <Badge colorScheme="gray" className={`cursor-pointer ${statusFilter === 'na' ? 'ring-2 ring-slate-400' : ''}`} onClick={() => toggleFilter('na')}>
                                    {naCount} N/A
                                </Badge>
                            )}
                        </div>
                    </div>
                    <PriceGapBulkFix
                        quoteAssetId={quoteAssetId ?? null}
                        onComplete={onBulkGapFixComplete}
                        compact
                    />
                </div>

                <div className="relative">
                    <Input
                        placeholder="Search assets..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="rounded-md bg-white pl-8"
                    />
                    <div className="absolute left-2.5 top-2.5 text-gray-400">
                        <FiSearch size={14} />
                    </div>
                </div>
            </div>

            {/* List Content */}
            <div className="flex-1 overflow-y-auto p-0">
                {displayed.length === 0 ? (
                    <div className="flex h-[200px] flex-col items-center justify-center text-gray-400">
                        <FiDatabase size={32} />
                        <div className="mt-2">{statusFilter !== 'all' ? `No ${statusFilter} assets` : 'No price data available'}</div>
                    </div>
                ) : (
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-white">
                            <tr>
                                <th className="w-[40px]"></th>
                                <th className="text-left">Asset</th>
                                <th className="text-left">Price</th>
                                <th className="text-left">Source</th>
                                <th className="w-[40px]"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {displayed.map((item) => {
                                const isLoading = loadingAssetIds?.has(item.asset.id!) ?? false;
                                const isNa = (item as any)._isNa === true;
                                const isError = !isLoading && !isNa && !!item.error;
                                const isStale = !isLoading && !isNa && !!item.is_stale;
                                const rowBg = isLoading ? 'bg-blue-50 hover:bg-blue-100' : isNa ? 'bg-gray-50 hover:bg-gray-100' : isError ? 'bg-red-50 hover:bg-red-100' : isStale ? 'bg-orange-50 hover:bg-orange-100' : 'hover:bg-gray-50';
                                const iconColorClass = isLoading ? 'text-blue-500' : isNa ? 'text-gray-400' : isError ? 'text-red-500' : isStale ? 'text-orange-500' : 'text-green-500';
                                const StatusIcon = isLoading ? FiLoader : isNa ? FiDatabase : isError ? FiAlertCircle : isStale ? FiAlertTriangle : FiCheckCircle;
                                const isExpanded = expandedAssetId === item.asset.id;

                                // Determine source text and date for this row
                                const sourceText = isLoading ? 'Fetching…'
                                    : isNa ? 'No active lots'
                                        : isError ? (item.last_known_source || item.error || 'Error')
                                            : isStale ? (item.source || 'Unknown')
                                                : (item.source || 'Unknown');
                                const sourceDate = isError ? item.last_known_price_date
                                    : item.fetched_at;

                                return (
                                    <React.Fragment key={item.asset.id}>
                                        <tr
                                            className={`cursor-pointer ${rowBg}`}
                                            onClick={() => setExpandedAssetId(isExpanded ? null : item.asset.id!)}
                                        >
                                            <td>
                                                {isLoading ? (
                                                    <Spinner size="xs" className="text-blue-500" />
                                                ) : (
                                                    <span className={iconColorClass}>
                                                        <StatusIcon />
                                                    </span>
                                                )}
                                            </td>
                                            <td className="font-medium">
                                                <div className="flex items-center gap-1">
                                                    <Tooltip content={item.asset.label || item.asset.symbol || ''} openDelay={300} disabled={!item.asset.label}>
                                                        <span>{item.asset.symbol}</span>
                                                    </Tooltip>
                                                    {gapMap.has(item.asset.id!) && (
                                                        <Badge colorScheme="orange">
                                                            {gapMap.get(item.asset.id!)} gap{gapMap.get(item.asset.id!)! !== 1 ? 's' : ''}
                                                        </Badge>
                                                    )}
                                                </div>
                                            </td>
                                            <td>
                                                <span className={isError ? 'font-normal' : 'font-bold'}>
                                                    {isError && item.last_known_price != null
                                                        ? formatCurrency(item.last_known_price, baseCurrency)
                                                        : formatCurrency(item.price, baseCurrency)}
                                                </span>
                                            </td>
                                            <td>
                                                {isLoading ? (
                                                    <span className="text-xs font-medium text-blue-600">Fetching…</span>
                                                ) : isNa ? (
                                                    <span className="text-xs text-gray-500">No active lots</span>
                                                ) : isError ? (
                                                    <div className="flex items-center gap-1">
                                                        <Tooltip content={item.error || ''} openDelay={200}>
                                                            <span className="max-w-[120px] truncate text-xs font-medium text-red-600">
                                                                {item.error}
                                                            </span>
                                                        </Tooltip>
                                                        {sourceDate && (
                                                            <span className="whitespace-nowrap text-xs text-gray-400">
                                                                {formatRelativeTime(sourceDate)}
                                                            </span>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center gap-1">
                                                        <span className="max-w-[100px] truncate text-xs text-gray-600">
                                                            {sourceText}
                                                        </span>
                                                        {sourceDate && (
                                                            <span className="whitespace-nowrap text-xs text-gray-400">
                                                                {formatRelativeTime(sourceDate)}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                            </td>
                                            <td>
                                                <span className={`inline-block text-gray-500 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}>
                                                    <FiChevronDown />
                                                </span>
                                            </td>
                                        </tr>
                                        {isExpanded && (
                                            <tr>
                                                <td colSpan={5} className="bg-gray-50 p-3">
                                                    <GapFixPanel
                                                        assetId={item.asset.id!}
                                                        symbol={item.asset.symbol || ''}
                                                        onOpenPriceSetter={() => handleOpenPriceSetter(item.asset)}
                                                    />
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Manual Price Dialog */}
            {selectedAsset && quoteAssetId && (
                <PriceSetterDialog
                    isOpen={dialogOpen}
                    onClose={() => {
                        setDialogOpen(false);
                        setSelectedAsset(null);
                    }}
                    onSave={handlePriceSaved}
                    assetId={selectedAsset.id}
                    assetName={selectedAsset.symbol}
                    defaultDate={new Date().toISOString()}
                    quoteAssetId={quoteAssetId}
                    quoteAssetName={baseCurrency}
                />
            )}
        </div>
    );
};
