/**
 * PriceSetterDialog
 *
 * Unified dialog for setting prices on an asset. Two source modes:
 *   - Manual: user enters a price (single-date or date-range with optional interpolation)
 *   - Fetch:  auto-fetch via configured price getters (CoinGecko, etc.)
 *
 * Features:
 *   - Override confirmation: warns before overwriting existing prices
 *   - Interpolation (range mode): linearly fills between a start and end price
 *   - Fetch mode: calls POST /price-snapshots/backfill (only when asset has price getters)
 */

import React, { useMemo, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Button, Input, Spinner } from '../ui/primitives';
import { FiCheck, FiX, FiDownload, FiEdit3, FiAlertTriangle, FiToggleLeft, FiToggleRight, FiPlay } from 'react-icons/fi';
import { API_URL, CheckExistingResponse, TestFetchResponse } from '../../types';
import { toaster } from '../ui/toaster';
import { useBulkManualPrices, useBackfillPrices, PRICE_GAPS_QUERY_KEY, PRICE_GAPS_SUMMARY_QUERY_KEY } from '../../hooks/usePriceGaps';
import { PRICE_TIMESERIES_QUERY_KEY, PRICE_HEALTH_QUERY_KEY } from '../../hooks/usePriceHealth';
import { useAssets } from '../../hooks/useAssets';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import { useQueryClient } from '@tanstack/react-query';

type DateMode = 'single' | 'range';
type SourceMode = 'manual' | 'fetch';

export interface PriceSetterDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: () => void;
    assetId: number;
    assetName: string;
    defaultDate: string;
    quoteAssetId?: number;
    quoteAssetName?: string;
    /** Optional: pre-select date-range mode with these dates */
    defaultDateFrom?: string;
    defaultDateTo?: string;
    /** Optional: pre-fill the price field (e.g. last known price before a gap) */
    defaultPrice?: number | null;
    /** Whether the asset has configured price getters (enables Fetch mode) */
    hasGetters?: boolean;
}

