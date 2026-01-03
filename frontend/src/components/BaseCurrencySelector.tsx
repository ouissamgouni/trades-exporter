import React, { useState, useEffect } from 'react';
import {
    Box,
    Button,
    Card,
    Flex,
    Heading,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { API_URL, Asset } from '../types';

// Local storage keys for persisting base currency
const BASE_CURRENCY_KEY = 'trades_exporter_base_currency';
const BASE_CURRENCY_ID_KEY = 'trades_exporter_base_currency_id';

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
    const [baseCurrency, setBaseCurrency] = useState<string>(() => {
        // Load from localStorage or default to EUR
        return localStorage.getItem(BASE_CURRENCY_KEY) || 'EUR';
    });
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        fetchFiatAssets();
    }, []);

    const fetchFiatAssets = async () => {
        try {
            const response = await fetch(`${API_URL}/assets?limit=500`);
            if (response.ok) {
                const assets: Asset[] = await response.json();
                // Filter to fiat assets only
                const fiats = assets.filter(a => a.price_type === 'fiat');
                setFiatAssets(fiats);
            }
        } catch (err) {
            console.error('Failed to fetch fiat assets:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleCurrencyChange = (currency: string) => {
        setBaseCurrency(currency);
        setSaved(false);
    };

    const handleSave = () => {
        localStorage.setItem(BASE_CURRENCY_KEY, baseCurrency);
        // Also save the asset ID
        const asset = fiatAssets.find(a => a.symbol === baseCurrency);
        if (asset?.asset_id) {
            localStorage.setItem(BASE_CURRENCY_ID_KEY, String(asset.asset_id));
        }
        setSaved(true);
        onCurrencyChange?.(baseCurrency);
        // Dispatch storage event for other components
        window.dispatchEvent(new Event('storage'));

        // Auto-hide saved message after 2 seconds
        setTimeout(() => setSaved(false), 2000);
    };

    if (loading) {
        return (
            <Box textAlign="center" py={compact ? 2 : 4}>
                <Spinner size="sm" />
                <Text fontSize="sm" mt={2}>Loading currencies...</Text>
            </Box>
        );
    }

    // Compact mode for inline display (e.g., in Inbox header)
    if (compact) {
        return (
            <Flex align="center" gap={2}>
                <Text fontSize="sm" fontWeight="medium">Base Currency:</Text>
                <select
                    value={baseCurrency}
                    onChange={(e) => {
                        const symbol = e.target.value;
                        const asset = fiatAssets.find(a => a.symbol === symbol);
                        handleCurrencyChange(symbol);
                        localStorage.setItem(BASE_CURRENCY_KEY, symbol);
                        if (asset?.asset_id) {
                            localStorage.setItem(BASE_CURRENCY_ID_KEY, String(asset.asset_id));
                        }
                        onCurrencyChange?.(symbol);
                        // Dispatch storage event for other components
                        window.dispatchEvent(new Event('storage'));
                    }}
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
            </Flex>
        );
    }

    // Full mode for Setup tab
    return (
        <Box>
            <Heading size="md" mb={4}>� P&L Settings</Heading>

            <Card.Root mb={4}>
                <Card.Body>
                    <Text mb={4}>
                        Select your base currency for P&L calculations and reporting.
                        This is typically your local fiat currency (e.g., EUR, USD).
                    </Text>

                    <Flex gap={4} align="flex-end" flexWrap="wrap">
                        <Box flex="1" minW="200px">
                            <Text fontSize="sm" mb={2} fontWeight="medium">
                                Base Currency for P&L
                            </Text>
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
                        </Box>

                        <Button
                            colorPalette="blue"
                            onClick={handleSave}
                        >
                            Save
                        </Button>

                        {saved && (
                            <Text color="green.500" fontSize="sm">
                                ✓ Saved!
                            </Text>
                        )}
                    </Flex>

                    <Box mt={6} p={4} bg="blue.50" borderRadius="md">
                        <Text fontWeight="bold" mb={2}>ℹ️ Why is base currency important?</Text>
                        <Text fontSize="sm" color="gray.700">
                            • <strong>P&L Calculation</strong>: All gains and losses will be calculated
                            and reported in your base currency.
                        </Text>
                        <Text fontSize="sm" color="gray.700" mt={1}>
                            • <strong>Cost Basis</strong>: Asset acquisition costs are tracked in your base currency.
                        </Text>
                        <Text fontSize="sm" color="gray.700" mt={1}>
                            • <strong>Note</strong>: Taxability is determined by transaction type and taxable events,
                            not by the base currency selection.
                        </Text>
                    </Box>
                </Card.Body>
            </Card.Root>

            <Card.Root>
                <Card.Body>
                    <Heading size="sm" mb={3}>Current Configuration</Heading>
                    <Flex gap={6}>
                        <Box>
                            <Text fontSize="xs" color="gray.500">Selected Base Currency</Text>
                            <Text fontSize="2xl" fontWeight="bold" color="blue.600">
                                {baseCurrency}
                            </Text>
                        </Box>
                        <Box>
                            <Text fontSize="xs" color="gray.500">Status</Text>
                            <Text fontSize="lg" color="green.500" fontWeight="bold">
                                ✓ Configured
                            </Text>
                        </Box>
                    </Flex>
                </Card.Body>
            </Card.Root>
        </Box>
    );
};

// Hook to get and set the current base currency from anywhere in the app
export const useBaseCurrency = (): {
    baseCurrency: string;
    baseCurrencyId: number | null;
    setBaseCurrency: (currency: string, id?: number) => void;
} => {
    const [baseCurrency, setBaseCurrencyState] = useState<string>(() => {
        return localStorage.getItem(BASE_CURRENCY_KEY) || 'EUR';
    });
    const [baseCurrencyId, setBaseCurrencyIdState] = useState<number | null>(() => {
        const stored = localStorage.getItem(BASE_CURRENCY_ID_KEY);
        return stored ? parseInt(stored, 10) : null;
    });

    useEffect(() => {
        const handleStorageChange = () => {
            setBaseCurrencyState(localStorage.getItem(BASE_CURRENCY_KEY) || 'EUR');
            const storedId = localStorage.getItem(BASE_CURRENCY_ID_KEY);
            setBaseCurrencyIdState(storedId ? parseInt(storedId, 10) : null);
        };

        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, []);

    const setBaseCurrency = (currency: string, id?: number) => {
        localStorage.setItem(BASE_CURRENCY_KEY, currency);
        setBaseCurrencyState(currency);
        if (id !== undefined) {
            localStorage.setItem(BASE_CURRENCY_ID_KEY, String(id));
            setBaseCurrencyIdState(id);
        }
        // Dispatch storage event for other components
        window.dispatchEvent(new Event('storage'));
    };

    return { baseCurrency, baseCurrencyId, setBaseCurrency };
};

export default BaseCurrencySelector;
