/**
 * PnLDefaultsEditor
 * 
 * Allows editing default P&L calculation configuration in the Setup tab.
 * These defaults are used when the background refresh recalculates P&L.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Heading, Spinner, Text } from './ui/primitives';
import { Tooltip } from './ui/tooltip';
import { toaster } from './ui/toaster';
import { API_URL, Asset } from '../types';

interface PnLDefaults {
    base_currency: string;
    pnl_lot_method: string;
    pnl_lot_mode: string;
    pnl_residual_tolerance_pct: number;
    pnl_allow_negative_balances: boolean;
    pnl_crypto_swap_taxable: boolean;
    pnl_fee_taxable: boolean;
    pnl_use_price_fallback: boolean;
    pnl_price_staleness_days: number;
}

const LOT_METHODS = [
    { value: 'FIFO', label: 'FIFO', description: 'First In, First Out' },
    { value: 'LIFO', label: 'LIFO', description: 'Last In, First Out' },
    { value: 'HIFO', label: 'HIFO', description: 'Highest In, First Out' },
];

const LOT_MODES = [
    { value: 'LOT_TRAVEL', label: 'Lot Travel', description: 'Lots travel with transfers between accounts' },
    { value: 'MEGA_WALLET', label: 'Mega Wallet', description: 'All accounts treated as one pool' },
];

const ToggleSwitch: React.FC<{ checked: boolean; onCheckedChange: () => void }> = ({ checked, onCheckedChange }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onCheckedChange}
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${checked ? 'bg-blue-500' : 'bg-gray-300'}`}
    >
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
    </button>
);

export const PnLDefaultsEditor: React.FC = () => {
    const [defaults, setDefaults] = useState<PnLDefaults | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [hasChanges, setHasChanges] = useState(false);
    const [original, setOriginal] = useState<PnLDefaults | null>(null);
    const [fiatAssets, setFiatAssets] = useState<Asset[]>([]);

    const fetchDefaults = useCallback(async () => {
        try {
            setIsLoading(true);
            const [settingsRes, assetsRes] = await Promise.all([
                fetch(`${API_URL}/config/settings`),
                fetch(`${API_URL}/assets?limit=500`),
            ]);
            if (settingsRes.ok) {
                const data = await settingsRes.json();
                const pnlDefaults: PnLDefaults = {
                    base_currency: data.base_currency || 'EUR',
                    pnl_lot_method: data.pnl_lot_method || 'FIFO',
                    pnl_lot_mode: data.pnl_lot_mode || 'LOT_TRAVEL',
                    pnl_residual_tolerance_pct: data.pnl_residual_tolerance_pct ?? 0,
                    pnl_allow_negative_balances: data.pnl_allow_negative_balances ?? true,
                    pnl_crypto_swap_taxable: data.pnl_crypto_swap_taxable ?? false,
                    pnl_fee_taxable: data.pnl_fee_taxable ?? false,
                    pnl_use_price_fallback: data.pnl_use_price_fallback ?? true,
                    pnl_price_staleness_days: data.pnl_price_staleness_days ?? 7,
                };
                setDefaults(pnlDefaults);
                setOriginal(pnlDefaults);
                setHasChanges(false);
            }
            if (assetsRes.ok) {
                const assets: Asset[] = await assetsRes.json();
                setFiatAssets(assets.filter(a => a.price_type === 'fiat'));
            }
        } catch (error) {
            console.error('Error fetching P&L defaults:', error);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchDefaults();
    }, [fetchDefaults]);

    const updateField = <K extends keyof PnLDefaults>(field: K, value: PnLDefaults[K]) => {
        if (!defaults) return;
        const updated = { ...defaults, [field]: value };
        setDefaults(updated);
        setHasChanges(JSON.stringify(updated) !== JSON.stringify(original));
    };

    const handleSave = async () => {
        if (!defaults) return;
        setIsSaving(true);
        try {
            const response = await fetch(`${API_URL}/config/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(defaults),
            });
            if (response.ok) {
                const data = await response.json();
                const saved: PnLDefaults = {
                    base_currency: data.base_currency,
                    pnl_lot_method: data.pnl_lot_method,
                    pnl_lot_mode: data.pnl_lot_mode,
                    pnl_residual_tolerance_pct: data.pnl_residual_tolerance_pct,
                    pnl_allow_negative_balances: data.pnl_allow_negative_balances,
                    pnl_crypto_swap_taxable: data.pnl_crypto_swap_taxable,
                    pnl_fee_taxable: data.pnl_fee_taxable,
                    pnl_use_price_fallback: data.pnl_use_price_fallback,
                    pnl_price_staleness_days: data.pnl_price_staleness_days,
                };
                setDefaults(saved);
                setOriginal(saved);
                setHasChanges(false);
                // Notify other components of base currency change
                window.dispatchEvent(new CustomEvent('baseCurrencyChanged', { detail: data.base_currency }));
                toaster.success({ title: 'P&L defaults saved' });
            } else {
                const err = await response.json().catch(() => ({}));
                toaster.error({ title: 'Failed to save', description: err.detail || 'Unknown error' });
            }
        } catch (error) {
            toaster.error({ title: 'Network error saving P&L defaults' });
        } finally {
            setIsSaving(false);
        }
    };

    const handleReset = () => {
        if (original) {
            setDefaults({ ...original });
            setHasChanges(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center" style={{ minHeight: '200px' }}>
                <Spinner size="lg" />
            </div>
        );
    }

    if (!defaults) {
        return <Text className="text-red-500">Failed to load P&L defaults</Text>;
    }

    return (
        <div className="flex flex-col items-stretch gap-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <Heading as="h2" className="text-base">P&L Calculation Defaults</Heading>
                    <Text className="mt-1 block text-sm text-gray-500">
                        These settings are used when refreshing P&L calculations. Custom calculations can override these.
                    </Text>
                </div>
                {hasChanges && (
                    <div className="flex gap-2">
                        <Button size="sm" variant="ghost" onClick={handleReset}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            colorScheme="blue"
                            onClick={handleSave}
                            loading={isSaving}
                        >
                            Save Defaults
                        </Button>
                    </div>
                )}
            </div>

            {/* 3-Column Grid */}
            <div className="flex border border-gray-200">
                {/* Column 1 — Core */}
                <div className="flex-1 border-r border-gray-200 p-4">
                    <Text className="mb-4 block text-xs font-bold uppercase tracking-wider text-gray-400">Core</Text>

                    {/* Base Currency */}
                    <div className="mb-4">
                        <Text className="mb-1.5 block text-xs text-gray-500">Base Currency</Text>
                        <div className="flex">
                            {fiatAssets.length > 0 ? (
                                fiatAssets.map((asset) => (
                                    <Tooltip key={asset.asset_id} content={asset.label || asset.symbol}>
                                        <div
                                            className={`cursor-pointer px-3 py-1.5 transition-all duration-150 ${defaults.base_currency === asset.symbol ? 'bg-gray-800 text-white hover:bg-gray-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                            onClick={() => updateField('base_currency', asset.symbol)}
                                        >
                                            <Text className="block text-xs font-semibold">{asset.symbol}</Text>
                                        </div>
                                    </Tooltip>
                                ))
                            ) : (
                                ['EUR', 'USD', 'GBP', 'CHF'].map((sym) => (
                                    <div
                                        key={sym}
                                        className={`cursor-pointer px-3 py-1.5 transition-all duration-150 ${defaults.base_currency === sym ? 'bg-gray-800 text-white hover:bg-gray-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                        onClick={() => updateField('base_currency', sym)}
                                    >
                                        <Text className="block text-xs font-semibold">{sym}</Text>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    {/* Cost Method */}
                    <div className="mb-4">
                        <Text className="mb-1.5 block text-xs text-gray-500">Cost Method</Text>
                        <div className="flex">
                            {LOT_METHODS.map((method) => (
                                <Tooltip key={method.value} content={method.description}>
                                    <div
                                        className={`cursor-pointer px-3 py-1.5 transition-all duration-150 ${defaults.pnl_lot_method === method.value ? 'bg-gray-800 text-white hover:bg-gray-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                        onClick={() => updateField('pnl_lot_method', method.value)}
                                    >
                                        <Text className="block text-xs font-semibold">{method.label}</Text>
                                    </div>
                                </Tooltip>
                            ))}
                        </div>
                    </div>

                    {/* Lot Mode */}
                    <div>
                        <Text className="mb-1.5 block text-xs text-gray-500">Lot Mode</Text>
                        <div className="flex">
                            {LOT_MODES.map((mode) => (
                                <Tooltip key={mode.value} content={mode.description}>
                                    <div
                                        className={`cursor-pointer px-3 py-1.5 transition-all duration-150 ${defaults.pnl_lot_mode === mode.value ? 'bg-gray-800 text-white hover:bg-gray-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                        onClick={() => updateField('pnl_lot_mode', mode.value)}
                                    >
                                        <Text className="block text-xs font-semibold">{mode.label}</Text>
                                    </div>
                                </Tooltip>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Column 2 — Tax & Compliance */}
                <div className="flex-1 border-r border-gray-200 p-4">
                    <Text className="mb-4 block text-xs font-bold uppercase tracking-wider text-gray-400">Tax & Compliance</Text>

                    {/* Toggle rows */}
                    <div className="flex flex-col items-stretch gap-2.5">
                        {[
                            { field: 'pnl_allow_negative_balances' as const, label: 'Negative Balances', description: 'Continue calculation even if asset balance goes negative' },
                            { field: 'pnl_crypto_swap_taxable' as const, label: 'Swaps Taxable', description: 'Treat crypto-to-crypto swaps as taxable events' },
                            { field: 'pnl_fee_taxable' as const, label: 'Fees Taxable', description: 'Treat fee disposals as taxable events' },
                        ].map(({ field, label, description }) => (
                            <Tooltip key={field} content={description}>
                                <div className="flex items-center justify-between">
                                    <Text className="text-sm text-gray-700">{label}</Text>
                                    <ToggleSwitch
                                        checked={defaults[field]}
                                        onCheckedChange={() => updateField(field, !defaults[field])}
                                    />
                                </div>
                            </Tooltip>
                        ))}
                    </div>
                </div>

                {/* Column 3 — Advanced */}
                <div className="flex-1 p-4">
                    <Text className="mb-4 block text-xs font-bold uppercase tracking-wider text-gray-400">Advanced</Text>

                    {/* Price Fallback */}
                    <Tooltip content="Fall back to latest known price when fetch fails">
                        <div className="mb-4 flex items-center justify-between">
                            <Text className="text-sm text-gray-700">Price Fallback</Text>
                            <ToggleSwitch
                                checked={defaults.pnl_use_price_fallback}
                                onCheckedChange={() => updateField('pnl_use_price_fallback', !defaults.pnl_use_price_fallback)}
                            />
                        </div>
                    </Tooltip>

                    {/* Residual Tolerance */}
                    <div className="mb-4">
                        <Text className="mb-1.5 block text-xs text-gray-500">Residual Tolerance</Text>
                        <div className="flex">
                            {[0, 0.01, 0.05, 0.1, 0.5, 1.0].map((val) => (
                                <div
                                    key={val}
                                    className={`cursor-pointer px-2.5 py-1 text-xs font-medium transition-all duration-150 ${defaults.pnl_residual_tolerance_pct === val ? 'bg-gray-800 text-white hover:bg-gray-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                    onClick={() => updateField('pnl_residual_tolerance_pct', val)}
                                >
                                    {val === 0 ? 'OFF' : `${val}%`}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Price Staleness */}
                    <div>
                        <Text className="mb-1.5 block text-xs text-gray-500">Staleness Window</Text>
                        <div className="flex">
                            {[1, 3, 7, 14, 30].map((val) => (
                                <div
                                    key={val}
                                    className={`cursor-pointer px-2.5 py-1 text-xs font-medium transition-all duration-150 ${defaults.pnl_price_staleness_days === val ? 'bg-gray-800 text-white hover:bg-gray-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                                    onClick={() => updateField('pnl_price_staleness_days', val)}
                                >
                                    {val}d
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Status Summary */}
            <div className="bg-gray-50 px-3 py-2">
                <Text className="block text-xs text-gray-500">
                    {defaults.base_currency} · {defaults.pnl_lot_method} / {defaults.pnl_lot_mode === 'LOT_TRAVEL' ? 'Lot Travel' : 'Mega Wallet'} ·
                    {' '}Tolerance: {defaults.pnl_residual_tolerance_pct === 0 ? 'OFF' : `${defaults.pnl_residual_tolerance_pct}%`} ·
                    {' '}Neg. balances: {defaults.pnl_allow_negative_balances ? 'yes' : 'no'} ·
                    {' '}Swaps: {defaults.pnl_crypto_swap_taxable ? 'taxable' : 'no'} ·
                    {' '}Fees: {defaults.pnl_fee_taxable ? 'taxable' : 'no'}
                </Text>
            </div>
        </div>
    );
};
