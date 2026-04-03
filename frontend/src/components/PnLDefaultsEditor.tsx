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
    Switch,
    Text,
    VStack,
    Spinner,
} from '@chakra-ui/react';
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
        <VStack align="stretch" gap={4}>
            {/* Header */}
            <Flex justify="space-between" align="center">
                <Box>
                    <Heading size="md">P&L Calculation Defaults</Heading>
                    <Text fontSize="sm" color="gray.500" mt={1}>
                        These settings are used when refreshing P&L calculations. Custom calculations can override these.
                    </Text>
                </Box>
                {hasChanges && (
                    <HStack>
                        <Button size="sm" variant="ghost" borderRadius={0} onClick={handleReset}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            colorPalette="blue"
                            borderRadius={0}
                            onClick={handleSave}
                            loading={isSaving}
                        >
                            Save Defaults
                        </Button>
                    </HStack>
                )}
            </Flex>

            {/* 3-Column Grid */}
            <Flex borderWidth={1} borderColor="gray.200" borderRadius={0}>
                {/* Column 1 — Core */}
                <Box flex={1} p={4} borderRightWidth={1} borderColor="gray.200">
                    <Text fontSize="xs" fontWeight="bold" color="gray.400" textTransform="uppercase" letterSpacing="wider" mb={4}>Core</Text>

                    {/* Base Currency */}
                    <Box mb={4}>
                        <Text fontSize="xs" color="gray.500" mb={1.5}>Base Currency</Text>
                        <HStack gap={0}>
                            {fiatAssets.length > 0 ? (
                                fiatAssets.map((asset) => (
                                    <Tooltip key={asset.asset_id} content={asset.label || asset.symbol}>
                                        <Box
                                            px={3}
                                            py={1.5}
                                            cursor="pointer"
                                            borderRadius={0}
                                            bg={defaults.base_currency === asset.symbol ? 'gray.800' : 'gray.100'}
                                            color={defaults.base_currency === asset.symbol ? 'white' : 'gray.600'}
                                            _hover={{ bg: defaults.base_currency === asset.symbol ? 'gray.800' : 'gray.200' }}
                                            onClick={() => updateField('base_currency', asset.symbol)}
                                            transition="all 0.15s"
                                        >
                                            <Text fontWeight="semibold" fontSize="xs">{asset.symbol}</Text>
                                        </Box>
                                    </Tooltip>
                                ))
                            ) : (
                                ['EUR', 'USD', 'GBP', 'CHF'].map((sym) => (
                                    <Box
                                        key={sym}
                                        px={3}
                                        py={1.5}
                                        cursor="pointer"
                                        borderRadius={0}
                                        bg={defaults.base_currency === sym ? 'gray.800' : 'gray.100'}
                                        color={defaults.base_currency === sym ? 'white' : 'gray.600'}
                                        _hover={{ bg: defaults.base_currency === sym ? 'gray.800' : 'gray.200' }}
                                        onClick={() => updateField('base_currency', sym)}
                                        transition="all 0.15s"
                                    >
                                        <Text fontWeight="semibold" fontSize="xs">{sym}</Text>
                                    </Box>
                                ))
                            )}
                        </HStack>
                    </Box>

                    {/* Cost Method */}
                    <Box mb={4}>
                        <Text fontSize="xs" color="gray.500" mb={1.5}>Cost Method</Text>
                        <HStack gap={0}>
                            {LOT_METHODS.map((method) => (
                                <Tooltip key={method.value} content={method.description}>
                                    <Box
                                        px={3}
                                        py={1.5}
                                        cursor="pointer"
                                        borderRadius={0}
                                        bg={defaults.pnl_lot_method === method.value ? 'gray.800' : 'gray.100'}
                                        color={defaults.pnl_lot_method === method.value ? 'white' : 'gray.600'}
                                        _hover={{ bg: defaults.pnl_lot_method === method.value ? 'gray.800' : 'gray.200' }}
                                        onClick={() => updateField('pnl_lot_method', method.value)}
                                        transition="all 0.15s"
                                    >
                                        <Text fontWeight="semibold" fontSize="xs">{method.label}</Text>
                                    </Box>
                                </Tooltip>
                            ))}
                        </HStack>
                    </Box>

                    {/* Lot Mode */}
                    <Box>
                        <Text fontSize="xs" color="gray.500" mb={1.5}>Lot Mode</Text>
                        <HStack gap={0}>
                            {LOT_MODES.map((mode) => (
                                <Tooltip key={mode.value} content={mode.description}>
                                    <Box
                                        px={3}
                                        py={1.5}
                                        cursor="pointer"
                                        borderRadius={0}
                                        bg={defaults.pnl_lot_mode === mode.value ? 'gray.800' : 'gray.100'}
                                        color={defaults.pnl_lot_mode === mode.value ? 'white' : 'gray.600'}
                                        _hover={{ bg: defaults.pnl_lot_mode === mode.value ? 'gray.800' : 'gray.200' }}
                                        onClick={() => updateField('pnl_lot_mode', mode.value)}
                                        transition="all 0.15s"
                                    >
                                        <Text fontWeight="semibold" fontSize="xs">{mode.label}</Text>
                                    </Box>
                                </Tooltip>
                            ))}
                        </HStack>
                    </Box>
                </Box>

                {/* Column 2 — Tax & Compliance */}
                <Box flex={1} p={4} borderRightWidth={1} borderColor="gray.200">
                    <Text fontSize="xs" fontWeight="bold" color="gray.400" textTransform="uppercase" letterSpacing="wider" mb={4}>Tax & Compliance</Text>

                    {/* Toggle rows */}
                    <VStack align="stretch" gap={2.5}>
                        {[
                            { field: 'pnl_allow_negative_balances' as const, label: 'Negative Balances', description: 'Continue calculation even if asset balance goes negative' },
                            { field: 'pnl_crypto_swap_taxable' as const, label: 'Swaps Taxable', description: 'Treat crypto-to-crypto swaps as taxable events' },
                            { field: 'pnl_fee_taxable' as const, label: 'Fees Taxable', description: 'Treat fee disposals as taxable events' },
                        ].map(({ field, label, description }) => (
                            <Tooltip key={field} content={description}>
                                <Flex justify="space-between" align="center">
                                    <Text fontSize="sm" color="gray.700">{label}</Text>
                                    <Switch.Root
                                        size="sm"
                                        checked={defaults[field]}
                                        onCheckedChange={() => updateField(field, !defaults[field])}
                                    >
                                        <Switch.HiddenInput />
                                        <Switch.Control borderRadius={0} />
                                    </Switch.Root>
                                </Flex>
                            </Tooltip>
                        ))}
                    </VStack>
                </Box>

                {/* Column 3 — Advanced */}
                <Box flex={1} p={4}>
                    <Text fontSize="xs" fontWeight="bold" color="gray.400" textTransform="uppercase" letterSpacing="wider" mb={4}>Advanced</Text>

                    {/* Price Fallback */}
                    <Tooltip content="Fall back to latest known price when fetch fails">
                        <Flex justify="space-between" align="center" mb={4}>
                            <Text fontSize="sm" color="gray.700">Price Fallback</Text>
                            <Switch.Root
                                size="sm"
                                checked={defaults.pnl_use_price_fallback}
                                onCheckedChange={() => updateField('pnl_use_price_fallback', !defaults.pnl_use_price_fallback)}
                            >
                                <Switch.HiddenInput />
                                <Switch.Control borderRadius={0} />
                            </Switch.Root>
                        </Flex>
                    </Tooltip>

                    {/* Residual Tolerance */}
                    <Box mb={4}>
                        <Text fontSize="xs" color="gray.500" mb={1.5}>Residual Tolerance</Text>
                        <HStack gap={0}>
                            {[0, 0.01, 0.05, 0.1, 0.5, 1.0].map((val) => (
                                <Box
                                    key={val}
                                    px={2.5}
                                    py={1}
                                    cursor="pointer"
                                    borderRadius={0}
                                    bg={defaults.pnl_residual_tolerance_pct === val ? 'gray.800' : 'gray.100'}
                                    color={defaults.pnl_residual_tolerance_pct === val ? 'white' : 'gray.600'}
                                    fontSize="xs"
                                    fontWeight="medium"
                                    _hover={{ bg: defaults.pnl_residual_tolerance_pct === val ? 'gray.800' : 'gray.200' }}
                                    onClick={() => updateField('pnl_residual_tolerance_pct', val)}
                                    transition="all 0.15s"
                                >
                                    {val === 0 ? 'OFF' : `${val}%`}
                                </Box>
                            ))}
                        </HStack>
                    </Box>

                    {/* Price Staleness */}
                    <Box>
                        <Text fontSize="xs" color="gray.500" mb={1.5}>Staleness Window</Text>
                        <HStack gap={0}>
                            {[1, 3, 7, 14, 30].map((val) => (
                                <Box
                                    key={val}
                                    px={2.5}
                                    py={1}
                                    cursor="pointer"
                                    borderRadius={0}
                                    bg={defaults.pnl_price_staleness_days === val ? 'gray.800' : 'gray.100'}
                                    color={defaults.pnl_price_staleness_days === val ? 'white' : 'gray.600'}
                                    fontSize="xs"
                                    fontWeight="medium"
                                    _hover={{ bg: defaults.pnl_price_staleness_days === val ? 'gray.800' : 'gray.200' }}
                                    onClick={() => updateField('pnl_price_staleness_days', val)}
                                    transition="all 0.15s"
                                >
                                    {val}d
                                </Box>
                            ))}
                        </HStack>
                    </Box>
                </Box>
            </Flex>

            {/* Status Summary */}
            <Box px={3} py={2} bg="gray.50" borderRadius={0}>
                <Text fontSize="xs" color="gray.500">
                    {defaults.base_currency} · {defaults.pnl_lot_method} / {defaults.pnl_lot_mode === 'LOT_TRAVEL' ? 'Lot Travel' : 'Mega Wallet'} ·
                    {' '}Tolerance: {defaults.pnl_residual_tolerance_pct === 0 ? 'OFF' : `${defaults.pnl_residual_tolerance_pct}%`} ·
                    {' '}Neg. balances: {defaults.pnl_allow_negative_balances ? 'yes' : 'no'} ·
                    {' '}Swaps: {defaults.pnl_crypto_swap_taxable ? 'taxable' : 'no'} ·
                    {' '}Fees: {defaults.pnl_fee_taxable ? 'taxable' : 'no'}
                </Text>
            </Box>
        </VStack>
    );
};
