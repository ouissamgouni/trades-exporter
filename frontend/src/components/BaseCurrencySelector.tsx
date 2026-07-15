import React, { useState, useEffect, useCallback } from 'react';
import { Button, Heading, Spinner } from './ui/primitives';
import { API_URL, Asset } from '../types';

interface BaseCurrencySelectorProps {
    compact?: boolean;
    onCurrencyChange?: (currency: string) => void;
}

export const BaseCurrencySelector: React.FC<BaseCurrencySelectorProps> = ({
    compact = false,
    onCurrencyChange,
}) => {
    const [fiatAssets, setFiatAssets] = useState<Asset[]>([]);
    const [loading, setLoading] = useState(true);
    const [baseCurrency, setBaseCurrency] = useState<string>('EUR');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        // Fetch both settings and fiat assets on mount
        Promise.all([
            fetch(`${API_URL}/config/settings`).then(r => r.ok ? r.json() : null),
            fetch(`${API_URL}/assets?limit=500`).then(r => r.ok ? r.json() : []),
        ]).then(([settings, assets]) => {
            if (settings?.base_currency) {
                setBaseCurrency(settings.base_currency);
            }
            const fiats = (assets as Asset[]).filter(a => a.price_type === 'fiat');
            setFiatAssets(fiats);
        }).catch(err => {
            console.error('Failed to fetch settings/assets:', err);
        }).finally(() => {
            setLoading(false);
        });
    }, []);

    const handleCurrencyChange = (currency: string) => {
        setBaseCurrency(currency);
        setSaved(false);
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const response = await fetch(`${API_URL}/config/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base_currency: baseCurrency }),
            });
            if (response.ok) {
                setSaved(true);
                onCurrencyChange?.(baseCurrency);
                // Notify other components via custom event
                window.dispatchEvent(new CustomEvent('baseCurrencyChanged', { detail: baseCurrency }));
                setTimeout(() => setSaved(false), 2000);
            } else {
                const err = await response.json();
                console.error('Failed to save:', err.detail);
            }
        } catch (err) {
            console.error('Failed to save base currency:', err);
        } finally {
            setSaving(false);
        }
    };

    // Compact mode: save immediately on change
    const handleCompactChange = async (symbol: string) => {
        setBaseCurrency(symbol);
        try {
            const response = await fetch(`${API_URL}/config/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base_currency: symbol }),
            });
            if (response.ok) {
                onCurrencyChange?.(symbol);
                window.dispatchEvent(new CustomEvent('baseCurrencyChanged', { detail: symbol }));
            }
        } catch (err) {
            console.error('Failed to save base currency:', err);
        }
    };

    if (loading) {
        return (
            <div className={`text-center ${compact ? 'py-2' : 'py-4'}`}>
                <Spinner size="sm" />
                <span className="mt-2 block text-sm">Loading currencies...</span>
            </div>
        );
    }

    // Compact mode for inline display (e.g., in Inbox header)
    if (compact) {
        return (
            <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Base Currency:</span>
                <select
                    value={baseCurrency}
                    onChange={(e) => handleCompactChange(e.target.value)}
                    style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        border: '1px solid #e2e8f0',
                        fontSize: '14px',
                        fontWeight: 'bold',
                    }}
                >
                    {fiatAssets.length > 0 ? (
                        fiatAssets.map(asset => (
                            <option key={asset.asset_id} value={asset.symbol}>
                                {asset.symbol}
                            </option>
                        ))
                    ) : (
                        <>
                            <option value="EUR">EUR</option>
                            <option value="USD">USD</option>
                            <option value="GBP">GBP</option>
                        </>
                    )}
                </select>
            </div>
        );
    }

    // Full mode for Setup tab
    return (
        <div>
            <Heading className="mb-4 text-lg">💱 P&L Settings</Heading>

            <div className="mb-4 border border-slate-200 bg-white p-4">
                <span className="mb-4 block">
                    Select your base currency for P&L calculations and reporting.
                    This is typically your local fiat currency (e.g., EUR, USD).
                </span>

                <div className="flex flex-wrap items-end gap-4">
                    <div className="min-w-[200px] flex-1">
                        <span className="mb-2 block text-sm font-medium">
                            Base Currency for P&L
                        </span>
                        <select
                            value={baseCurrency}
                            onChange={(e) => handleCurrencyChange(e.target.value)}
                            style={{
                                width: '100%',
                                padding: '10px 12px',
                                borderRadius: '6px',
                                border: '1px solid #e2e8f0',
                                fontSize: '16px',
                            }}
                        >
                            {fiatAssets.length > 0 ? (
                                fiatAssets.map(asset => (
                                    <option key={asset.asset_id} value={asset.symbol}>
                                        {asset.symbol} {asset.label ? `- ${asset.label}` : ''}
                                    </option>
                                ))
                            ) : (
                                <>
                                    <option value="EUR">EUR - Euro</option>
                                    <option value="USD">USD - US Dollar</option>
                                    <option value="GBP">GBP - British Pound</option>
                                    <option value="CHF">CHF - Swiss Franc</option>
                                    <option value="JPY">JPY - Japanese Yen</option>
                                </>
                            )}
                        </select>
                    </div>

                    <Button
                        colorScheme="blue"
                        onClick={handleSave}
                        loading={saving}
                    >
                        Save
                    </Button>

                    {saved && (
                        <span className="text-sm text-green-500">
                            ✓ Saved!
                        </span>
                    )}
                </div>

                <div className="mt-6 bg-blue-50 p-4">
                    <span className="mb-2 block font-bold">ℹ️ Why is base currency important?</span>
                    <span className="block text-sm text-slate-700">
                        • <strong>P&L Calculation</strong>: All gains and losses will be calculated
                        and reported in your base currency.
                    </span>
                    <span className="mt-1 block text-sm text-slate-700">
                        • <strong>Cost Basis</strong>: Asset acquisition costs are tracked in your base currency.
                    </span>
                    <span className="mt-1 block text-sm text-slate-700">
                        • <strong>Note</strong>: Taxability is determined by transaction type and taxable events,
                        not by the base currency selection.
                    </span>
                </div>
            </div>

            <div className="border border-slate-200 bg-white p-4">
                <Heading className="mb-3 text-sm">Current Configuration</Heading>
                <div className="flex gap-6">
                    <div>
                        <span className="block text-xs text-slate-500">Selected Base Currency</span>
                        <span className="block text-2xl font-bold text-blue-600">
                            {baseCurrency}
                        </span>
                    </div>
                    <div>
                        <span className="block text-xs text-slate-500">Status</span>
                        <span className="block text-lg font-bold text-green-500">
                            ✓ Configured
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
};

