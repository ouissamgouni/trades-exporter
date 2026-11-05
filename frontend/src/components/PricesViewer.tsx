
import * as RadixDialog from '@radix-ui/react-dialog';
import { Button, Heading, Input, Spinner, Text, PageHeader } from './ui/primitives';
import React, { useEffect, useMemo, useState } from 'react';
import { API_URL, Asset, PaginatedPriceSnapshotsResponse, PriceSnapshot } from '../types';
import { useAssets } from '../hooks/useAssets';
import { AssetBadge } from './AssetBadge';
import { AssetSelector } from './AssetSelector';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';
import { usePagination, DEFAULT_PAGE_SIZE } from '../hooks/usePagination';
import { TablePagination } from './TablePagination';
import { PriceHealthCards } from './PriceHealthCards';
import { PriceSetterDialog } from './pnl/PriceSetterDialog';
import { GapFixPanel } from './GapFixPanel';
import { PriceGapBulkFix } from './PriceGapBulkFix';
import { useBaseCurrency } from '../hooks/useBaseCurrency';
import { FiArrowLeft } from 'react-icons/fi';
import { usePriceHealth } from '../hooks/usePriceHealth';

type PriceViewMode = 'health' | 'table';

export const PricesViewer: React.FC = () => {
    const [viewMode, setViewMode] = useState<PriceViewMode>('health');
    const [prices, setPrices] = useState<PriceSnapshot[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const { assets } = useAssets();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [editValues, setEditValues] = useState<Partial<PriceSnapshot>>({});
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [createAssetId, setCreateAssetId] = useState<number | null>(null);
    const [assetIdFilter, setAssetIdFilter] = useState<number | null>(null);
    const [quoteAssetIdFilter, setQuoteAssetIdFilter] = useState<number | null>(null);
    const [sourceFilter, setSourceFilter] = useState<string>('');
    const [snapshotTimeFrom, setSnapshotTimeFrom] = useState<string>('');
    const [snapshotTimeTo, setSnapshotTimeTo] = useState<string>('');
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);
    const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

    // Pagination
    const pagination = usePagination({ storageKey: 'prices', initialPageSize: DEFAULT_PAGE_SIZE });

    const deleteConfirm = useConfirmDialog<PriceSnapshot>();
    const baseCurrency = useBaseCurrency();
    const { data: healthData } = usePriceHealth();

    // When an asset is selected, compute which quote currencies are available for it
    const filteredQuoteAssets = useMemo(() => {
        if (!assetIdFilter || !healthData?.items) return assets;
        const row = healthData.items.find(r => r.asset_id === assetIdFilter);
        if (!row?.quote_currencies?.length) return assets;
        const quoteIds = new Set(row.quote_currencies.map(q => q.asset_id));
        return assets.filter(a => a.asset_id != null && quoteIds.has(a.asset_id));
    }, [assetIdFilter, healthData?.items, assets]);

    const handleViewTable = (assetId: number) => {
        setAssetIdFilter(assetId);
        // Default quote filter to base currency
        if (baseCurrency.assetId) {
            setQuoteAssetIdFilter(baseCurrency.assetId);
        }
        setViewMode('table');
        pagination.firstPage();
    };

    // Calculate pagination offset for server-side pagination
    const offset = (pagination.page - 1) * pagination.pageSize;

    useEffect(() => {
        fetchPrices();
    }, [assetIdFilter, quoteAssetIdFilter, sourceFilter, snapshotTimeFrom, snapshotTimeTo, pagination.page, pagination.pageSize]);

    // Extract unique sources from fetched prices for filter dropdown
    const availableSources = useMemo(() => {
        const sources = new Set<string>();
        prices.forEach(p => {
            if (p.source) sources.add(p.source);
        });
        return Array.from(sources).sort();
    }, [prices]);

    const fetchPrices = async () => {
        setLoading(true);
        setError(null);
        setSelectedIds(new Set()); // Clear selection on refresh
        try {
            const params = new URLSearchParams();
            if (assetIdFilter) params.append('asset_id', String(assetIdFilter));
            if (quoteAssetIdFilter) params.append('quote_asset_id', String(quoteAssetIdFilter));
            if (sourceFilter) params.append('source', sourceFilter);
            if (snapshotTimeFrom) params.append('snapshot_time_from', snapshotTimeFrom);
            if (snapshotTimeTo) params.append('snapshot_time_to', snapshotTimeTo);
            params.append('limit', String(pagination.pageSize));
            params.append('offset', String(offset));
            const response = await fetch(`${API_URL}/price-snapshots?${params}`);
            if (!response.ok) throw new Error('Failed to fetch prices');
            const data: PaginatedPriceSnapshotsResponse = await response.json();
            setPrices(data.items);
            setTotalItems(data.total);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    const getAssetSymbol = (assetId: number | null | undefined) => {
        if (assetId === null || assetId === undefined) return 'Unknown';
        const asset = assets.find(a => a.asset_id === assetId);
        return asset?.symbol || `ID:${assetId}`;
    };

    const formatSnapshotTime = (isoString: string): string => {
        try {
            const date = new Date(isoString);
            return date.toLocaleString(undefined, {
                year: 'numeric',
                month: 'short',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });
        } catch {
            return isoString;
        }
    };

    const clearFilters = () => {
        setAssetIdFilter(null);
        setQuoteAssetIdFilter(null);
        setSourceFilter('');
        setSnapshotTimeFrom('');
        setSnapshotTimeTo('');
        pagination.firstPage();
    };

    const hasActiveFilters = assetIdFilter !== null || quoteAssetIdFilter !== null || sourceFilter || snapshotTimeFrom || snapshotTimeTo;

    const getEditKey = (price: PriceSnapshot) => `${price.snapshot_id}`;

    const startEditing = (price: PriceSnapshot) => {
        setEditingKey(getEditKey(price));
        setEditValues({
            price: price.price,
            source: price.source || '',
        });
    };

    const savePrice = async (price: PriceSnapshot) => {
        try {
            const response = await fetch(`${API_URL}/price-snapshots/${price.snapshot_id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editValues)
            });
            if (!response.ok) throw new Error('Failed to update price');
            await fetchPrices();
            setEditingKey(null);
            setEditValues({});
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    const handleAddPrice = () => {
        if (assetIdFilter) {
            setCreateAssetId(assetIdFilter);
        } else {
            setCreateAssetId(null);
        }
        setShowCreateDialog(true);
    };

    const deletePrice = (price: PriceSnapshot) => {
        deleteConfirm.open(price);
    };

    const executeDelete = async () => {
        if (!deleteConfirm.data) return;
        const price = deleteConfirm.data;
        try {
            const response = await fetch(`${API_URL}/price-snapshots/${price.snapshot_id}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Failed to delete price');
            await fetchPrices();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete price' });
        }
    };

    const toggleSelection = (snapshotId: number) => {
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(snapshotId)) {
                newSet.delete(snapshotId);
            } else {
                newSet.add(snapshotId);
            }
            return newSet;
        });
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === prices.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(prices.map(p => p.snapshot_id)));
        }
    };

    const clearSelection = () => {
        setSelectedIds(new Set());
    };

    const bulkDelete = async () => {
        if (selectedIds.size === 0) return;
        setBulkDeleteLoading(true);
        try {
            const response = await fetch(`${API_URL}/price-snapshots/bulk/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ snapshot_ids: Array.from(selectedIds) })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to delete prices');
            }
            const result = await response.json();
            toaster.success({ title: 'Success', description: `Successfully deleted ${result.affected_count} price record(s)` });
            setShowBulkDeleteDialog(false);
            setSelectedIds(new Set());
            await fetchPrices();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete prices' });
        } finally {
            setBulkDeleteLoading(false);
        }
    };

    return (
        <div>
            <PageHeader
                className="mb-6 border-b border-gray-200 pb-2"
                title="💰 Price Snapshots"
                description={
                    viewMode === 'health'
                        ? 'Monitor price data freshness and detect anomalies across all assets.'
                        : 'View and manage historical cryptocurrency price snapshots.'
                }
                actions={
                    <>
                        <PriceGapBulkFix
                            quoteAssetId={baseCurrency.assetId ?? null}
                            onComplete={viewMode === 'table' ? fetchPrices : undefined}
                        />
                        {/* View mode toggle */}
                        <div className="inline-flex overflow-hidden border border-gray-200">
                            {([{ value: 'health' as const, label: '🩺 Health' }, { value: 'table' as const, label: '📋 Table' }]).map(opt => (
                                <Button
                                    key={opt.value}
                                    size="xs"
                                    variant={viewMode === opt.value ? 'solid' : 'ghost'}
                                    colorScheme={viewMode === opt.value ? 'blue' : 'gray'}
                                    onClick={() => setViewMode(opt.value)}
                                    className="px-3"
                                >
                                    {opt.label}
                                </Button>
                            ))}
                        </div>
                        {viewMode === 'table' && (
                            <>
                                <Button size="xs" colorScheme="blue" onClick={handleAddPrice}>
                                    ➕ Add Price
                                </Button>
                                <Button size="xs" onClick={fetchPrices} variant="outline">
                                    🔄 Refresh
                                </Button>
                            </>
                        )}
                    </>
                }
            />

            {/* === HEALTH VIEW === */}
            {viewMode === 'health' && (
                <PriceHealthCards onViewTable={handleViewTable} />
            )}

            {/* === TABLE VIEW === */}
            {viewMode === 'table' && loading && (
                <div className="bg-gray-50 py-10 text-center">
                    <Spinner size="lg" className="text-blue-500" />
                    <Text className="mt-4 block">Loading prices...</Text>
                </div>
            )}

            {viewMode === 'table' && error && (
                <div className="border border-red-200 bg-red-50 py-10 text-center">
                    <Text className="text-red-600">Error: {error}</Text>
                </div>
            )}

            {viewMode === 'table' && !loading && !error && <>
                {/* Asset detail header with Back + GapFixPanel */}
                {assetIdFilter && (
                    <div className="mb-4">
                        <div className="mb-3 flex items-center gap-2">
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => { setAssetIdFilter(null); setQuoteAssetIdFilter(null); setViewMode('health'); }}
                            >
                                <FiArrowLeft /> Back to Health
                            </Button>
                            <Heading as="h3" className="text-sm">
                                {getAssetSymbol(assetIdFilter)} — Prices
                            </Heading>
                        </div>
                        <GapFixPanel
                            assetId={assetIdFilter}
                            symbol={getAssetSymbol(assetIdFilter)}
                            onOpenPriceSetter={() => { setCreateAssetId(assetIdFilter); setShowCreateDialog(true); }}
                        />
                    </div>
                )}
                <div className="mb-6 flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-2">
                        <Text className="text-sm font-medium">Asset:</Text>
                        <div className="w-[180px]">

                            <AssetSelector
                                value={assetIdFilter}
                                onChange={(id) => { setAssetIdFilter(id); pagination.firstPage(); }}
                                assets={assets}
                                placeholder="All Assets"
                                size="sm"
                            />
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Text className="text-sm font-medium">Quote Asset:</Text>
                        <div className="w-[180px]">
                            <AssetSelector
                                value={quoteAssetIdFilter}
                                onChange={(id) => { setQuoteAssetIdFilter(id); pagination.firstPage(); }}
                                assets={filteredQuoteAssets}
                                placeholder="All Quote Assets"
                                size="sm"
                            />
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Text className="text-sm font-medium">Source:</Text>
                        <select
                            aria-label="Source filter"
                            className="h-8 w-[150px] border border-gray-300 px-2 text-sm"
                            value={sourceFilter}
                            onChange={e => { setSourceFilter(e.target.value); pagination.firstPage(); }}
                        >
                            <option value="">All Sources</option>
                            {availableSources.map(source => (
                                <option key={source} value={source}>
                                    {source}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex items-center gap-2">
                        <Text className="text-sm font-medium">Snapshot Time:</Text>
                        <Input
                            type="datetime-local"
                            className="w-[180px]"
                            placeholder="From"
                            value={snapshotTimeFrom}
                            onChange={e => { setSnapshotTimeFrom(e.target.value); pagination.firstPage(); }}
                        />
                        <Text className="text-sm">to</Text>
                        <Input
                            type="datetime-local"
                            className="w-[180px]"
                            placeholder="To"
                            value={snapshotTimeTo}
                            onChange={e => { setSnapshotTimeTo(e.target.value); pagination.firstPage(); }}
                        />
                    </div>
                    {hasActiveFilters && (
                        <Button size="sm" variant="outline" onClick={clearFilters}>
                            Clear Filters
                        </Button>
                    )}
                </div>

                <div className="overflow-x-auto bg-white shadow-sm">
                    <table className="w-full [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left">
                        <thead>
                            <tr>
                                <th className="w-[40px]">
                                    <input
                                        type="checkbox"
                                        aria-label="Select all price snapshots"
                                        className="h-4 w-4 border border-slate-300"
                                        checked={prices.length > 0 && selectedIds.size === prices.length}
                                        onChange={toggleSelectAll}
                                    />
                                </th>
                                <th>Asset</th>
                                <th>Quote Asset</th>
                                <th>Snapshot Time</th>
                                <th>Price</th>
                                <th>Source</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {prices.length === 0 ? (
                                <tr>
                                    <td colSpan={7}>
                                        <Text className="block py-8 text-center text-gray-500">
                                            No price snapshots found
                                        </Text>
                                    </td>
                                </tr>
                            ) : (
                                prices.map((price, index) => {
                                    const key = price.snapshot_id ? getEditKey(price) : `price-${index}`;
                                    return (
                                        <tr key={key} className={selectedIds.has(price.snapshot_id) ? 'bg-blue-50' : undefined}>
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Select price snapshot ${price.snapshot_id}`}
                                                    className="h-4 w-4 border border-slate-300"
                                                    checked={selectedIds.has(price.snapshot_id)}
                                                    onChange={() => toggleSelection(price.snapshot_id)}
                                                />
                                            </td>
                                            <td>
                                                <AssetBadge
                                                    asset={{
                                                        id: price.asset_id,
                                                        symbol: price.asset_symbol || getAssetSymbol(price.asset_id),
                                                        label: price.asset_label,
                                                    }}
                                                    colorPalette="blue"
                                                    size="xs"
                                                />
                                            </td>
                                            <td>
                                                <AssetBadge
                                                    asset={price.quote_asset_id ? {
                                                        id: price.quote_asset_id,
                                                        symbol: price.quote_asset_symbol || getAssetSymbol(price.quote_asset_id),
                                                        label: price.quote_asset_label,
                                                    } : null}
                                                    colorPalette="green"
                                                    size="xs"
                                                    fallback="-"
                                                />
                                            </td>
                                            <td>
                                                <Text className="text-xs">{formatSnapshotTime(price.snapshot_time)}</Text>
                                            </td>
                                            <td>
                                                {editingKey === key ? (
                                                    <Input
                                                        type="number"
                                                        step="any"
                                                        className="text-sm"
                                                        value={editValues.price ?? ''}
                                                        onChange={e => setEditValues({ ...editValues, price: parseFloat(e.target.value) })}
                                                    />
                                                ) : (
                                                    <Text className="text-xs font-medium">{price.price != null ? price.price.toFixed(8) : '-'}</Text>
                                                )}
                                            </td>
                                            <td>
                                                {editingKey === key ? (
                                                    <Input
                                                        className="text-sm"
                                                        value={editValues.source || ''}
                                                        onChange={e => setEditValues({ ...editValues, source: e.target.value })}
                                                    />
                                                ) : (
                                                    <Text className="text-xs">{price.source || '-'}</Text>
                                                )}
                                            </td>
                                            <td>
                                                <div className="flex gap-1">
                                                    {editingKey === key ? (
                                                        <>
                                                            <Button size="sm" colorScheme="blue" className="text-xs" onClick={() => savePrice(price)}>
                                                                💾
                                                            </Button>
                                                            <Button size="sm" variant="outline" className="text-xs" onClick={() => { setEditingKey(null); setEditValues({}); }}>
                                                                ✗
                                                            </Button>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Button size="sm" variant="outline" className="text-xs" onClick={() => startEditing(price)}>
                                                                ✏️
                                                            </Button>
                                                            <Button size="sm" colorScheme="red" variant="outline" className="text-xs" onClick={() => deletePrice(price)}>
                                                                🗑️
                                                            </Button>
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="mt-4 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                        {/* Left side: Info */}
                        <Text className="text-sm text-gray-600">
                            Showing {totalItems === 0 ? 0 : offset + 1}-{Math.min(offset + pagination.pageSize, totalItems)} of <strong>{totalItems}</strong> records
                            {selectedIds.size > 0 && (
                                <> | <strong>Selected:</strong> {selectedIds.size}</>
                            )}
                        </Text>
                    </div>

                    {/* Pagination controls */}
                    <TablePagination
                        pagination={pagination}
                        total={totalItems}
                    />
                </div>

                {/* Bulk Action Bar */}
                {selectedIds.size > 0 && (
                    <div className="fixed bottom-4 left-1/2 z-10 -translate-x-1/2 bg-gray-800 px-6 py-3 text-white shadow-lg">
                        <div className="flex items-center gap-4">
                            <Text className="font-medium text-white">
                                {selectedIds.size} selected
                            </Text>
                            <Button
                                size="sm"
                                variant="outline"
                                colorScheme="gray"
                                className="border-white/60 text-white hover:bg-white/10"
                                onClick={clearSelection}
                            >
                                Clear Selection
                            </Button>
                            <Button
                                size="sm"
                                colorScheme="red"
                                onClick={() => setShowBulkDeleteDialog(true)}
                            >
                                🗑️ Delete Selected
                            </Button>
                        </div>
                    </div>
                )}

                {/* Bulk Delete Confirmation Dialog */}
                <RadixDialog.Root open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
                    <RadixDialog.Portal>
                        <RadixDialog.Overlay className="fixed inset-0 z-[1000] bg-black/40" />
                        <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[1000] w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 bg-white shadow-xl">
                            <div className="border-b border-gray-200 px-4 py-3">
                                <RadixDialog.Title className="text-base font-semibold">Confirm Bulk Delete</RadixDialog.Title>
                            </div>
                            <div className="px-4 py-3">
                                <Text>
                                    Are you sure you want to delete <strong>{selectedIds.size}</strong> price record(s)?
                                    This action cannot be undone.
                                </Text>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
                                <Button
                                    variant="outline"
                                    onClick={() => setShowBulkDeleteDialog(false)}
                                    disabled={bulkDeleteLoading}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    colorScheme="red"
                                    onClick={bulkDelete}
                                    disabled={bulkDeleteLoading}
                                >
                                    {bulkDeleteLoading ? <Spinner size="sm" /> : 'Delete'}
                                </Button>
                            </div>
                        </RadixDialog.Content>
                    </RadixDialog.Portal>
                </RadixDialog.Root>

                {/* Price Setter Dialog (replaces old inline create dialog) */}
                {showCreateDialog && !createAssetId && (
                    <RadixDialog.Root open={true} onOpenChange={(open: boolean) => !open && setShowCreateDialog(false)}>
                        <RadixDialog.Portal>
                            <RadixDialog.Overlay className="fixed inset-0 z-[2000] bg-black/40" />
                            <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2000] w-full max-w-[360px] -translate-x-1/2 -translate-y-1/2 bg-white shadow-xl">
                                <div className="border-b border-gray-200 px-4 py-3">
                                    <RadixDialog.Title className="text-base font-semibold">Select Asset</RadixDialog.Title>
                                </div>
                                <div className="px-4 py-3">
                                    <Text className="mb-2 text-sm text-gray-600">Choose an asset to add prices for:</Text>
                                    <AssetSelector
                                        value={null}
                                        onChange={(id) => {
                                            if (id) setCreateAssetId(id);
                                        }}
                                        assets={assets}
                                        placeholder="Select asset..."
                                        size="md"
                                    />
                                </div>
                                <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
                                    <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                                        Cancel
                                    </Button>
                                </div>
                            </RadixDialog.Content>
                        </RadixDialog.Portal>
                    </RadixDialog.Root>
                )}

                {showCreateDialog && createAssetId && (
                    <PriceSetterDialog
                        isOpen={true}
                        onClose={() => { setShowCreateDialog(false); setCreateAssetId(null); }}
                        onSave={() => { setShowCreateDialog(false); setCreateAssetId(null); fetchPrices(); }}
                        assetId={createAssetId}
                        assetName={getAssetSymbol(createAssetId)}
                        defaultDate={new Date().toISOString()}
                    />
                )}

            </>}

            {/* Delete Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={deleteConfirm.close}
                onConfirm={executeDelete}
                title="Delete Price Record"
                message="Are you sure you want to delete this price record?"
                confirmLabel="Delete"
                isDestructive
            />
        </div>
    );
};
