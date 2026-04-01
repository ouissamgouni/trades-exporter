/**
 * AssetPriceGettersEditor — Full CRUD table for an asset's price getters.
 *
 * Extracted from AssetsEditor to be reusable in the AssetDetailSlidePanel.
 * Supports: list, add, edit inline, delete, toggle enabled, test individual,
 * auto-test all, and test unsaved getters.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
    Badge, Box, Button, Flex, IconButton, Input, NativeSelect,
    Spinner, Table, Text, Textarea,
} from '@chakra-ui/react';
import { LuPlay } from 'react-icons/lu';
import { API_URL, Asset, AssetPriceGetter } from '../types';
import { Tooltip } from './ui/tooltip';
import { toaster } from './ui/toaster';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { Dialog, Portal } from '@chakra-ui/react';

interface PriceGetterFormData {
    price_getter: string;
    external_id: string;
    priority: number;
    enabled: boolean;
    params: Record<string, any>;
}

interface AssetPriceGettersEditorProps {
    asset: Asset;
    /** Called after any mutation so parent can refetch */
    onChanged?: () => void;
}

const MOCK_DEFAULTS: Record<string, { min_price: number; max_price: number }> = {
    crypto: { min_price: 100, max_price: 50000 },
    stock: { min_price: 10, max_price: 500 },
    fiat: { min_price: 0.5, max_price: 2 },
};

