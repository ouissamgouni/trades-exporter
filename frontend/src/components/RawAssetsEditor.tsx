import * as RadixDialog from '@radix-ui/react-dialog';
import { Badge, Button, Heading, Input, Spinner, Text } from './ui/primitives';
import React, { useEffect, useState, useMemo } from 'react';
import { LuChevronLeft, LuChevronRight, LuChevronsLeft, LuChevronsRight } from 'react-icons/lu';
import { API_URL, Asset, RawAsset } from '../types';
import { useAssets } from '../hooks/useAssets';
import { AssetSelector } from './AssetSelector';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';
import { Tooltip } from './ui/tooltip';

// Button primitive only supports blue/red/green/gray - orange needs a className override.
const ORANGE_OUTLINE = 'border-orange-300 text-orange-700 hover:bg-orange-50';

// Fuzzy matching utility for smart suggestions
const calculateSimilarity = (str1: string, str2: string): number => {
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    // Exact match
    if (s1 === s2) return 1.0;

    // Contains match (e.g., "BTCUSDT" contains "BTC")
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;

    // Starts with match
    if (s1.startsWith(s2) || s2.startsWith(s1)) return 0.7;

    // Levenshtein-based similarity for short strings
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;

    const distance = levenshteinDistance(s1, s2);
    return 1 - (distance / maxLen);
};

const levenshteinDistance = (str1: string, str2: string): number => {
    const m = str1.length;
    const n = str2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return dp[m][n];
};

interface SuggestedMatch {
    asset: Asset;
    confidence: number;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

export const RawAssetsEditor: React.FC = () => {
    const [rawAssets, setRawAssets] = useState<RawAsset[]>([]);
    const { assets, refetchAssets } = useAssets();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [editAssetId, setEditAssetId] = useState<number | null>(null);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newRawAsset, setNewRawAsset] = useState<Partial<RawAsset>>({});
    const [sourceFilter, setSourceFilter] = useState('');
    const [linkedFilter, setLinkedFilter] = useState<string>('');

    // Pagination
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

    // Confirmation dialogs
    const deleteConfirm = useConfirmDialog<RawAsset>();
    const autoMapConfirm = useConfirmDialog<{ count: number; items: { rawAsset: RawAsset; assetId: number }[] }>();

    useEffect(() => {
        fetchRawAssets();
    }, [sourceFilter, linkedFilter]);

