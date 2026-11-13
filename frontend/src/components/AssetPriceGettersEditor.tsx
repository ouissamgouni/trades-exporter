/**
 * AssetPriceGettersEditor — Full CRUD table for an asset's price getters.
 *
 * Extracted from AssetsEditor to be reusable in the AssetDetailSlidePanel.
 * Supports: list, add, edit inline, delete, toggle enabled, test individual,
 * auto-test all, and test unsaved getters.
 */

import React, { useCallback, useEffect, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { LuPlay } from 'react-icons/lu';
import { API_URL, Asset, AssetPriceGetter } from '../types';
import { Tooltip } from './ui/tooltip';
import { toaster } from './ui/toaster';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import {
    Badge, Button, Input, Spinner, Text, Textarea,
} from './ui/primitives';

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
            .catch(() => { });
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
        <div>

            {/* Unified getters table with inline add row */}
            <div className="overflow-x-auto">
                <table className="w-full [&_td]:px-1 [&_td]:py-0.5 [&_td]:text-xs [&_th]:px-1 [&_th]:py-0.5 [&_th]:text-[10px]">
                    <thead>
                        <tr>
                            <th className="text-left">Source</th>
                            <th className="text-left">External ID</th>
                            <th className="text-left">Parameters</th>
                            <th className="text-left">Priority</th>
                            <th className="text-left">Enabled</th>
                            <th className="text-left">Test</th>
                            <th className="text-left">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {getters.map(pg => {
                            const isEditing = editingGetterId === pg.id;
                            const isMock = pg.price_getter === 'mock';
                            const autoResult = autoTestResults[pg.id];
                            const mockMin = pg.params?.min_price;
                            const mockMax = pg.params?.max_price;
                            const mockPrices = pg.params?.prices as Record<string, number> | undefined;
                            const hasConfiguredPrices = isMock && mockPrices && typeof mockPrices === 'object' && Object.keys(mockPrices).length > 0;
                            const mockQuoteCurrency = pg.params?.quote_currency as string | undefined;
                            const paramsEntries = Object.entries(pg.params || {}).filter(
                                ([k]) => !isMock || (k !== 'min_price' && k !== 'max_price'),
                            );
                            const hasParams = isMock ? (mockMin != null || mockMax != null || hasConfiguredPrices) : paramsEntries.length > 0;

                            return (
                                <tr key={pg.id}>
                                    <td>
                                        <Badge colorScheme={isMock ? 'orange' : 'purple'} className="text-xs">{pg.price_getter}</Badge>
                                    </td>
                                    <td>
                                        {isEditing ? (
                                            <Input value={editingValues.external_id}
                                                onChange={e => setEditingValues(v => ({ ...v, external_id: e.target.value }))}
                                                placeholder="e.g. BTC-USD" className="h-6 w-[120px] font-mono text-xs" />
                                        ) : (
                                            <Text className="font-mono text-xs">
                                                {pg.external_id || <Text className="text-gray-400">(auto)</Text>}
                                            </Text>
                                        )}
                                    </td>
                                    <td>
                                        {isEditing && isMock && !hasConfiguredPrices ? (
                                            (() => {
                                                let minVal: number | string = '', maxVal: number | string = '';
                                                try { const p = JSON.parse(editingValues.params); minVal = p.min_price ?? ''; maxVal = p.max_price ?? ''; } catch { /* */ }
                                                return (
                                                    <div className="flex items-center gap-1">
                                                        <Input type="number" placeholder="Min" className="h-6 w-[60px] text-xs" value={minVal}
                                                            onChange={e => { try { const p = JSON.parse(editingValues.params || '{}'); p.min_price = e.target.value ? parseFloat(e.target.value) : 0; setEditingValues(v => ({ ...v, params: JSON.stringify(p) })); } catch { /* */ } }} />
                                                        <Text className="text-xs text-gray-400">–</Text>
                                                        <Input type="number" placeholder="Max" className="h-6 w-[60px] text-xs" value={maxVal}
                                                            onChange={e => { try { const p = JSON.parse(editingValues.params || '{}'); p.max_price = e.target.value ? parseFloat(e.target.value) : 0; setEditingValues(v => ({ ...v, params: JSON.stringify(p) })); } catch { /* */ } }} />
                                                    </div>
                                                );
                                            })()
                                        ) : isEditing ? (
                                            <Textarea value={editingValues.params}
                                                onChange={e => setEditingValues(v => ({ ...v, params: e.target.value }))}
                                                placeholder='{"key": "value"}' rows={2} className="w-[150px] font-mono text-xs" />
                                        ) : isMock && hasConfiguredPrices ? (
                                            <Tooltip content={
                                                <div className="whitespace-pre font-mono text-xs">
                                                    {Object.entries(mockPrices!).map(([k, v]) => (
                                                        <div key={k}>{k} → {v}</div>
                                                    ))}
                                                </div>
                                            }>
                                                <Text className="cursor-default font-mono text-xs text-orange-600">
                                                    {Object.keys(mockPrices!).length} price{Object.keys(mockPrices!).length !== 1 ? 's' : ''}{mockQuoteCurrency ? ` (${mockQuoteCurrency})` : ''}
                                                </Text>
                                            </Tooltip>
                                        ) : isMock ? (
                                            <Text className="font-mono text-xs text-orange-600">
                                                {mockMin != null && mockMax != null ? `${mockMin} – ${mockMax}` : <Text className="text-gray-400">no range</Text>}
                                            </Text>
                                        ) : hasParams ? (
                                            <div className="flex flex-wrap gap-1">
                                                {paramsEntries.map(([k, v]) => (
                                                    <Badge key={k} colorScheme="gray" className="text-xs">{k}: {String(v)}</Badge>
                                                ))}
                                            </div>
                                        ) : (
                                            <Text className="text-xs text-gray-400">—</Text>
                                        )}
                                    </td>
                                    <td>
                                        {isEditing ? (
                                            <Input type="number" className="h-6 w-[50px] text-xs" value={editingValues.priority}
                                                onChange={e => setEditingValues(v => ({ ...v, priority: parseInt(e.target.value) || 100 }))} />
                                        ) : <Text className="text-xs">{pg.priority}</Text>}
                                    </td>
                                    <td>
                                        <Badge colorScheme={pg.enabled ? 'green' : 'gray'} className="cursor-pointer text-xs" onClick={() => togglePriceGetter(pg)}>
                                            {pg.enabled ? 'Yes' : 'No'}
                                        </Badge>
                                    </td>
                                    <td>
                                        <div className="flex items-center gap-1">
                                            {autoResult && (
                                                <Tooltip content={autoResult.loading ? 'Testing...' : autoResult.success ? `✅ ${autoResult.price?.toFixed(6) ?? 'OK'}` : `❌ ${autoResult.error || 'Failed'}`}>
                                                    <div className="cursor-default">
                                                        {autoResult.loading ? <Spinner size="xs" /> : autoResult.success ? <Text className="text-xs text-green-500">✅</Text> : <Text className="text-xs text-red-500">❌</Text>}
                                                    </div>
                                                </Tooltip>
                                            )}
                                            <Button size="sm" variant="ghost" colorScheme="blue" aria-label="Test getter" onClick={() => openTestModal(pg)} className="h-6 w-6 min-w-0 p-0">
                                                <LuPlay size={12} />
                                            </Button>
                                        </div>
                                    </td>
                                    <td>
                                        {isEditing ? (
                                            <div className="flex gap-1">
                                                <Button size="sm" colorScheme="green" variant="ghost" onClick={saveEditingGetter} className="h-6 min-w-0 px-1">✓</Button>
                                                <Button size="sm" colorScheme="gray" variant="ghost" onClick={cancelEditingGetter} className="h-6 min-w-0 px-1">✕</Button>
                                            </div>
                                        ) : (
                                            <div className="flex gap-1">
                                                <Button size="sm" colorScheme="blue" variant="ghost" onClick={() => startEditingGetter(pg)} className="h-6 min-w-0 px-1">✏️</Button>
                                                {!isMock && <Button size="sm" colorScheme="red" variant="ghost" onClick={() => deleteConfirm.open(pg.id)} className="h-6 min-w-0 px-1">🗑️</Button>}
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                        {/* Inline add row */}
                        <tr className="bg-blue-50">
                            <td>
                                <select
                                    value={newGetter.price_getter}
                                    onChange={e => setNewGetter({ ...newGetter, price_getter: e.target.value })}
                                    className="h-6 border border-gray-200 text-xs"
                                    aria-label="Price getter source"
                                >
                                    <option value="">source…</option>
                                    {availableGetters.filter(g => g !== 'mock').map(g => (
                                        <option key={g} value={g}>{g}</option>
                                    ))}
                                </select>
                            </td>
                            <td>
                                <Input placeholder={asset.symbol || 'ext. id'} className="h-6 font-mono text-xs"
                                    value={newGetter.external_id || ''}
                                    onChange={e => setNewGetter({ ...newGetter, external_id: e.target.value || '' })} />
                            </td>
                            <td>
                                <Input placeholder='{"key":"val"}' className="h-6 font-mono text-xs"
                                    value={Object.keys(newGetter.params).length > 0 ? JSON.stringify(newGetter.params) : ''}
                                    onChange={e => { try { setNewGetter({ ...newGetter, params: e.target.value ? JSON.parse(e.target.value) : {} }); } catch { /* keep current */ } }} />
                            </td>
                            <td>
                                <Input type="number" className="h-6 w-[50px] text-xs" value={newGetter.priority}
                                    onChange={e => setNewGetter({ ...newGetter, priority: parseInt(e.target.value) || 100 })} />
                            </td>
                            <td />
                            <td>
                                {newGetterTestLoading ? <Spinner size="xs" /> : (
                                    <Button colorScheme="blue" size="sm" variant="ghost" aria-label="Test new getter" className="h-6 w-6 min-w-0 p-0" onClick={() => {
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
                                        disabled={!newGetter.price_getter}><LuPlay size={12} /></Button>
                                )}
                            </td>
                            <td>
                                <Button colorScheme="blue" size="sm" variant="ghost" className="h-6 min-w-0 px-1" onClick={addPriceGetter}
                                    disabled={!newGetter.price_getter}>➕</Button>
                            </td>
                        </tr>
                        {newGetterTestResult && (
                            <tr>
                                <td colSpan={7}>
                                    <div className={`p-1 text-xs ${newGetterTestResult.success ? 'bg-green-50' : 'bg-red-50'}`}>
                                        {newGetterTestResult.success ? (
                                            <Text className="text-green-700">✅ {newGetterTestResult.price?.toFixed(6)}</Text>
                                        ) : (
                                            <Text className="text-red-700">❌ {newGetterTestResult.error}</Text>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Test Price Getter Modal */}
            <RadixDialog.Root open={showTestModal} onOpenChange={(open) => { setShowTestModal(open); if (!open) { setTestResult(null); setTestModalGetter(null); } }}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 bg-white shadow-xl">
                        <div className="border-b border-gray-100 px-4 py-3">
                            <RadixDialog.Title className="text-base font-semibold">
                                🧪 Test: {testModalGetter?.price_getter}
                                {testModalGetter?.external_id && (
                                    <Text className="text-sm font-normal text-gray-500"> ({testModalGetter.external_id})</Text>
                                )}
                            </RadixDialog.Title>
                        </div>
                        <div className="px-4 py-3">
                            <div className="flex flex-col gap-3">
                                <div>
                                    <Text className="mb-1 text-sm font-medium">Test Date</Text>
                                    <Input type="date" value={testDate} onChange={e => setTestDate(e.target.value)} className="h-8" />
                                </div>
                                <Button colorScheme="blue" size="sm" onClick={runTestFromModal} disabled={testLoading}>
                                    {testLoading ? <Spinner size="xs" className="mr-2" /> : null}
                                    Run Test
                                </Button>
                                {testResult && (
                                    <div className={`border p-3 ${testResult.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                                        {testResult.success ? (
                                            <div className="flex flex-col gap-1">
                                                <Text className="font-medium text-green-700">✅ Price: {testResult.price?.toFixed(6)}</Text>
                                                {testResult.source && <Text className="text-xs text-gray-600">Source: {testResult.source}</Text>}
                                                {testResult.quote_currency && <Text className="text-xs text-gray-600">Quote: {testResult.quote_currency}</Text>}
                                                {testResult.ticker_used && <Text className="text-xs text-gray-600">Ticker: {testResult.ticker_used}</Text>}
                                            </div>
                                        ) : (
                                            <Text className="text-sm text-red-700">❌ {testResult.error}</Text>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex justify-end border-t border-gray-100 px-4 py-3">
                            <Button variant="outline" size="sm" onClick={() => setShowTestModal(false)}>Close</Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

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
        </div>
    );
};

export default AssetPriceGettersEditor;