export const AssetPriceGettersEditor: React.FC<AssetPriceGettersEditorProps> = ({ asset, onChanged }) => {
    const assetId = asset.asset_id!;

    // Available getter names
    const [availableGetters, setAvailableGetters] = useState<string[]>([]);

    // Inline editing state
    const [editingGetterId, setEditingGetterId] = useState<number | null>(null);
    const [editingValues, setEditingValues] = useState<{
        external_id: string;
        priority: number;
        params: string;
    }>({ external_id: '', priority: 100, params: '{}' });

    // Auto-test results
    const [autoTestResults, setAutoTestResults] = useState<Record<number, { success: boolean; price?: number; error?: string; loading?: boolean }>>({});

    // New getter form
    const [newGetter, setNewGetter] = useState<PriceGetterFormData>({
        price_getter: '',
        external_id: '',
        priority: 100,
        enabled: true,
        params: {},
    });
    const [newGetterTestResult, setNewGetterTestResult] = useState<{ success: boolean; price?: number; error?: string } | null>(null);
    const [newGetterTestLoading, setNewGetterTestLoading] = useState(false);

    // Single test modal
    const [showTestModal, setShowTestModal] = useState(false);
    const [testModalGetter, setTestModalGetter] = useState<AssetPriceGetter | null>(null);
    const [testDate, setTestDate] = useState<string>(() => {
        const d = new Date(); d.setDate(d.getDate() - 1);
        return d.toISOString().slice(0, 10);
    });
    const [testResult, setTestResult] = useState<{ success: boolean; price?: number; error?: string; quote_currency?: string; source?: string; ticker_used?: string } | null>(null);
    const [testLoading, setTestLoading] = useState(false);

    // Confirm dialog for delete
    const deleteConfirm = useConfirmDialog<number>();

    // Fetch available getter names
    useEffect(() => {
        fetch(`${API_URL}/assets/price-getters/available`)
            .then(r => r.ok ? r.json() : [])
            .then((data: string[]) => {
                setAvailableGetters(data);
                const firstNonMock = data.find(g => g !== 'mock') || '';
                setNewGetter(prev => ({ ...prev, price_getter: firstNonMock }));
            })
            .catch(() => {});
    }, []);

    // Auto-test all getters when asset changes
    const runAutoTests = useCallback(async (a: Asset) => {
        if (!a.price_getters || a.price_getters.length === 0) return;
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().slice(0, 10);

        const initialResults: Record<number, { success: boolean; loading?: boolean }> = {};
        for (const pg of a.price_getters) {
            initialResults[pg.id] = { success: false, loading: true };
        }
        setAutoTestResults(initialResults);

        const promises = a.price_getters.map(async (pg) => {
            try {
                const res = await fetch(`${API_URL}/assets/${a.asset_id}/price-getters/test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        price_getter: pg.price_getter,
                        external_id: pg.external_id || undefined,
                        params: pg.params || {},
                        date: dateStr,
                    }),
                });
                const data = await res.json();
                setAutoTestResults(prev => ({ ...prev, [pg.id]: { success: data.success, price: data.price, error: data.error } }));
            } catch {
                setAutoTestResults(prev => ({ ...prev, [pg.id]: { success: false, error: 'Network error' } }));
            }
        });
        await Promise.all(promises);
    }, []);

    useEffect(() => { runAutoTests(asset); }, [asset.asset_id]);

    // ── CRUD operations ──────────────────────────────────────────────

    const addPriceGetter = async () => {
        if (!newGetter.price_getter) return;
        try {
            const response = await fetch(`${API_URL}/assets/${assetId}/price-getters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    price_getter: newGetter.price_getter,
                    external_id: newGetter.external_id || null,
                    priority: newGetter.priority,
                    enabled: newGetter.enabled,
                    params: newGetter.params || {},
                }),
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to add price getter');
            }
            toaster.success({ title: 'Price getter added' });
            const firstNonMock = availableGetters.find(g => g !== 'mock') || '';
            setNewGetter({ price_getter: firstNonMock, external_id: '', priority: 100, enabled: true, params: {} });
            setNewGetterTestResult(null);
            onChanged?.();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to add' });
        }
    };

    const executeDelete = async () => {
        if (deleteConfirm.data == null) return;
        try {
            const response = await fetch(`${API_URL}/assets/${assetId}/price-getters/${deleteConfirm.data}`, {
                method: 'DELETE',
            });
            if (!response.ok) throw new Error('Failed to delete price getter');
            toaster.success({ title: 'Price getter removed' });
            onChanged?.();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete' });
        }
    };

    const togglePriceGetter = async (pg: AssetPriceGetter) => {
        try {
            const response = await fetch(`${API_URL}/assets/${assetId}/price-getters/${pg.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !pg.enabled }),
            });
            if (!response.ok) throw new Error('Failed to update');
            onChanged?.();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        }
    };

    // ── Inline editing ───────────────────────────────────────────────

    const startEditingGetter = (pg: AssetPriceGetter) => {
        setEditingGetterId(pg.id);
        let params = pg.params || {};
        if (pg.price_getter === 'mock' && params.min_price == null && params.max_price == null) {
            const defaults = MOCK_DEFAULTS[asset.price_type || 'crypto'] || MOCK_DEFAULTS.crypto;
            params = { ...params, ...defaults };
        }
        setEditingValues({
            external_id: pg.external_id || '',
            priority: pg.priority,
            params: JSON.stringify(params, null, 2),
        });
    };

    const cancelEditingGetter = () => {
        setEditingGetterId(null);
        setEditingValues({ external_id: '', priority: 100, params: '{}' });
    };

    const saveEditingGetter = async () => {
        if (editingGetterId == null) return;
        try {
            let parsedParams = {};
            try { parsedParams = JSON.parse(editingValues.params || '{}'); }
            catch { toaster.error({ title: 'Validation error', description: 'Invalid JSON in parameters' }); return; }

            const response = await fetch(`${API_URL}/assets/${assetId}/price-getters/${editingGetterId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    external_id: editingValues.external_id || null,
                    priority: editingValues.priority,
                    params: parsedParams,
                }),
            });
            if (!response.ok) { const d = await response.json(); throw new Error(d.detail || 'Failed to update'); }
            toaster.success({ title: 'Price getter updated' });
            cancelEditingGetter();
            onChanged?.();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        }
    };

    // ── Test helpers ─────────────────────────────────────────────────

    const openTestModal = (pg: AssetPriceGetter) => {
        setTestModalGetter(pg);
        setTestResult(null);
        setShowTestModal(true);
    };

    const runTestFromModal = async () => {
        if (!testModalGetter) return;
        setTestResult(null);
        setTestLoading(true);
        try {
            const res = await fetch(`${API_URL}/assets/${assetId}/price-getters/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    price_getter: testModalGetter.price_getter,
                    external_id: testModalGetter.external_id || undefined,
                    params: testModalGetter.params || {},
                    date: testDate || undefined,
                }),
            });
            const data = await res.json();
            setTestResult(data);
        } catch (err) {
            setTestResult({ success: false, error: err instanceof Error ? err.message : 'Network error' });
        } finally {
            setTestLoading(false);
        }
    };

    const testNewGetter = async () => {
        if (!newGetter.price_getter) return;
        setNewGetterTestResult(null);
        setNewGetterTestLoading(true);
        try {
            const res = await fetch(`${API_URL}/assets/${assetId}/price-getters/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    price_getter: newGetter.price_getter,
                    external_id: newGetter.external_id || undefined,
                    params: newGetter.params || {},
                    date: testDate || undefined,
                }),
            });
            const data = await res.json();
            setNewGetterTestResult(data);
        } catch (err) {
            setNewGetterTestResult({ success: false, error: err instanceof Error ? err.message : 'Network error' });
        } finally {
            setNewGetterTestLoading(false);
        }
    };

    // ── Render ───────────────────────────────────────────────────────

    const getters = asset.price_getters || [];

    return (
        <Box>

            {/* Unified getters table with inline add row */}
            <Box overflowX="auto">
                <Table.Root size="sm" css={{ '& td, & th': { py: '2px', px: '4px', fontSize: 'xs' }, '& th': { fontSize: '10px' } }}>
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader>Source</Table.ColumnHeader>
                            <Table.ColumnHeader>External ID</Table.ColumnHeader>
                            <Table.ColumnHeader>Parameters</Table.ColumnHeader>
                            <Table.ColumnHeader>Priority</Table.ColumnHeader>
                            <Table.ColumnHeader>Enabled</Table.ColumnHeader>
                            <Table.ColumnHeader>Test</Table.ColumnHeader>
                            <Table.ColumnHeader>Actions</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {getters.map(pg => {
                            const isEditing = editingGetterId === pg.id;
                            const isMock = pg.price_getter === 'mock';
                            const autoResult = autoTestResults[pg.id];
                            const mockMin = pg.params?.min_price;
                            const mockMax = pg.params?.max_price;
                            const paramsEntries = Object.entries(pg.params || {}).filter(
                                ([k]) => !isMock || (k !== 'min_price' && k !== 'max_price'),
                            );
                            const hasParams = isMock ? (mockMin != null || mockMax != null) : paramsEntries.length > 0;

                            return (
                                <Table.Row key={pg.id}>
                                    <Table.Cell>
                                        <Badge colorPalette={isMock ? 'orange' : 'purple'} fontSize="xs">{pg.price_getter}</Badge>
                                    </Table.Cell>
                                    <Table.Cell>
                                        {isEditing ? (
                                            <Input size="xs" value={editingValues.external_id}
                                                onChange={e => setEditingValues(v => ({ ...v, external_id: e.target.value }))}
                                                placeholder="e.g. BTC-USD" fontFamily="mono" fontSize="xs" width="120px" />
                                        ) : (
                                            <Text fontSize="xs" fontFamily="mono">
                                                {pg.external_id || <Text as="span" color="gray.400">(auto)</Text>}
                                            </Text>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell>
                                        {isEditing && isMock ? (
                                            (() => {
                                                let minVal: number | string = '', maxVal: number | string = '';
                                                try { const p = JSON.parse(editingValues.params); minVal = p.min_price ?? ''; maxVal = p.max_price ?? ''; } catch { /* */ }
                                                return (
                                                    <Flex gap={1} align="center">
                                                        <Input size="xs" type="number" placeholder="Min" width="60px" fontSize="xs" value={minVal}
                                                            onChange={e => { try { const p = JSON.parse(editingValues.params || '{}'); p.min_price = e.target.value ? parseFloat(e.target.value) : 0; setEditingValues(v => ({ ...v, params: JSON.stringify(p) })); } catch { /* */ } }} />
                                                        <Text fontSize="xs" color="gray.400">–</Text>
                                                        <Input size="xs" type="number" placeholder="Max" width="60px" fontSize="xs" value={maxVal}
                                                            onChange={e => { try { const p = JSON.parse(editingValues.params || '{}'); p.max_price = e.target.value ? parseFloat(e.target.value) : 0; setEditingValues(v => ({ ...v, params: JSON.stringify(p) })); } catch { /* */ } }} />
                                                    </Flex>
                                                );
                                            })()
                                        ) : isEditing ? (
                                            <Textarea size="sm" value={editingValues.params}
                                                onChange={e => setEditingValues(v => ({ ...v, params: e.target.value }))}
                                                placeholder='{"key": "value"}' fontFamily="mono" fontSize="xs" rows={2} width="150px" />
                                        ) : isMock ? (
                                            <Text fontSize="xs" fontFamily="mono" color="orange.600">
                                                {mockMin != null && mockMax != null ? `${mockMin} – ${mockMax}` : <Text as="span" color="gray.400">no range</Text>}
                                            </Text>
                                        ) : hasParams ? (
                                            <Flex gap={1} flexWrap="wrap">
                                                {paramsEntries.map(([k, v]) => (
                                                    <Badge key={k} colorPalette="gray" fontSize="xs">{k}: {String(v)}</Badge>
                                                ))}
                                            </Flex>
                                        ) : (
                                            <Text fontSize="xs" color="gray.400">—</Text>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell>
                                        {isEditing ? (
                                            <Input size="xs" type="number" fontSize="xs" value={editingValues.priority}
                                                onChange={e => setEditingValues(v => ({ ...v, priority: parseInt(e.target.value) || 100 }))} width="50px" />
                                        ) : <Text fontSize="xs">{pg.priority}</Text>}
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Badge colorPalette={pg.enabled ? 'green' : 'gray'} cursor="pointer" fontSize="xs" onClick={() => togglePriceGetter(pg)}>
                                            {pg.enabled ? 'Yes' : 'No'}
                                        </Badge>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Flex align="center" gap={1}>
                                            {autoResult && (
                                                <Tooltip content={autoResult.loading ? 'Testing...' : autoResult.success ? `✅ ${autoResult.price?.toFixed(6) ?? 'OK'}` : `❌ ${autoResult.error || 'Failed'}`} showArrow>
                                                    <Box cursor="default">
                                                        {autoResult.loading ? <Spinner size="xs" /> : autoResult.success ? <Text color="green.500" fontSize="xs">✅</Text> : <Text color="red.500" fontSize="xs">❌</Text>}
                                                    </Box>
                                                </Tooltip>
                                            )}
                                            <IconButton size="xs" variant="ghost" colorPalette="blue" aria-label="Test getter" onClick={() => openTestModal(pg)}>
                                                <LuPlay size={12} />
                                            </IconButton>
                                        </Flex>
                                    </Table.Cell>
                                    <Table.Cell>
                                        {isEditing ? (
                                            <Flex gap={1}>
                                                <Button size="xs" colorPalette="green" variant="ghost" onClick={saveEditingGetter}>✓</Button>
                                                <Button size="xs" colorPalette="gray" variant="ghost" onClick={cancelEditingGetter}>✕</Button>
                                            </Flex>
                                        ) : (
                                            <Flex gap={1}>
                                                <Button size="xs" colorPalette="blue" variant="ghost" onClick={() => startEditingGetter(pg)}>✏️</Button>
                                                {!isMock && <Button size="xs" colorPalette="red" variant="ghost" onClick={() => deleteConfirm.open(pg.id)}>🗑️</Button>}
                                            </Flex>
                                        )}
                                    </Table.Cell>
                                </Table.Row>
                            );
                        })}
                        {/* Inline add row */}
                        <Table.Row bg="blue.50">
                            <Table.Cell>
                                <NativeSelect.Root size="xs">
                                    <NativeSelect.Field value={newGetter.price_getter} fontSize="xs"
                                        onChange={e => setNewGetter({ ...newGetter, price_getter: e.target.value })}>
                                        <option value="">source…</option>
                                        {availableGetters.filter(g => g !== 'mock').map(g => (
                                            <option key={g} value={g}>{g}</option>
                                        ))}
                                    </NativeSelect.Field>
                                </NativeSelect.Root>
                            </Table.Cell>
                            <Table.Cell>
                                <Input size="xs" fontSize="xs" fontFamily="mono" placeholder={asset.symbol || 'ext. id'}
                                    value={newGetter.external_id || ''}
                                    onChange={e => setNewGetter({ ...newGetter, external_id: e.target.value || '' })} />
                            </Table.Cell>
                            <Table.Cell>
                                <Input size="xs" fontSize="xs" fontFamily="mono" placeholder='{"key":"val"}'
                                    value={Object.keys(newGetter.params).length > 0 ? JSON.stringify(newGetter.params) : ''}
                                    onChange={e => { try { setNewGetter({ ...newGetter, params: e.target.value ? JSON.parse(e.target.value) : {} }); } catch { /* keep current */ } }} />
                            </Table.Cell>
                            <Table.Cell>
                                <Input size="xs" fontSize="xs" type="number" width="50px" value={newGetter.priority}
                                    onChange={e => setNewGetter({ ...newGetter, priority: parseInt(e.target.value) || 100 })} />
                            </Table.Cell>
                            <Table.Cell />
                            <Table.Cell>
                                {newGetterTestLoading ? <Spinner size="xs" /> : (
                                    <IconButton colorPalette="blue" size="xs" variant="ghost" aria-label="Test new getter" onClick={() => {
                                        // Open the test modal with the new getter data
                                        setTestModalGetter({
                                            id: -1,
                                            asset_id: assetId,
                                            price_getter: newGetter.price_getter,
                                            external_id: newGetter.external_id || '',
                                            priority: newGetter.priority,
                                            enabled: newGetter.enabled,
                                            params: newGetter.params || {},
                                        } as AssetPriceGetter);
                                        setTestResult(null);
                                        setShowTestModal(true);
                                    }}
                                        disabled={!newGetter.price_getter}><LuPlay size={12} /></IconButton>
                                )}
                            </Table.Cell>
                            <Table.Cell>
                                <Button colorPalette="blue" size="xs" variant="ghost" onClick={addPriceGetter}
                                    disabled={!newGetter.price_getter}>➕</Button>
                            </Table.Cell>
                        </Table.Row>
                        {newGetterTestResult && (
                            <Table.Row>
                                <Table.Cell colSpan={7}>
                                    <Box p={1} bg={newGetterTestResult.success ? 'green.50' : 'red.50'} borderRadius="sm" fontSize="xs">
                                        {newGetterTestResult.success ? (
                                            <Text color="green.700">✅ {newGetterTestResult.price?.toFixed(6)}</Text>
                                        ) : (
                                            <Text color="red.700">❌ {newGetterTestResult.error}</Text>
                                        )}
                                    </Box>
                                </Table.Cell>
                            </Table.Row>
                        )}
                    </Table.Body>
                </Table.Root>
            </Box>

            {/* Test Price Getter Modal */}
            <Dialog.Root open={showTestModal} onOpenChange={(e) => { setShowTestModal(e.open); if (!e.open) { setTestResult(null); setTestModalGetter(null); } }}>
                <Portal>
                    <Dialog.Backdrop css={{ zIndex: 1600 }} />
                    <Dialog.Positioner css={{ zIndex: 1600 }}>
                        <Dialog.Content maxWidth="420px">
                            <Dialog.Header>
                                <Dialog.Title fontSize="md">
                                    🧪 Test: {testModalGetter?.price_getter}
                                    {testModalGetter?.external_id && (
                                        <Text as="span" fontWeight="normal" fontSize="sm" color="gray.500"> ({testModalGetter.external_id})</Text>
                                    )}
                                </Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={3}>
                                    <Box>
                                        <Text fontSize="sm" fontWeight="medium" mb={1}>Test Date</Text>
                                        <Input size="sm" type="date" value={testDate} onChange={e => setTestDate(e.target.value)} />
                                    </Box>
                                    <Button colorPalette="blue" size="sm" onClick={runTestFromModal} disabled={testLoading}>
                                        {testLoading ? <Spinner size="xs" mr={2} /> : null}
                                        Run Test
                                    </Button>
                                    {testResult && (
                                        <Box p={3} bg={testResult.success ? 'green.50' : 'red.50'} borderRadius="md"
                                            border="1px solid" borderColor={testResult.success ? 'green.200' : 'red.200'}>
                                            {testResult.success ? (
                                                <Flex direction="column" gap={1}>
                                                    <Text color="green.700" fontWeight="medium">✅ Price: {testResult.price?.toFixed(6)}</Text>
                                                    {testResult.source && <Text fontSize="xs" color="gray.600">Source: {testResult.source}</Text>}
                                                    {testResult.quote_currency && <Text fontSize="xs" color="gray.600">Quote: {testResult.quote_currency}</Text>}
                                                    {testResult.ticker_used && <Text fontSize="xs" color="gray.600">Ticker: {testResult.ticker_used}</Text>}
                                                </Flex>
                                            ) : (
                                                <Text color="red.700" fontSize="sm">❌ {testResult.error}</Text>
                                            )}
                                        </Box>
                                    )}
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Button variant="outline" size="sm" onClick={() => setShowTestModal(false)}>Close</Button>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Delete Confirm Dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={deleteConfirm.close}
                title="Delete Price Getter"
                message="Are you sure you want to remove this price getter?"
                confirmLabel="Delete"
                isDestructive
                onConfirm={executeDelete}
            />
        </Box>
    );
};

export default AssetPriceGettersEditor;
