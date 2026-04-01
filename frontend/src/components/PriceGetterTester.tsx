/**
 * PriceGetterTester — Reusable component that tests all configured price getters
 * for a given asset on a given date. Shows results with optional "Use" callback.
 *
 * Used in:
 * - FMV Override dialog (RealizedPnLSlidePanel)
 * - Asset price getters settings (AssetsEditor)
 */

import React, { useEffect, useState } from 'react';
import { Badge, Box, Button, Flex, Input, Spinner, Text } from '@chakra-ui/react';
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
            <Flex align="center" gap={2} p={2}>
                <Spinner size="xs" />
                <Text fontSize="xs" color="gray.500">Loading getters…</Text>
            </Flex>
        );
    }

    if (priceGetters.length === 0) return null;

    return (
        <Box mt={3} p={2} bg="gray.50" borderRadius="md">
            <Flex align="center" gap={2} mb={2}>
                <Input
                    size="xs"
                    type="date"
                    value={testDate}
                    onChange={e => { setTestDate(e.target.value); setResults([]); }}
                    width="130px"
                    flexShrink={0}
                />
                <Button
                    size="xs"
                    variant="outline"
                    onClick={runTests}
                    loading={testing}
                    disabled={testing}
                    flexShrink={0}
                >
                    Test {priceGetters.length} getter{priceGetters.length > 1 ? 's' : ''}
                </Button>
            </Flex>
            {results.map((fp, i) => (
                <Flex key={i} align="center" justify="space-between" py={1}
                    borderTop={i > 0 ? '1px solid' : undefined} borderColor="gray.200">
                    <Flex align="center" gap={2} minW={0} overflow="hidden">
                        <Badge size="xs" variant="subtle" colorPalette={fp.price != null ? 'green' : 'red'} flexShrink={0}>
                            {fp.getter}
                        </Badge>
                        {fp.price != null ? (
                            <Text fontSize="xs" fontWeight="medium" truncate>
                                {fp.price}
                                {fp.quote_currency && <Text as="span" color="gray.400" ml={1}>{fp.quote_currency}</Text>}
                            </Text>
                        ) : (
                            <Text fontSize="xs" color="red.500" truncate>{fp.error || 'No price'}</Text>
                        )}
                    </Flex>
                    {fp.price != null && onUsePrice && (
                        <Button
                            size="xs"
                            variant="ghost"
                            colorPalette="blue"
                            onClick={() => onUsePrice(fp.price!)}
                            flexShrink={0}
                        >
                            Use
                        </Button>
                    )}
                </Flex>
            ))}
        </Box>
    );
};