    const fetchRawAssets = async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (sourceFilter) params.append('source', sourceFilter);
            if (linkedFilter === 'linked') params.append('has_asset_id', 'true');
            if (linkedFilter === 'unlinked') params.append('has_asset_id', 'false');
            const response = await fetch(`${API_URL}/raw-assets?${params}`);
            if (!response.ok) throw new Error('Failed to fetch raw assets');
            const data = await response.json();
            setRawAssets(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    // Compute smart suggestions for unlinked raw assets
    const suggestionsMap = useMemo(() => {
        const map = new Map<string, SuggestedMatch[]>();

        rawAssets
            .filter(ra => ra.asset_id === null)
            .forEach(rawAsset => {
                const symbol = rawAsset.symbol;
                const suggestions: SuggestedMatch[] = [];

                for (const asset of assets) {
                    const similarity = calculateSimilarity(symbol, asset.symbol);
                    if (similarity >= 0.5) {
                        suggestions.push({ asset, confidence: similarity });
                    }
                }

                // Sort by confidence and take top 3
                suggestions.sort((a, b) => b.confidence - a.confidence);
                const key = `${rawAsset.source}:${rawAsset.symbol}`;
                map.set(key, suggestions.slice(0, 3));
            });

        return map;
    }, [rawAssets, assets]);

    const getAssetSymbol = (assetId: number | null | undefined) => {
        if (assetId === null || assetId === undefined) return null;
        const asset = assets.find(a => a.asset_id === assetId);
        return asset?.symbol || `ID:${assetId}`;
    };

    const getEditKey = (rawAsset: RawAsset) => `${rawAsset.source}:${rawAsset.symbol}`;

    const startEditing = (rawAsset: RawAsset) => {
        setEditingKey(getEditKey(rawAsset));
        setEditAssetId(rawAsset.asset_id ?? null);
    };

    const saveRawAsset = async (rawAsset: RawAsset) => {
        try {
            const response = await fetch(`${API_URL}/raw-assets/${encodeURIComponent(rawAsset.source)}/${encodeURIComponent(rawAsset.symbol)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_id: editAssetId })
            });
            if (!response.ok) throw new Error('Failed to update raw asset');
            await fetchRawAssets();
            setEditingKey(null);
            setEditAssetId(null);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    // Quick accept suggestion
    const acceptSuggestion = async (rawAsset: RawAsset, assetId: number) => {
        try {
            const response = await fetch(`${API_URL}/raw-assets/${encodeURIComponent(rawAsset.source)}/${encodeURIComponent(rawAsset.symbol)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_id: assetId })
            });
            if (!response.ok) throw new Error('Failed to update raw asset');
            await fetchRawAssets();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    // Bulk auto-map all high-confidence suggestions
    const autoMapAll = () => {
        const toMap: { rawAsset: RawAsset; assetId: number }[] = [];

        rawAssets
            .filter(ra => ra.asset_id === null)
            .forEach(rawAsset => {
                const key = getEditKey(rawAsset);
                const suggestions = suggestionsMap.get(key) || [];
                // Only auto-map if confidence >= 0.9 (very likely match)
                if (suggestions.length > 0 && suggestions[0].confidence >= 0.9 && suggestions[0].asset.asset_id !== undefined) {
                    toMap.push({ rawAsset, assetId: suggestions[0].asset.asset_id });
                }
            });

        if (toMap.length === 0) {
            toaster.info({ title: 'No matches', description: 'No high-confidence matches found to auto-map' });
            return;
        }

        autoMapConfirm.open({ count: toMap.length, items: toMap });
    };

    const executeAutoMap = async () => {
        if (!autoMapConfirm.data) return;
        for (const { rawAsset, assetId } of autoMapConfirm.data.items) {
            await acceptSuggestion(rawAsset, assetId);
        }
    };

    const createRawAsset = async () => {
        if (!newRawAsset.symbol || !newRawAsset.source) {
            toaster.error({ title: 'Validation error', description: 'Symbol and Source are required' });
            return;
        }
        try {
            const response = await fetch(`${API_URL}/raw-assets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newRawAsset)
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create raw asset');
            }
            await fetchRawAssets();
            setNewRawAsset({});
            setShowCreateDialog(false);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to create' });
        }
    };

    const deleteRawAsset = (rawAsset: RawAsset) => {
        deleteConfirm.open(rawAsset);
    };

    const executeDelete = async () => {
        if (!deleteConfirm.data) return;
        const rawAsset = deleteConfirm.data;
        try {
            const response = await fetch(`${API_URL}/raw-assets/${encodeURIComponent(rawAsset.source)}/${encodeURIComponent(rawAsset.symbol)}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Failed to delete raw asset');
            await fetchRawAssets();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete' });
        }
    };

    const unlinkRawAsset = async (rawAsset: RawAsset) => {
        try {
            const response = await fetch(`${API_URL}/raw-assets/${encodeURIComponent(rawAsset.source)}/${encodeURIComponent(rawAsset.symbol)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_id: null })
            });
            if (!response.ok) throw new Error('Failed to unlink raw asset');
            await fetchRawAssets();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to unlink' });
        }
    };

    // Get unique sources for filter
    const uniqueSources = [...new Set(rawAssets.map(ra => ra.source))];

    // Count suggestions available
    const suggestionsAvailableCount = Array.from(suggestionsMap.values()).filter(s => s.length > 0).length;
    const highConfidenceCount = Array.from(suggestionsMap.values()).filter(s => s.length > 0 && s[0].confidence >= 0.9).length;

    const linkedCount = rawAssets.filter(ra => ra.asset_id !== null).length;
    const unlinkedCount = rawAssets.filter(ra => ra.asset_id === null).length;

    // Pagination computation
    const totalRows = rawAssets.length;
    const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
    const safePage = Math.min(page, pageCount - 1);
    const paginatedRawAssets = useMemo(() => {
        const start = safePage * pageSize;
        return rawAssets.slice(start, start + pageSize);
    }, [rawAssets, safePage, pageSize]);

    // Reset page when data changes
    useEffect(() => { setPage(0); }, [sourceFilter, linkedFilter]);

    if (loading) return (
        <div className="bg-gray-50 py-10 text-center">
            <Spinner size="lg" className="text-blue-500" />
            <Text className="mt-4 block">Loading raw assets...</Text>
        </div>
    );

    if (error) return (
        <div className="border border-red-200 bg-red-50 py-10 text-center">
            <Text className="text-red-600">Error: {error}</Text>
        </div>
    );

    return (
        <div>
            <div className="mb-3 flex items-center justify-between border-b border-gray-200 pb-2">
                <div>
                    <Heading as="h2" className="mb-0.5 text-sm">🔗 Raw Assets Mapping</Heading>
                    <Text className="text-xs text-gray-600">
                        Link source-specific asset symbols to normalized assets.
                    </Text>
                </div>
                <div className="flex gap-2">
                    {highConfidenceCount > 0 && (
                        <Button size="sm" colorScheme="green" variant="outline" className="text-xs" onClick={autoMapAll}>
                            ✨ Auto-Map ({highConfidenceCount})
                        </Button>
                    )}
                    <Button size="sm" colorScheme="blue" className="text-xs" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Mapping
                    </Button>
                    <Button size="sm" onClick={fetchRawAssets} variant="outline" className="text-xs">
                        🔄 Refresh
                    </Button>
                </div>
            </div>

            {/* Smart Suggestions Banner */}
            {suggestionsAvailableCount > 0 && (
                <div className="mb-4 border border-blue-200 bg-blue-50 p-3">
                    <div className="flex justify-between">
                        <Text className="text-xs text-blue-700">
                            💡 <strong>{suggestionsAvailableCount}</strong> unlinked asset(s) have suggested matches.
                            {highConfidenceCount > 0 && ` ${highConfidenceCount} high-confidence match(es) can be auto-mapped.`}
                        </Text>
                    </div>
                </div>
            )}

            <div className="mb-3 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5">
                    <Text className="text-xs font-medium">Source:</Text>
                    <select
                        aria-label="Source filter"
                        className="h-6 w-[130px] border border-gray-300 px-1.5 text-xs"
                        value={sourceFilter}
                        onChange={e => setSourceFilter(e.target.value)}
                    >
                        <option value="">All Sources</option>
                        {uniqueSources.map(source => (
                            <option key={source} value={source}>{source}</option>
                        ))}
                    </select>
                </div>
                <div className="flex items-center gap-1.5">
                    <Text className="text-xs font-medium">Status:</Text>
                    <select
                        aria-label="Status filter"
                        className="h-6 w-[100px] border border-gray-300 px-1.5 text-xs"
                        value={linkedFilter}
                        onChange={e => setLinkedFilter(e.target.value)}
                    >
                        <option value="">All</option>
                        <option value="linked">Linked</option>
                        <option value="unlinked">Unlinked</option>
                    </select>
                </div>
                {(sourceFilter || linkedFilter) && (
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => { setSourceFilter(''); setLinkedFilter(''); }}>
                        Clear Filters
                    </Button>
                )}
            </div>

            {(() => {
                const renderPaginationBar = (borderClass: string) => (
                    <div className={borderClass}>
                        <div className="flex w-full items-center justify-between px-3 py-1.5">
                            <div className="flex items-center gap-2">
                                <Text className="text-[10px] text-gray-500">Rows:</Text>
                                <div className="inline-flex overflow-hidden border border-gray-200">
                                    {PAGE_SIZE_OPTIONS.map((size) => (
                                        <Button
                                            key={size}
                                            variant={pageSize === size ? 'solid' : 'ghost'}
                                            colorScheme={pageSize === size ? 'blue' : 'gray'}
                                            onClick={() => { setPageSize(size); setPage(0); }}
                                            className="h-6 px-2 text-xs"
                                        >
                                            {size}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                            <Text className="text-[10px] text-gray-500">
                                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, totalRows)} of {totalRows}
                            </Text>
                            <div className="flex items-center gap-1">
                                <Button variant="ghost" onClick={() => setPage(0)} disabled={safePage === 0} className="h-6 min-w-0 px-1">
                                    <LuChevronsLeft size={12} />
                                </Button>
                                <Button variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} className="h-6 min-w-0 px-1">
                                    <LuChevronLeft size={14} />
                                </Button>
                                <Text className="mx-1 text-xs text-gray-600">
                                    {safePage + 1} / {pageCount}
                                </Text>
                                <Button variant="ghost" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} className="h-6 min-w-0 px-1">
                                    <LuChevronRight size={14} />
                                </Button>
                                <Button variant="ghost" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} className="h-6 min-w-0 px-1">
                                    <LuChevronsRight size={12} />
                                </Button>
                            </div>
                        </div>
                    </div>
                );

                return (
                    <div className="overflow-x-auto bg-white text-xs shadow-sm">
                        {/* Pagination bar (top) */}
                        {totalRows > PAGE_SIZE_OPTIONS[0] && renderPaginationBar('border-b border-gray-100')}
                        <table className="w-full [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left">
                            <thead>
                                <tr>
                                    <th>Source Symbol</th>
                                    <th>Source</th>
                                    <th>Linked Asset</th>
                                    <th>Suggestions</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rawAssets.length === 0 ? (
                                    <tr>
                                        <td colSpan={5}>
                                            <Text className="block py-8 text-center text-gray-500">
                                                No raw assets found
                                            </Text>
                                        </td>
                                    </tr>
                                ) : (
                                    paginatedRawAssets.map(rawAsset => {
                                        const key = getEditKey(rawAsset);
                                        const isEditing = editingKey === key;
                                        const suggestions = suggestionsMap.get(key) || [];
                                        const isUnlinked = rawAsset.asset_id === null;

                                        return (
                                            <tr key={key} className={isUnlinked ? 'bg-orange-50' : undefined}>
                                                <td className="max-w-[200px]">
                                                    <Text className="truncate text-xs font-medium" title={rawAsset.symbol}>{rawAsset.symbol}</Text>
                                                </td>
                                                <td>
                                                    <Badge colorScheme="purple">{rawAsset.source}</Badge>
                                                </td>
                                                <td>
                                                    {isEditing ? (
                                                        <div className="w-[180px]">
                                                            <AssetSelector
                                                                value={editAssetId}
                                                                onChange={setEditAssetId}
                                                                assets={assets}
                                                                onAssetCreated={refetchAssets}
                                                                defaultSymbol={rawAsset.symbol}
                                                                placeholder="Search assets..."
                                                            />
                                                        </div>
                                                    ) : (
                                                        rawAsset.asset_id ? (
                                                            <Badge colorScheme="green">{getAssetSymbol(rawAsset.asset_id)}</Badge>
                                                        ) : (
                                                            <Text className="text-xs text-gray-400">Not linked</Text>
                                                        )
                                                    )}
                                                </td>
                                                <td>
                                                    {/* Smart Suggestions Column */}
                                                    {isUnlinked && suggestions.length > 0 && !isEditing ? (
                                                        <div className="flex flex-wrap gap-1">
                                                            {suggestions.map((s, idx) => (
                                                                <Tooltip key={idx} content={`${Math.round(s.confidence * 100)}% match - Click to accept`}>
                                                                    <Button
                                                                        size="sm"
                                                                        variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                        colorScheme={s.confidence >= 0.9 ? 'green' : s.confidence >= 0.7 ? 'blue' : 'gray'}
                                                                        className="text-xs"
                                                                        onClick={() => acceptSuggestion(rawAsset, s.asset.asset_id!)}
                                                                    >
                                                                        {s.asset.symbol}
                                                                        {s.confidence >= 0.9 && ' ✓'}
                                                                    </Button>
                                                                </Tooltip>
                                                            ))}
                                                        </div>
                                                    ) : isUnlinked && !isEditing ? (
                                                        <Text className="text-xs text-gray-400">No matches</Text>
                                                    ) : (
                                                        <Text className="text-xs text-gray-400">—</Text>
                                                    )}
                                                </td>
                                                <td>
                                                    <div className="flex gap-1">
                                                        {isEditing ? (
                                                            <>
                                                                <Button size="sm" colorScheme="blue" className="text-xs" onClick={() => saveRawAsset(rawAsset)}>
                                                                    💾
                                                                </Button>
                                                                <Button size="sm" variant="outline" className="text-xs" onClick={() => { setEditingKey(null); setEditAssetId(null); }}>
                                                                    ✗
                                                                </Button>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <Button size="sm" variant="outline" className="text-xs" onClick={() => startEditing(rawAsset)}>
                                                                    🔗
                                                                </Button>
                                                                {rawAsset.asset_id !== null && (
                                                                    <Button size="sm" variant="outline" colorScheme="gray" className={`text-xs ${ORANGE_OUTLINE}`} onClick={() => unlinkRawAsset(rawAsset)}>
                                                                        ⛓️‍💥
                                                                    </Button>
                                                                )}
                                                                <Button size="sm" colorScheme="red" variant="outline" className="text-xs" onClick={() => deleteRawAsset(rawAsset)}>
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
                        {/* Pagination bar (bottom) */}
                        {totalRows > PAGE_SIZE_OPTIONS[0] && renderPaginationBar('border-t border-gray-100')}
                    </div>
                );
            })()}

            <div className="mt-2 bg-white p-2 shadow-sm">
                <Text className="text-xs text-gray-600">
                    <strong>Total:</strong> {rawAssets.length} raw assets
                    {' • '}<Badge colorScheme="green">{linkedCount} linked</Badge>
                    {' • '}<Badge colorScheme="orange">{unlinkedCount} unlinked</Badge>
                </Text>
            </div>

            {/* Create Raw Asset Dialog */}
            <RadixDialog.Root open={showCreateDialog} onOpenChange={setShowCreateDialog}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[1000] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[1000] w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 bg-white shadow-xl">
                        <div className="border-b border-gray-200 px-4 py-3">
                            <RadixDialog.Title className="text-base font-semibold">Add Raw Asset Mapping</RadixDialog.Title>
                        </div>
                        <div className="px-4 py-3">
                            <div className="flex flex-col gap-4">
                                <div>
                                    <Text className="mb-1 block font-medium">Source Symbol *</Text>
                                    <Input
                                        placeholder="e.g., BTCUSDT"
                                        value={newRawAsset.symbol || ''}
                                        onChange={e => setNewRawAsset({ ...newRawAsset, symbol: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <Text className="mb-1 block font-medium">Source *</Text>
                                    <Input
                                        placeholder="e.g., binance, coinbase"
                                        value={newRawAsset.source || ''}
                                        onChange={e => setNewRawAsset({ ...newRawAsset, source: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <Text className="mb-1 block font-medium">Link to Asset (optional)</Text>
                                    <AssetSelector
                                        value={newRawAsset.asset_id ?? null}
                                        onChange={(assetId) => setNewRawAsset({ ...newRawAsset, asset_id: assetId ?? undefined })}
                                        assets={assets}
                                        onAssetCreated={refetchAssets}
                                        defaultSymbol={newRawAsset.symbol || ''}
                                        placeholder="Search or create asset..."
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
                            <Button variant="outline" onClick={() => { setShowCreateDialog(false); setNewRawAsset({}); }}>
                                Cancel
                            </Button>
                            <Button colorScheme="blue" onClick={createRawAsset}>
                                Create Mapping
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Delete Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={deleteConfirm.close}
                onConfirm={executeDelete}
                title="Delete Raw Asset"
                message={deleteConfirm.data ? `Delete raw asset ${deleteConfirm.data.symbol} from ${deleteConfirm.data.source}?` : ''}
                confirmLabel="Delete"
                isDestructive
            />

            {/* Auto-Map Confirmation Dialog */}
            <ConfirmDialog
                isOpen={autoMapConfirm.isOpen}
                onClose={autoMapConfirm.close}
                onConfirm={executeAutoMap}
                title="Auto-Map Raw Assets"
                message={autoMapConfirm.data ? `Auto-map ${autoMapConfirm.data.count} raw asset(s) with high confidence matches?` : ''}
                confirmLabel="Auto-Map"
            />
        </div>
    );
};
