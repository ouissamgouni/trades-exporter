/**
 * PriceGetterTester — Reusable component that tests all configured price getters
 * for a given asset on a given date. Shows results with optional "Use" callback.
 *
 * Used in:
 * - FMV Override dialog (RealizedPnLSlidePanel)
 * - Asset price getters settings (AssetsEditor)
 */

import React, { useEffect, useState } from 'react';
import { Badge, Button, Input, Spinner } from './ui/primitives';
import { API_URL } from '../types';

interface PriceGetterInfo {
    id: number;
    price_getter: string;
    external_id?: string;
    params?: Record<string, any>;
    priority: number;
    enabled: boolean;
}

interface FetchedPriceResult {
    getter: string;
    price?: number;
    error?: string;
    source?: string;
    quote_currency?: string;
    ticker_used?: string;
}

interface PriceGetterTesterProps {
    /** Asset ID to fetch price getters for and test against */
    assetId: number;
    /** Default date (ISO string, e.g. "2025-10-14"). If not set, defaults to yesterday */
    defaultDate?: string;
    /** Called when user clicks "Use" on a result row */
    onUsePrice?: (price: number) => void;
}

export const PriceGetterTester: React.FC<PriceGetterTesterProps> = ({
    assetId,
    defaultDate,
    onUsePrice,
}) => {
    const [priceGetters, setPriceGetters] = useState<PriceGetterInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [testDate, setTestDate] = useState<string>(() => {
        if (defaultDate) return defaultDate.slice(0, 10);
        const d = new Date(); d.setDate(d.getDate() - 1);
        return d.toISOString().slice(0, 10);
    });
    const [results, setResults] = useState<FetchedPriceResult[]>([]);
    const [testing, setTesting] = useState(false);

    // Fetch enabled price getters for this asset
    useEffect(() => {
        setLoading(true);
        setPriceGetters([]);
        setResults([]);
        fetch(`${API_URL}/assets/${assetId}/price-getters`)
            .then(r => r.ok ? r.json() : [])
            .then((getters: PriceGetterInfo[]) => {
                setPriceGetters(getters.filter(g => g.enabled));
                setLoading(false);
            })
            .catch(() => { setPriceGetters([]); setLoading(false); });
    }, [assetId]);

    const runTests = async () => {
        if (priceGetters.length === 0) return;
        setTesting(true);
        setResults([]);
        const all: FetchedPriceResult[] = [];
        for (const pg of priceGetters) {
            try {
                const res = await fetch(`${API_URL}/assets/${assetId}/price-getters/test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        price_getter: pg.price_getter,
                        external_id: pg.external_id || undefined,
                        params: pg.params || {},
                        date: testDate || undefined,
                    }),
                });
                const data = await res.json();
                all.push({
                    getter: pg.price_getter,
                    price: data.success ? data.price : undefined,
                    error: data.error,
                    source: data.source,
                    quote_currency: data.quote_currency,
                    ticker_used: data.ticker_used,
                });
            } catch {
                all.push({ getter: pg.price_getter, error: 'Request failed' });
            }
        }
        setResults(all);
        setTesting(false);
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-2">
                <Spinner size="xs" />
                <span className="text-xs text-slate-500">Loading getters…</span>
            </div>
        );
    }

    if (priceGetters.length === 0) return null;

    return (
        <div className="mt-3 bg-slate-50 p-2">
            <div className="mb-2 flex items-center gap-2">
                <input
                    type="date"
                    value={testDate}
                    onChange={e => { setTestDate(e.target.value); setResults([]); }}
                    className="h-6 w-[130px] shrink-0 border border-slate-300 bg-white px-1 text-xs outline-none focus:border-blue-500"
                />
                <Button
                    size="sm"
                    variant="outline"
                    onClick={runTests}
                    loading={testing}
                    disabled={testing}
                    className="shrink-0"
                >
                    Test {priceGetters.length} getter{priceGetters.length > 1 ? 's' : ''}
                </Button>
            </div>
            {results.map((fp, i) => (
                <div
                    key={i}
                    className={`flex items-center justify-between py-1 ${i > 0 ? 'border-t border-slate-200' : ''}`}
                >
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                        <Badge colorScheme={fp.price != null ? 'green' : 'red'} className="shrink-0">
                            {fp.getter}
                        </Badge>
                        {fp.price != null ? (
                            <span className="truncate text-xs font-medium">
                                {fp.price}
                                {fp.quote_currency && <span className="ml-1 text-slate-400">{fp.quote_currency}</span>}
                            </span>
                        ) : (
                            <span className="truncate text-xs text-red-500">{fp.error || 'No price'}</span>
                        )}
                    </div>
                    {fp.price != null && onUsePrice && (
                        <Button
                            size="sm"
                            variant="ghost"
                            colorScheme="blue"
                            onClick={() => onUsePrice(fp.price!)}
                            className="shrink-0"
                        >
                            Use
                        </Button>
                    )}
                </div>
            ))}
        </div>
    );
};