export const PriceSetterDialog: React.FC<PriceSetterDialogProps> = ({
    isOpen,
    onClose,
    onSave,
    assetId,
    assetName,
    defaultDate,
    quoteAssetId,
    quoteAssetName,
    defaultDateFrom,
    defaultDateTo,
    defaultPrice,
    hasGetters = false,
}) => {
    const getDateInputValue = (isoDate: string) => {
        try {
            return new Date(isoDate).toISOString().split('T')[0];
        } catch {
            return new Date().toISOString().split('T')[0];
        }
    };

    const initialDateMode: DateMode = defaultDateFrom && defaultDateTo ? 'range' : 'single';
    const [sourceMode, setSourceMode] = useState<SourceMode>('manual');
    const [dateMode, setDateMode] = useState<DateMode>(initialDateMode);
    const [date, setDate] = useState(getDateInputValue(defaultDate));
    const [dateFrom, setDateFrom] = useState(defaultDateFrom ? getDateInputValue(defaultDateFrom) : getDateInputValue(defaultDate));
    const [dateTo, setDateTo] = useState(defaultDateTo ? getDateInputValue(defaultDateTo) : getDateInputValue(defaultDate));
    const [price, setPrice] = useState<string>(defaultPrice != null ? String(defaultPrice) : '');
    const [interpolate, setInterpolate] = useState(false);
    const [priceStart, setPriceStart] = useState<string>(defaultPrice != null ? String(defaultPrice) : '');
    const [priceEnd, setPriceEnd] = useState<string>('');
    const [isSaving, setIsSaving] = useState(false);

    // Override confirmation state
    const [existingCount, setExistingCount] = useState<number>(0);
    const [showOverrideConfirm, setShowOverrideConfirm] = useState(false);

    // Test-fetch state
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState<TestFetchResponse | null>(null);
    const [testError, setTestError] = useState<string | null>(null);

    const bulkManual = useBulkManualPrices();
    const backfill = useBackfillPrices();
    const qc = useQueryClient();
    const { assets } = useAssets();

    // Resolve base currency from app settings as default quote
    const baseCurrency = useBaseCurrency();
    const resolvedQuoteId = quoteAssetId ?? baseCurrency.assetId;
    const resolvedQuoteName = quoteAssetName ?? baseCurrency.symbol;

    // Quote asset selection
    const [selectedQuoteId, setSelectedQuoteId] = useState<number | undefined>(resolvedQuoteId);

    const quoteOptions = useMemo(() => {
        if (!assets) return [];
        return assets
            .filter(a => a.asset_id != null)
            .map(a => ({ id: a.asset_id!, symbol: a.symbol }))
            .sort((a, b) => a.symbol.localeCompare(b.symbol));
    }, [assets]);

    const selectedQuoteName = useMemo(() => {
        if (!selectedQuoteId) return resolvedQuoteName;
        const found = quoteOptions.find(a => a.id === selectedQuoteId);
        return found?.symbol ?? resolvedQuoteName;
    }, [selectedQuoteId, quoteOptions, resolvedQuoteName]);

    // Reset when dialog opens (only on open transition, not on every prop change)
    const prevOpenRef = React.useRef(false);
    React.useEffect(() => {
        if (isOpen && !prevOpenRef.current) {
            const m = defaultDateFrom && defaultDateTo ? 'range' : 'single';
            setDateMode(m);
            setSourceMode('manual');
            setDate(getDateInputValue(defaultDate));
            setDateFrom(defaultDateFrom ? getDateInputValue(defaultDateFrom) : getDateInputValue(defaultDate));
            setDateTo(defaultDateTo ? getDateInputValue(defaultDateTo) : getDateInputValue(defaultDate));
            setPrice(defaultPrice != null ? String(defaultPrice) : '');
            setPriceStart(defaultPrice != null ? String(defaultPrice) : '');
            setPriceEnd('');
            setInterpolate(false);
            setSelectedQuoteId(resolvedQuoteId);
            setShowOverrideConfirm(false);
            setExistingCount(0);
            setTestResult(null);
            setTestError(null);
        }
        prevOpenRef.current = isOpen;
    });

    // Resolve effective date range for current mode
    const effectiveDateFrom = dateMode === 'single' ? date : dateFrom;
    const effectiveDateTo = dateMode === 'single' ? date : dateTo;

    const handleTestFetch = async () => {
        setIsTesting(true);
        setTestResult(null);
        setTestError(null);
        try {
            const params = new URLSearchParams({
                asset_id: String(assetId),
                date: effectiveDateFrom,
            });
            const res = await fetch(`${API_URL}/price-snapshots/test-fetch?${params}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
                throw new Error(body.detail || `HTTP ${res.status}`);
            }
            const data: TestFetchResponse = await res.json();
            setTestResult(data);
        } catch (err) {
            setTestError(err instanceof Error ? err.message : 'Test fetch failed');
        } finally {
            setIsTesting(false);
        }
    };

    const checkExisting = async (): Promise<number> => {
        try {
            const params = new URLSearchParams({
                asset_id: String(assetId),
                date_from: effectiveDateFrom,
                date_to: effectiveDateTo,
            });
            const res = await fetch(`${API_URL}/price-snapshots/check-existing?${params}`);
            if (!res.ok) return 0;
            const data: CheckExistingResponse = await res.json();
            return data.count;
        } catch {
            return 0;
        }
    };

    const handleSave = async () => {
        if (sourceMode === 'manual') {
            if (interpolate && dateMode === 'range') {
                const ps = parseFloat(priceStart);
                const pe = parseFloat(priceEnd);
                if (isNaN(ps) || ps <= 0 || isNaN(pe) || pe <= 0) {
                    toaster.error({ title: 'Validation error', description: 'Please enter valid start and end prices' });
                    return;
                }
            } else {
                const priceValue = parseFloat(price);
                if (isNaN(priceValue) || priceValue <= 0) {
                    toaster.error({ title: 'Validation error', description: 'Please enter a valid positive price' });
                    return;
                }
            }
        }

        // Check for existing prices before saving (override confirmation)
        if (!showOverrideConfirm) {
            const count = await checkExisting();
            if (count > 0) {
                setExistingCount(count);
                setShowOverrideConfirm(true);
                return;
            }
        }

        await doSave(showOverrideConfirm);
    };

    const doSave = async (force: boolean) => {
        setIsSaving(true);
        try {
            if (sourceMode === 'fetch') {
                // Fetch mode: use backfill endpoint
                const result = await backfill.mutateAsync({
                    asset_id: assetId,
                    date_from: effectiveDateFrom,
                    date_to: effectiveDateTo,
                });
                const fetchedCount = result.fetched?.length ?? 0;
                const failedCount = result.failed?.length ?? 0;
                toaster.success({
                    title: 'Prices fetched',
                    description: `Fetched ${fetchedCount} price(s) for ${assetName}` +
                        (failedCount > 0 ? ` (${failedCount} failed)` : ''),
                });
            } else if (dateMode === 'range') {
                // Manual range
                const priceValue = interpolate ? 0 : parseFloat(price);
                const result = await bulkManual.mutateAsync({
                    asset_id: assetId,
                    quote_asset_id: selectedQuoteId || undefined,
                    date_from: dateFrom,
                    date_to: dateTo,
                    price: interpolate ? 0 : priceValue,
                    source: 'manual',
                    force,
                    interpolate,
                    price_start: interpolate ? parseFloat(priceStart) : undefined,
                    price_end: interpolate ? parseFloat(priceEnd) : undefined,
                });
                const parts: string[] = [`Created ${result.created_count} snapshot(s) for ${assetName}`];
                if (result.overwritten_count > 0) parts.push(`${result.overwritten_count} overwritten`);
                if (result.skipped_count > 0) parts.push(`${result.skipped_count} skipped`);
                toaster.success({ title: 'Prices added', description: parts.join(' · ') });
            } else {
                // Manual single
                const priceValue = parseFloat(price);
                const snapshotTime = new Date(date + 'T00:00:00Z').toISOString();
                const response = await fetch(`${API_URL}/price-snapshots`, {
                    method: force ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        asset_id: assetId,
                        quote_asset_id: selectedQuoteId || null,
                        snapshot_time: snapshotTime,
                        price: priceValue,
                        source: 'manual',
                    }),
                });

                if (!response.ok) {
                    const errData = await response.json();
                    throw new Error(errData.detail || 'Failed to create price');
                }
                qc.invalidateQueries({ queryKey: PRICE_GAPS_QUERY_KEY });
                qc.invalidateQueries({ queryKey: PRICE_GAPS_SUMMARY_QUERY_KEY });
                qc.invalidateQueries({ queryKey: PRICE_TIMESERIES_QUERY_KEY });
                qc.invalidateQueries({ queryKey: PRICE_HEALTH_QUERY_KEY });
                toaster.success({
                    title: 'Price added',
                    description: `Manual price for ${assetName} saved successfully`,
                });
            }
            onSave();
            onClose();
        } catch (err) {
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to save price',
            });
        } finally {
            setIsSaving(false);
            setShowOverrideConfirm(false);
        }
    };

    const isFormValid = sourceMode === 'fetch'
        ? true
        : interpolate && dateMode === 'range'
            ? !!priceStart && !!priceEnd && parseFloat(priceStart) > 0 && parseFloat(priceEnd) > 0
            : !!price && parseFloat(price) > 0;

    return (
        <RadixDialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[2000] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2000] w-full max-w-[460px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-100 px-5 py-4">
                        <RadixDialog.Title className="text-base font-semibold text-slate-900">Price Setter</RadixDialog.Title>
                    </div>
                    <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
                        <div className="flex flex-col gap-4">
                            {/* Asset (read-only) */}
                            <div>
                                <div className="mb-1 text-sm font-medium">Asset</div>
                                <Input value={assetName} readOnly className="cursor-not-allowed bg-gray-100" />
                            </div>

                            {/* Source mode toggle: Manual / Fetch */}
                            <div className="flex gap-2">
                                <Button
                                    size="sm"
                                    variant={sourceMode === 'manual' ? 'solid' : 'outline'}
                                    colorScheme={sourceMode === 'manual' ? 'blue' : 'gray'}
                                    onClick={() => setSourceMode('manual')}
                                >
                                    <FiEdit3 style={{ marginRight: 4 }} /> Manual
                                </Button>
                                <Button
                                    size="sm"
                                    variant={sourceMode === 'fetch' ? 'solid' : 'outline'}
                                    colorScheme={sourceMode === 'fetch' ? 'gray' : 'gray'}
                                    className={sourceMode === 'fetch' ? 'bg-orange-500 text-white hover:bg-orange-600' : ''}
                                    onClick={() => setSourceMode('fetch')}
                                >
                                    <FiDownload style={{ marginRight: 4 }} /> Fetch
                                </Button>
                            </div>

                            {/* Manual-only: Quote Currency */}
                            {sourceMode === 'manual' && (
                                <div>
                                    <div className="mb-1 text-sm font-medium">Quote Currency</div>
                                    <select
                                        className="h-9 w-full border border-slate-200 bg-white px-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                        value={selectedQuoteId ?? ''}
                                        onChange={e => setSelectedQuoteId(e.target.value ? Number(e.target.value) : undefined)}
                                    >
                                        <option value="">— None —</option>
                                        {quoteOptions.map(a => (
                                            <option key={a.id} value={a.id}>{a.symbol}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {/* Date mode toggle (manual only shows single/range) */}
                            {sourceMode === 'manual' && (
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        variant={dateMode === 'single' ? 'solid' : 'outline'}
                                        colorScheme={dateMode === 'single' ? 'blue' : 'gray'}
                                        onClick={() => setDateMode('single')}
                                    >
                                        Single date
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant={dateMode === 'range' ? 'solid' : 'outline'}
                                        colorScheme={dateMode === 'range' ? 'blue' : 'gray'}
                                        onClick={() => setDateMode('range')}
                                    >
                                        Date range
                                    </Button>
                                </div>
                            )}

                            {/* Date fields */}
                            {(sourceMode === 'manual' && dateMode === 'single') ? (
                                <div>
                                    <div className="mb-1 text-sm font-medium">Price Date</div>
                                    <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                                </div>
                            ) : (
                                <div className="flex gap-2">
                                    <div className="flex-1">
                                        <div className="mb-1 text-sm font-medium">From</div>
                                        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                                    </div>
                                    <div className="flex-1">
                                        <div className="mb-1 text-sm font-medium">To</div>
                                        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                                    </div>
                                </div>
                            )}

                            {/* Manual mode: price fields */}
                            {sourceMode === 'manual' && (
                                <>
                                    {/* Interpolation toggle (range only) */}
                                    {dateMode === 'range' && (
                                        <div
                                            className="flex select-none items-center gap-2 cursor-pointer"
                                            onClick={() => setInterpolate(!interpolate)}
                                        >
                                            <span className={`text-xl ${interpolate ? 'text-blue-500' : 'text-gray-400'}`}>
                                                {interpolate ? <FiToggleRight /> : <FiToggleLeft />}
                                            </span>
                                            <span className="text-sm">Interpolation (linear fill between two prices)</span>
                                        </div>
                                    )}

                                    {interpolate && dateMode === 'range' ? (
                                        <div className="flex gap-2">
                                            <div className="flex-1">
                                                <div className="mb-1 text-sm font-medium">
                                                    Start price ({selectedQuoteName})
                                                </div>
                                                <Input
                                                    type="number"
                                                    step="any"
                                                    min="0"
                                                    placeholder="e.g., 40000"
                                                    value={priceStart}
                                                    onChange={(e) => setPriceStart(e.target.value)}
                                                    autoFocus
                                                />
                                            </div>
                                            <div className="flex-1">
                                                <div className="mb-1 text-sm font-medium">
                                                    End price ({selectedQuoteName})
                                                </div>
                                                <Input
                                                    type="number"
                                                    step="any"
                                                    min="0"
                                                    placeholder="e.g., 42000"
                                                    value={priceEnd}
                                                    onChange={(e) => setPriceEnd(e.target.value)}
                                                />
                                            </div>
                                        </div>
                                    ) : (
                                        <div>
                                            <div className="mb-1 text-sm font-medium">
                                                Price in {selectedQuoteName}
                                            </div>
                                            <Input
                                                type="number"
                                                step="any"
                                                min="0"
                                                placeholder="e.g., 42000.50"
                                                value={price}
                                                onChange={(e) => setPrice(e.target.value)}
                                                autoFocus
                                            />
                                            {defaultPrice != null && (
                                                <div className="mt-1 text-xs text-gray-500">
                                                    Pre-filled with last known price before gap
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}

                            {/* Fetch mode info + test */}
                            {sourceMode === 'fetch' && (
                                <div>
                                    <div className="flex items-center justify-between rounded-md bg-orange-50 p-3">
                                        <div className="flex-1 text-sm text-orange-800">
                                            Prices will be fetched from configured price getters
                                            for each missing date in the selected range.
                                        </div>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            colorScheme="gray"
                                            className="ml-2 shrink-0 border-orange-300 text-orange-700 hover:bg-orange-50"
                                            onClick={handleTestFetch}
                                            disabled={isTesting}
                                        >
                                            {isTesting ? <Spinner size="xs" /> : <><FiPlay size={12} style={{ marginRight: 3 }} /> Test</>}
                                        </Button>
                                    </div>
                                    {testResult && (
                                        <div className="mt-2 rounded-md border border-green-200 bg-green-50 p-2">
                                            <div className="text-xs font-medium text-green-800">
                                                Test result for {testResult.date}
                                            </div>
                                            <div className="font-mono text-xs text-green-700">
                                                {testResult.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}
                                                {testResult.quote_currency ? ` ${testResult.quote_currency}` : ''}
                                            </div>
                                            <div className="text-[10px] text-green-600">
                                                Source: {testResult.source}
                                            </div>
                                        </div>
                                    )}
                                    {testError && (
                                        <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2">
                                            <div className="text-xs text-red-700">{testError}</div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Preview for manual range mode */}
                            {sourceMode === 'manual' && dateMode === 'range' && !interpolate && price && parseFloat(price) > 0 && (
                                <div className="rounded-md bg-blue-50 p-2">
                                    <div className="text-xs text-blue-700">
                                        Will create snapshots at {selectedQuoteName} {parseFloat(price).toLocaleString()} for each trading day from {dateFrom} to {dateTo}
                                    </div>
                                </div>
                            )}

                            {/* Preview for interpolation */}
                            {sourceMode === 'manual' && dateMode === 'range' && interpolate && priceStart && priceEnd && (
                                <div className="rounded-md bg-blue-50 p-2">
                                    <div className="text-xs text-blue-700">
                                        Will interpolate linearly from {selectedQuoteName} {parseFloat(priceStart).toLocaleString()} to {parseFloat(priceEnd).toLocaleString()} across each trading day from {dateFrom} to {dateTo}
                                    </div>
                                </div>
                            )}

                            {/* Override confirmation */}
                            {showOverrideConfirm && (
                                <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3">
                                    <div className="mb-1 flex items-center gap-2">
                                        <FiAlertTriangle color="orange" />
                                        <span className="text-sm font-bold text-yellow-800">
                                            {existingCount} existing price(s) found
                                        </span>
                                    </div>
                                    <div className="text-xs text-yellow-700">
                                        Saving will overwrite existing prices in this date range. Click Save again to confirm.
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
                        <Button variant="outline" colorScheme="gray" onClick={onClose} disabled={isSaving}>
                            <FiX style={{ marginRight: 4 }} /> Cancel
                        </Button>
                        <Button
                            colorScheme={showOverrideConfirm ? 'red' : sourceMode === 'fetch' ? 'red' : 'blue'}
                            className={sourceMode === 'fetch' && !showOverrideConfirm ? 'bg-orange-500 hover:bg-orange-600' : ''}
                            onClick={handleSave}
                            disabled={isSaving || !isFormValid}
                        >
                            {isSaving ? (
                                <><Spinner size="xs" className="mr-2" /> {sourceMode === 'fetch' ? 'Fetching...' : 'Saving...'}</>
                            ) : showOverrideConfirm ? (
                                <><FiAlertTriangle style={{ marginRight: 4 }} /> Confirm Override</>
                            ) : sourceMode === 'fetch' ? (
                                <><FiDownload style={{ marginRight: 4 }} /> Fetch Prices</>
                            ) : (
                                <><FiCheck style={{ marginRight: 4 }} /> Save Price</>
                            )}
                        </Button>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};

export default PriceSetterDialog;
