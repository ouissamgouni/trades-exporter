/**
 * BalanceSlidePanel — Slide panel showing per-asset live vs P&L balance comparison.
 *
 * Displays a searchable table of all assets with expected qty, live qty, delta, and status.
 * Includes a tolerance slider to control the mismatch threshold.
 */

import React, { useMemo, useState } from 'react';
import { Badge, Box, Flex, Input, Slider, Text } from '@chakra-ui/react';
import { SlidePanel } from './SlidePanel';
import { computeDelta, deltaColor, formatPct } from './deltaUtils';

interface BalanceRow {
    symbol: string;
    pnlQty: number;
    liveQty: number | undefined;
    delta: number | null;
    pct: number | null;
    matched: boolean;
    covered: boolean;
}

interface BalanceSlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    /** P&L assets: symbol → expected qty */
    pnlAssets: { symbol: string; quantity: number }[];
    /** Live balances: symbol → live qty */
    liveBalanceMap: Map<string, number>;
    /** Current tolerance threshold (%) */
    deltaThreshold: number;
    /** Callback to update tolerance */
    onDeltaThresholdChange: (value: number) => void;
}

type StatusFilter = 'all' | 'matched' | 'mismatch' | 'uncovered';

export const BalanceSlidePanel: React.FC<BalanceSlidePanelProps> = ({
    isOpen,
    onClose,
    pnlAssets,
    liveBalanceMap,
    deltaThreshold,
    onDeltaThresholdChange,
}) => {
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<StatusFilter>('all');

    const rows = useMemo<BalanceRow[]>(() => {
        return pnlAssets.map(a => {
            const sym = a.symbol.toUpperCase();
            const liveQty = liveBalanceMap.get(sym);
            const d = computeDelta(a.quantity, liveQty);
            return {
                symbol: sym,
                pnlQty: a.quantity,
                liveQty,
                delta: d?.delta ?? null,
                pct: d?.pct ?? null,
                matched: d?.matched ?? false,
                covered: liveQty !== undefined,
            };
        }).sort((a, b) => {
            // Mismatches first (desc by |pct|), then matched, then uncovered
            if (a.covered && !b.covered) return -1;
            if (!a.covered && b.covered) return 1;
            if (a.matched !== b.matched) return a.matched ? 1 : -1;
            return Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0);
        });
    }, [pnlAssets, liveBalanceMap]);

    const counts = useMemo(() => {
        let matched = 0, mismatch = 0, uncovered = 0;
        for (const r of rows) {
            if (!r.covered) uncovered++;
            else if (r.matched || Math.abs(r.pct ?? 0) <= deltaThreshold / 100) matched++;
            else mismatch++;
        }
        return { matched, mismatch, uncovered, all: rows.length };
    }, [rows, deltaThreshold]);

    const filtered = useMemo(() => {
        let result = rows;
        if (filter === 'matched') result = result.filter(r => r.covered && (r.matched || Math.abs(r.pct ?? 0) <= deltaThreshold / 100));
        else if (filter === 'mismatch') result = result.filter(r => r.covered && !r.matched && Math.abs(r.pct ?? 0) > deltaThreshold / 100);
        else if (filter === 'uncovered') result = result.filter(r => !r.covered);
        if (search) {
            const q = search.toUpperCase();
            result = result.filter(r => r.symbol.includes(q));
        }
        return result;
    }, [rows, filter, search, deltaThreshold]);

    const formatQty = (qty: number) => {
        if (Math.abs(qty) >= 1e6) return qty.toExponential(2);
        if (Math.abs(qty) >= 1000) return qty.toLocaleString(undefined, { maximumFractionDigits: 2 });
        if (Math.abs(qty) >= 1) return qty.toFixed(4);
        return qty.toPrecision(4);
    };

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Live Balance Comparison" width="560px">
            {/* Tolerance slider */}
            <Box mb={3} p={3} bg="gray.50" borderRadius="md">
                <Flex justify="space-between" align="center" mb={1}>
                    <Text fontSize="xs" fontWeight="semibold" color="gray.600">Tolerance threshold</Text>
                    <Text fontSize="xs" color="gray.500" fontWeight="medium">{deltaThreshold}%</Text>
                </Flex>
                <Slider.Root
                    size="sm"
                    min={0}
                    max={50}
                    step={1}
                    value={[deltaThreshold]}
                    onValueChange={(d) => onDeltaThresholdChange(d.value[0])}
                >
                    <Slider.Control>
                        <Slider.Track><Slider.Range /></Slider.Track>
                        <Slider.Thumb index={0} />
                    </Slider.Control>
                </Slider.Root>
            </Box>

            {/* Status filter badges */}
            <Flex gap={1} mb={2} flexWrap="wrap">
                {([
                    ['all', `All (${counts.all})`, 'gray'],
                    ['matched', `Matched (${counts.matched})`, 'green'],
                    ['mismatch', `Mismatch (${counts.mismatch})`, 'orange'],
                    ['uncovered', `No data (${counts.uncovered})`, 'gray'],
                ] as [StatusFilter, string, string][]).map(([key, label, color]) => (
                    <Badge
                        key={key}
                        cursor="pointer"
                        variant={filter === key ? 'solid' : 'outline'}
                        colorPalette={filter === key ? color : 'gray'}
                        size="xs"
                        px={1.5}
                        onClick={() => setFilter(key)}
                    >
                        {label}
                    </Badge>
                ))}
            </Flex>

            {/* Search */}
            <Input
                placeholder="Search asset..."
                size="sm"
                mb={2}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
            />

            {/* Table header */}
            <Box
                display="grid"
                gridTemplateColumns="80px 1fr 1fr 80px 60px"
                gap={1}
                px={2}
                py={1}
                bg="gray.100"
                borderRadius="md"
                mb={1}
            >
                <Text fontSize="2xs" fontWeight="bold" color="gray.500">Asset</Text>
                <Text fontSize="2xs" fontWeight="bold" color="gray.500" textAlign="right">P&L Qty</Text>
                <Text fontSize="2xs" fontWeight="bold" color="gray.500" textAlign="right">Live Qty</Text>
                <Text fontSize="2xs" fontWeight="bold" color="gray.500" textAlign="right">Delta</Text>
                <Text fontSize="2xs" fontWeight="bold" color="gray.500" textAlign="right">Status</Text>
            </Box>

            {/* Table rows */}
            <Box maxH="calc(100vh - 340px)" overflowY="auto">
                {filtered.length === 0 ? (
                    <Text fontSize="xs" color="gray.400" textAlign="center" py={4}>No assets match filter</Text>
                ) : (
                    filtered.map(row => {
                        const isMismatch = row.covered && !row.matched && Math.abs(row.pct ?? 0) > deltaThreshold / 100;
                        return (
                            <Box
                                key={row.symbol}
                                display="grid"
                                gridTemplateColumns="80px 1fr 1fr 80px 60px"
                                gap={1}
                                px={2}
                                py={1}
                                borderBottom="1px solid"
                                borderColor="gray.100"
                                _hover={{ bg: 'gray.50' }}
                            >
                                <Text fontSize="xs" fontWeight="semibold" color="gray.700" truncate>
                                    {row.symbol}
                                </Text>
                                <Text fontSize="xs" color="gray.600" textAlign="right" fontFamily="mono">
                                    {formatQty(row.pnlQty)}
                                </Text>
                                <Text fontSize="xs" color={row.covered ? 'gray.600' : 'gray.400'} textAlign="right" fontFamily="mono">
                                    {row.covered ? formatQty(row.liveQty!) : '—'}
                                </Text>
                                <Text
                                    fontSize="xs"
                                    textAlign="right"
                                    fontFamily="mono"
                                    color={row.pct != null ? deltaColor(row.pct) : 'gray.400'}
                                >
                                    {row.pct != null ? formatPct(row.pct) : '—'}
                                </Text>
                                <Flex justify="flex-end">
                                    {!row.covered ? (
                                        <Badge size="xs" colorPalette="gray">N/A</Badge>
                                    ) : isMismatch ? (
                                        <Badge size="xs" colorPalette="orange">Δ</Badge>
                                    ) : (
                                        <Badge size="xs" colorPalette="green">✓</Badge>
                                    )}
                                </Flex>
                            </Box>
                        );
                    })
                )}
            </Box>
        </SlidePanel>
    );
};
