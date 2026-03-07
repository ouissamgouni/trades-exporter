/**
 * PnLDefaultsEditor
 * 
 * Allows editing default P&L calculation configuration in the Setup tab.
 * These defaults are used when the background refresh recalculates P&L.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
    Box,
    Button,
    Flex,
    Heading,
    HStack,
    Text,
    VStack,
    Badge,
    Spinner,
} from '@chakra-ui/react';
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
            <Flex justify="center" align="center" minH="200px">
                <Spinner size="lg" />
            </Flex>
        );
    }

    if (!defaults) {
        return <Text color="red.500">Failed to load P&L defaults</Text>;
    }

    return (
        <VStack align="stretch" gap={6}>
            <Flex justify="space-between" align="center">
                <Box>
                    <Heading size="md">P&L Calculation Defaults</Heading>
                    <Text fontSize="sm" color="gray.500" mt={1}>
                        These settings are used when refreshing P&L calculations. Custom calculations can override these.
                    </Text>
                </Box>
                {hasChanges && (
                    <HStack>
                        <Button size="sm" variant="ghost" onClick={handleReset}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            colorPalette="blue"
                            onClick={handleSave}
                            loading={isSaving}
                        >
                            Save Defaults
                        </Button>
                    </HStack>
                )}
            </Flex>

            {/* Base Currency */}
            <Box>
                <Text fontWeight="semibold" fontSize="sm" mb={2}>Base Currency</Text>
                <Text fontSize="xs" color="gray.500" mb={2}>
                    All P&L gains/losses and cost basis are reported in this currency.
                </Text>
                <HStack gap={2} flexWrap="wrap">
                    {fiatAssets.length > 0 ? (
                        fiatAssets.map((asset) => (
                            <Box
                                key={asset.asset_id}
                                px={4}
                                py={2}
                                borderRadius="md"
                                cursor="pointer"
                                borderWidth={1}
                                borderColor={defaults.base_currency === asset.symbol ? 'blue.400' : 'gray.200'}
                                bg={defaults.base_currency === asset.symbol ? 'blue.50' : 'white'}
                                _hover={{ borderColor: 'blue.300' }}
                                onClick={() => updateField('base_currency', asset.symbol)}
                            >
                                <Text fontWeight="semibold" fontSize="sm">{asset.symbol}</Text>
                                {asset.label && <Text fontSize="xs" color="gray.500">{asset.label}</Text>}
                            </Box>
                        ))
                    ) : (
                        ['EUR', 'USD', 'GBP', 'CHF'].map((sym) => (
                            <Box
                                key={sym}
                                px={4}
                                py={2}
                                borderRadius="md"
                                cursor="pointer"
                                borderWidth={1}
                                borderColor={defaults.base_currency === sym ? 'blue.400' : 'gray.200'}
                                bg={defaults.base_currency === sym ? 'blue.50' : 'white'}
                                _hover={{ borderColor: 'blue.300' }}
                                onClick={() => updateField('base_currency', sym)}
                            >
                                <Text fontWeight="semibold" fontSize="sm">{sym}</Text>
                            </Box>
                        ))
                    )}
                </HStack>
            </Box>

            {/* Cost Method */}
            <Box>
                <Text fontWeight="semibold" fontSize="sm" mb={2}>Cost Method</Text>
                <HStack gap={2}>
                    {LOT_METHODS.map((method) => (
                        <Box
                            key={method.value}
                            px={4}
                            py={2}
                            borderRadius="md"
                            cursor="pointer"
                            borderWidth={1}
                            borderColor={defaults.pnl_lot_method === method.value ? 'blue.400' : 'gray.200'}
                            bg={defaults.pnl_lot_method === method.value ? 'blue.50' : 'white'}
                            _hover={{ borderColor: 'blue.300' }}
                            onClick={() => updateField('pnl_lot_method', method.value)}
                        >
                            <Text fontWeight="semibold" fontSize="sm">{method.label}</Text>
                            <Text fontSize="xs" color="gray.500">{method.description}</Text>
                        </Box>
                    ))}
                </HStack>
            </Box>

            {/* Lot Mode */}
            <Box>
                <Text fontWeight="semibold" fontSize="sm" mb={2}>Lot Mode</Text>
                <HStack gap={2}>
                    {LOT_MODES.map((mode) => (
                        <Box
                            key={mode.value}
                            px={4}
                            py={2}
                            borderRadius="md"
                            cursor="pointer"
                            borderWidth={1}
                            borderColor={defaults.pnl_lot_mode === mode.value ? 'blue.400' : 'gray.200'}
                            bg={defaults.pnl_lot_mode === mode.value ? 'blue.50' : 'white'}
                            _hover={{ borderColor: 'blue.300' }}
                            onClick={() => updateField('pnl_lot_mode', mode.value)}
                        >
                            <Text fontWeight="semibold" fontSize="sm">{mode.label}</Text>
                            <Text fontSize="xs" color="gray.500">{mode.description}</Text>
                        </Box>
                    ))}
                </HStack>
            </Box>

            {/* Boolean Options */}
            <Box>
                <Text fontWeight="semibold" fontSize="sm" mb={3}>Options</Text>
                <VStack align="stretch" gap={3}>
                    {[
                        { field: 'pnl_allow_negative_balances' as const, label: 'Allow Negative Balances', description: 'Continue calculation even if asset balance goes negative' },
                        { field: 'pnl_crypto_swap_taxable' as const, label: 'Crypto Swaps Taxable', description: 'Treat crypto-to-crypto swaps as taxable events' },
                        { field: 'pnl_fee_taxable' as const, label: 'Fees Taxable', description: 'Treat fee disposals as taxable events' },
                        { field: 'pnl_use_price_fallback' as const, label: 'Use Price Fallback', description: 'Fall back to latest known price when fetch fails' },
                    ].map(({ field, label, description }) => (
                        <Flex
                            key={field}
                            justify="space-between"
                            align="center"
                            p={3}
                            borderWidth={1}
                            borderRadius="md"
                            borderColor="gray.200"
                        >
                            <Box>
                                <Text fontSize="sm" fontWeight="medium">{label}</Text>
                                <Text fontSize="xs" color="gray.500">{description}</Text>
                            </Box>
                            <Box
                                px={3}
                                py={1}
                                borderRadius="full"
                                cursor="pointer"
                                bg={defaults[field] ? 'blue.500' : 'gray.200'}
                                color={defaults[field] ? 'white' : 'gray.600'}
                                fontSize="xs"
                                fontWeight="semibold"
                                onClick={() => updateField(field, !defaults[field])}
                                _hover={{ opacity: 0.8 }}
                                transition="all 0.2s"
                            >
                                {defaults[field] ? 'ON' : 'OFF'}
                            </Box>
                        </Flex>
                    ))}
                </VStack>
            </Box>

            {/* Numeric Options */}
            <Flex gap={6} flexWrap="wrap">
                <Box>
                    <Text fontWeight="semibold" fontSize="sm" mb={2}>Residual Tolerance (%)</Text>
                    <HStack gap={1}>
                        {[0, 0.01, 0.05, 0.1, 0.5, 1.0].map((val) => (
                            <Box
                                key={val}
                                px={3}
                                py={1}
                                borderRadius="md"
                                cursor="pointer"
                                borderWidth={1}
                                borderColor={defaults.pnl_residual_tolerance_pct === val ? 'blue.400' : 'gray.200'}
                                bg={defaults.pnl_residual_tolerance_pct === val ? 'blue.50' : 'white'}
                                fontSize="xs"
                                fontWeight="medium"
                                _hover={{ borderColor: 'blue.300' }}
                                onClick={() => updateField('pnl_residual_tolerance_pct', val)}
                            >
                                {val === 0 ? 'OFF' : `${val}%`}
                            </Box>
                        ))}
                    </HStack>
                </Box>

                <Box>
                    <Text fontWeight="semibold" fontSize="sm" mb={2}>Price Staleness Window (days)</Text>
                    <HStack gap={1}>
                        {[1, 3, 7, 14, 30].map((val) => (
                            <Box
                                key={val}
                                px={3}
                                py={1}
                                borderRadius="md"
                                cursor="pointer"
                                borderWidth={1}
                                borderColor={defaults.pnl_price_staleness_days === val ? 'blue.400' : 'gray.200'}
                                bg={defaults.pnl_price_staleness_days === val ? 'blue.50' : 'white'}
                                fontSize="xs"
                                fontWeight="medium"
                                _hover={{ borderColor: 'blue.300' }}
                                onClick={() => updateField('pnl_price_staleness_days', val)}
                            >
                                {val}d
                            </Box>
                        ))}
                    </HStack>
                </Box>
            </Flex>

            {/* Current Status Summary */}
            <Box p={3} bg="gray.50" borderRadius="md">
                <Text fontSize="xs" color="gray.500">
                    Base currency: {defaults.base_currency} ·
                    Current defaults: {defaults.pnl_lot_method} / {defaults.pnl_lot_mode} ·
                    Tolerance: {defaults.pnl_residual_tolerance_pct === 0 ? 'OFF' : `${defaults.pnl_residual_tolerance_pct}%`} ·
                    Negative balances: {defaults.pnl_allow_negative_balances ? 'allowed' : 'blocked'} ·
                    Swaps taxable: {defaults.pnl_crypto_swap_taxable ? 'yes' : 'no'} ·
                    Fees taxable: {defaults.pnl_fee_taxable ? 'yes' : 'no'}
                </Text>
            </Box>
        </VStack>
    );
};
