import {
    Badge, Box,
    Button, Dialog, Flex,
    Heading, Input, NativeSelect, Portal, Spinner,
    Table, Text, HStack
} from '@chakra-ui/react';
import React, { useEffect, useState, useMemo } from 'react';
import { LuChevronLeft, LuChevronRight, LuChevronsLeft, LuChevronsRight } from 'react-icons/lu';
import { API_URL, Asset, RawAsset } from '../types';
import { useAssets } from '../hooks/useAssets';
import { AssetSelector } from './AssetSelector';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';
import { Tooltip } from './ui/tooltip';

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
        <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
            <Spinner size="xl" color="blue.500" />
            <Text mt={4}>Loading raw assets...</Text>
        </Box>
    );

    if (error) return (
        <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
            <Text color="red.600">Error: {error}</Text>
        </Box>
    );

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={3} borderBottom="1px" borderColor="gray.200" pb={2}>
                <Box>
                    <Heading as="h2" size="sm" mb={0.5}>🔗 Raw Assets Mapping</Heading>
                    <Text color="gray.600" fontSize="xs">
                        Link source-specific asset symbols to normalized assets.
                    </Text>
                </Box>
                <Flex gap={2}>
                    {highConfidenceCount > 0 && (
                        <Button size="xs" colorPalette="green" variant="outline" onClick={autoMapAll}>
                            ✨ Auto-Map ({highConfidenceCount})
                        </Button>
                    )}
                    <Button size="xs" colorPalette="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Mapping
                    </Button>
                    <Button size="xs" onClick={fetchRawAssets} variant="outline">
                        🔄 Refresh
                    </Button>
                </Flex>
            </Flex>

            {/* Smart Suggestions Banner */}
            {suggestionsAvailableCount > 0 && (
                <Box mb={4} p={3} bg="blue.50" borderRadius="md" borderWidth={1} borderColor="blue.200">
                    <HStack justify="space-between">
                        <Text fontSize="xs" color="blue.700">
                            💡 <strong>{suggestionsAvailableCount}</strong> unlinked asset(s) have suggested matches.
                            {highConfidenceCount > 0 && ` ${highConfidenceCount} high-confidence match(es) can be auto-mapped.`}
                        </Text>
                    </HStack>
                </Box>
            )}

            <Flex gap={3} mb={3} align="center" flexWrap="wrap">
                <Flex align="center" gap={1.5}>
                    <Text fontWeight="medium" fontSize="xs">Source:</Text>
                    <NativeSelect.Root size="xs" width="130px">
                        <NativeSelect.Field
                            value={sourceFilter}
                            onChange={e => setSourceFilter(e.target.value)}
                        >
                            <option value="">All Sources</option>
                            {uniqueSources.map(source => (
                                <option key={source} value={source}>{source}</option>
                            ))}
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                <Flex align="center" gap={1.5}>
                    <Text fontWeight="medium" fontSize="xs">Status:</Text>
                    <NativeSelect.Root size="xs" width="100px">
                        <NativeSelect.Field
                            value={linkedFilter}
                            onChange={e => setLinkedFilter(e.target.value)}
                        >
                            <option value="">All</option>
                            <option value="linked">Linked</option>
                            <option value="unlinked">Unlinked</option>
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                {(sourceFilter || linkedFilter) && (
                    <Button size="xs" variant="outline" onClick={() => { setSourceFilter(''); setLinkedFilter(''); }}>
                        Clear Filters
                    </Button>
                )}
            </Flex>

            <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm" fontSize="xs">
                {/* Pagination bar (top) */}
                {totalRows > PAGE_SIZE_OPTIONS[0] && (
                    <Box borderBottom="1px solid" borderColor="gray.100">
                        <Flex justify="space-between" align="center" width="100%" py={1.5} px={3}>
                            <Flex align="center" gap={2}>
                                <Text fontSize="2xs" color="gray.500">Rows:</Text>
                                <Flex borderRadius="md" border="1px solid" borderColor="gray.200" overflow="hidden" display="inline-flex">
                                    {PAGE_SIZE_OPTIONS.map((size) => (
                                        <Button
                                            key={size}
                                            size="2xs"
                                            variant={pageSize === size ? 'subtle' : 'ghost'}
                                            colorPalette={pageSize === size ? 'blue' : 'gray'}
                                            borderRadius="0"
                                            onClick={() => { setPageSize(size); setPage(0); }}
                                            px={2}
                                            fontSize="xs"
                                        >
                                            {size}
                                        </Button>
                                    ))}
                                </Flex>
                            </Flex>
                            <Text fontSize="2xs" color="gray.500">
                                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, totalRows)} of {totalRows}
                            </Text>
                            <Flex align="center" gap={1}>
                                <Button size="2xs" variant="ghost" onClick={() => setPage(0)} disabled={safePage === 0} px={1}>
                                    <LuChevronsLeft size={12} />
                                </Button>
                                <Button size="2xs" variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} px={1}>
                                    <LuChevronLeft size={14} />
                                </Button>
                                <Text fontSize="xs" color="gray.600" mx={1}>
                                    {safePage + 1} / {pageCount}
                                </Text>
                                <Button size="2xs" variant="ghost" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} px={1}>
                                    <LuChevronRight size={14} />
                                </Button>
                                <Button size="2xs" variant="ghost" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} px={1}>
                                    <LuChevronsRight size={12} />
                                </Button>
                            </Flex>
                        </Flex>
                    </Box>
                )}
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader>Source Symbol</Table.ColumnHeader>
                            <Table.ColumnHeader>Source</Table.ColumnHeader>
                            <Table.ColumnHeader>Linked Asset</Table.ColumnHeader>
                            <Table.ColumnHeader>Suggestions</Table.ColumnHeader>
                            <Table.ColumnHeader>Actions</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {rawAssets.length === 0 ? (
                            <Table.Row>
                                <Table.Cell colSpan={5}>
                                    <Text textAlign="center" py={8} color="gray.500">
                                        No raw assets found
                                    </Text>
                                </Table.Cell>
                            </Table.Row>
                        ) : (
                            paginatedRawAssets.map(rawAsset => {
                                const key = getEditKey(rawAsset);
                                const isEditing = editingKey === key;
                                const suggestions = suggestionsMap.get(key) || [];
                                const isUnlinked = rawAsset.asset_id === null;

                                return (
                                    <Table.Row key={key} bg={isUnlinked ? 'orange.50' : undefined}>
                                        <Table.Cell maxW="200px">
                                            <Text fontWeight="medium" fontSize="xs" truncate title={rawAsset.symbol}>{rawAsset.symbol}</Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge colorPalette="purple">{rawAsset.source}</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {isEditing ? (
                                                <Box width="180px">
                                                    <AssetSelector
                                                        value={editAssetId}
                                                        onChange={setEditAssetId}
                                                        assets={assets}
                                                        onAssetCreated={refetchAssets}
                                                        defaultSymbol={rawAsset.symbol}
                                                        placeholder="Search assets..."
                                                    />
                                                </Box>
                                            ) : (
                                                rawAsset.asset_id ? (
                                                    <Badge colorPalette="green">{getAssetSymbol(rawAsset.asset_id)}</Badge>
                                                ) : (
                                                    <Text fontSize="xs" color="gray.400">Not linked</Text>
                                                )
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            {/* Smart Suggestions Column */}
                                            {isUnlinked && suggestions.length > 0 && !isEditing ? (
                                                <HStack gap={1} flexWrap="wrap">
                                                    {suggestions.map((s, idx) => (
                                                        <Tooltip key={idx} content={`${Math.round(s.confidence * 100)}% match - Click to accept`}>
                                                            <Button
                                                                size="xs"
                                                                variant={s.confidence >= 0.9 ? "solid" : "outline"}
                                                                colorPalette={s.confidence >= 0.9 ? "green" : s.confidence >= 0.7 ? "blue" : "gray"}
                                                                onClick={() => acceptSuggestion(rawAsset, s.asset.asset_id!)}
                                                            >
                                                                {s.asset.symbol}
                                                                {s.confidence >= 0.9 && " ✓"}
                                                            </Button>
                                                        </Tooltip>
                                                    ))}
                                                </HStack>
                                            ) : isUnlinked && !isEditing ? (
                                                <Text fontSize="xs" color="gray.400">No matches</Text>
                                            ) : (
                                                <Text fontSize="xs" color="gray.400">—</Text>
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Flex gap={1}>
                                                {isEditing ? (
                                                    <>
                                                        <Button size="xs" colorPalette="blue" onClick={() => saveRawAsset(rawAsset)}>
                                                            💾
                                                        </Button>
                                                        <Button size="xs" variant="outline" onClick={() => { setEditingKey(null); setEditAssetId(null); }}>
                                                            ✗
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <Button size="xs" variant="outline" onClick={() => startEditing(rawAsset)}>
                                                            🔗
                                                        </Button>
                                                        {rawAsset.asset_id !== null && (
                                                            <Button size="xs" colorPalette="orange" variant="outline" onClick={() => unlinkRawAsset(rawAsset)}>
                                                                ⛓️‍💥
                                                            </Button>
                                                        )}
                                                        <Button size="xs" colorPalette="red" variant="outline" onClick={() => deleteRawAsset(rawAsset)}>
                                                            🗑️
                                                        </Button>
                                                    </>
                                                )}
                                            </Flex>
                                        </Table.Cell>
                                    </Table.Row>
                                );
                            })
                        )}
                    </Table.Body>
                </Table.Root>
                {/* Pagination bar (bottom) */}
                {totalRows > PAGE_SIZE_OPTIONS[0] && (
                    <Box borderTop="1px solid" borderColor="gray.100">
                        <Flex justify="space-between" align="center" width="100%" py={1.5} px={3}>
                            <Flex align="center" gap={2}>
                                <Text fontSize="2xs" color="gray.500">Rows:</Text>
                                <Flex borderRadius="md" border="1px solid" borderColor="gray.200" overflow="hidden" display="inline-flex">
                                    {PAGE_SIZE_OPTIONS.map((size) => (
                                        <Button
                                            key={size}
                                            size="2xs"
                                            variant={pageSize === size ? 'subtle' : 'ghost'}
                                            colorPalette={pageSize === size ? 'blue' : 'gray'}
                                            borderRadius="0"
                                            onClick={() => { setPageSize(size); setPage(0); }}
                                            px={2}
                                            fontSize="xs"
                                        >
                                            {size}
                                        </Button>
                                    ))}
                                </Flex>
                            </Flex>
                            <Text fontSize="2xs" color="gray.500">
                                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, totalRows)} of {totalRows}
                            </Text>
                            <Flex align="center" gap={1}>
                                <Button size="2xs" variant="ghost" onClick={() => setPage(0)} disabled={safePage === 0} px={1}>
                                    <LuChevronsLeft size={12} />
                                </Button>
                                <Button size="2xs" variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} px={1}>
                                    <LuChevronLeft size={14} />
                                </Button>
                                <Text fontSize="xs" color="gray.600" mx={1}>
                                    {safePage + 1} / {pageCount}
                                </Text>
                                <Button size="2xs" variant="ghost" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} px={1}>
                                    <LuChevronRight size={14} />
                                </Button>
                                <Button size="2xs" variant="ghost" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} px={1}>
                                    <LuChevronsRight size={12} />
                                </Button>
                            </Flex>
                        </Flex>
                    </Box>
                )}
            </Box>

            <Box mt={2} p={2} bg="white" borderRadius="md" boxShadow="sm">
                <Text fontSize="xs" color="gray.600">
                    <strong>Total:</strong> {rawAssets.length} raw assets
                    {' • '}<Badge colorPalette="green" size="sm">{linkedCount} linked</Badge>
                    {' • '}<Badge colorPalette="orange" size="sm">{unlinkedCount} unlinked</Badge>
                </Text>
            </Box>

            {/* Create Raw Asset Dialog */}
            <Dialog.Root open={showCreateDialog} onOpenChange={(e) => setShowCreateDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Add Raw Asset Mapping</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Source Symbol *</Text>
                                        <Input
                                            placeholder="e.g., BTCUSDT"
                                            value={newRawAsset.symbol || ''}
                                            onChange={e => setNewRawAsset({ ...newRawAsset, symbol: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Source *</Text>
                                        <Input
                                            placeholder="e.g., binance, coinbase"
                                            value={newRawAsset.source || ''}
                                            onChange={e => setNewRawAsset({ ...newRawAsset, source: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Link to Asset (optional)</Text>
                                        <AssetSelector
                                            value={newRawAsset.asset_id ?? null}
                                            onChange={(assetId) => setNewRawAsset({ ...newRawAsset, asset_id: assetId ?? undefined })}
                                            assets={assets}
                                            onAssetCreated={refetchAssets}
                                            defaultSymbol={newRawAsset.symbol || ''}
                                            placeholder="Search or create asset..."
                                        />
                                    </Box>
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => { setShowCreateDialog(false); setNewRawAsset({}); }}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="blue" onClick={createRawAsset}>
                                        Create Mapping
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

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
        </Box>
    );
};