// Hook to get the current base currency from the database
// Single source of truth - no localStorage
export const useBaseCurrency = (): {
    baseCurrency: string;
    baseCurrencyId: number | null;
    isLoading: boolean;
    setBaseCurrency: (currency: string) => Promise<void>;
} => {
    const [baseCurrency, setBaseCurrencyState] = useState<string>('EUR');
    const [baseCurrencyId, setBaseCurrencyIdState] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    // Fetch settings and asset ID from backend on mount
    const fetchSettings = useCallback(async () => {
        try {
            const settingsRes = await fetch(`${API_URL}/config/settings`);
            if (settingsRes.ok) {
                const settings = await settingsRes.json();
                const symbol = settings.base_currency || 'EUR';
                setBaseCurrencyState(symbol);

                // Fetch the asset ID for this symbol
                const assetRes = await fetch(`${API_URL}/assets?symbol=${symbol}&limit=1`);
                if (assetRes.ok) {
                    const assets: Asset[] = await assetRes.json();
                    if (assets.length > 0 && assets[0].asset_id) {
                        setBaseCurrencyIdState(assets[0].asset_id);
                    }
                }
            }
        } catch (err) {
            console.error('Failed to fetch base currency settings:', err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    // Listen for changes from other components
    useEffect(() => {
        const handleChange = (e: Event) => {
            const customEvent = e as CustomEvent<string>;
            if (customEvent.detail) {
                setBaseCurrencyState(customEvent.detail);
                // Refetch ID for the new symbol
                fetch(`${API_URL}/assets?symbol=${customEvent.detail}&limit=1`)
                    .then(r => r.ok ? r.json() : [])
                    .then((assets: Asset[]) => {
                        if (assets.length > 0 && assets[0].asset_id) {
                            setBaseCurrencyIdState(assets[0].asset_id);
                        }
                    })
                    .catch(console.error);
            }
        };
        window.addEventListener('baseCurrencyChanged', handleChange);
        return () => window.removeEventListener('baseCurrencyChanged', handleChange);
    }, []);

    const setBaseCurrency = async (currency: string) => {
        try {
            const response = await fetch(`${API_URL}/config/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ base_currency: currency }),
            });
            if (response.ok) {
                setBaseCurrencyState(currency);
                // Fetch the asset ID for this symbol
                const assetRes = await fetch(`${API_URL}/assets?symbol=${currency}&limit=1`);
                if (assetRes.ok) {
                    const assets: Asset[] = await assetRes.json();
                    if (assets.length > 0 && assets[0].asset_id) {
                        setBaseCurrencyIdState(assets[0].asset_id);
                    }
                }
                window.dispatchEvent(new CustomEvent('baseCurrencyChanged', { detail: currency }));
            }
        } catch (err) {
            console.error('Failed to update base currency:', err);
            throw err;
        }
    };

    return { baseCurrency, baseCurrencyId, isLoading, setBaseCurrency };
};

export default BaseCurrencySelector;
