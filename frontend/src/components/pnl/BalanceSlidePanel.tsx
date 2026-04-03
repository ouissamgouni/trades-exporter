/**
 * BalanceSlidePanel — Slide panel showing per-asset live vs P&L balance comparison.
 *
 * Displays a searchable table of all assets with expected qty, live qty, delta, and status.
 * Includes a tolerance slider to control the mismatch threshold.
 * Assets are shown per-account with expandable drill-down (inspired by BalanceDrawer).
 * Mapped assets use AssetBadge (with info icon), unmapped use a package icon.
 */

import React, { useMemo, useState } from 'react';
import { Badge, Box, Flex, Input, Slider, Text } from '@chakra-ui/react';
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { LuPackage } from 'react-icons/lu';
import { SlidePanel } from './SlidePanel';
import { computeDelta, deltaColor, formatPct } from './deltaUtils';
import { AssetBadge } from '../AssetBadge';
import { AccountBadge } from '../AccountBadge';
import { useAssets } from '../../hooks/useAssets';
import type { UnmappedLiveAsset } from './types';
import type { AccountBalance, AssetRef } from '../../types';

// ── Types ──

interface AccountHolding {
    accountName: string;
    connectorType: string;
    chain: string | null;
    qty: number;
}

interface BalanceRow {
    symbol: string;
    pnlQty: number;
    liveQty: number | undefined;
    delta: number | null;
    pct: number | null;
    matched: boolean;
    covered: boolean;
    accounts: AccountHolding[];
}

interface BalanceSlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    /** P&L assets: symbol → expected qty */
    pnlAssets: { symbol: string; quantity: number }[];
    /** Raw per-account live balance data */
    liveAccountBalances: AccountBalance[];
    /** Current tolerance threshold (%) */
    deltaThreshold: number;
    /** Callback to update tolerance */
    onDeltaThresholdChange: (value: number) => void;
    /** Unmapped live assets (in live balance but no P&L record) */
    unmappedLiveAssets?: UnmappedLiveAsset[];
}

type StatusFilter = 'all' | 'matched' | 'mismatch' | 'uncovered' | 'unmapped';

// ── Helpers ──

function formatQty(qty: number): string {
    if (Math.abs(qty) >= 1e6) return qty.toExponential(2);
    if (Math.abs(qty) >= 1000) return qty.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (Math.abs(qty) >= 1) return qty.toFixed(4);
    return qty.toPrecision(4);
}

/** Build aggregated liveBalanceMap + per-account holdings from raw AccountBalance[] */
function buildLiveData(accountBalances: AccountBalance[]) {
    const liveMap = new Map<string, number>();
    const holdingsMap = new Map<string, AccountHolding[]>();

    for (const ab of accountBalances) {
        for (const cb of ab.connector_balances) {
            for (const entry of cb.entries) {
                const sym = entry.asset_symbol.toUpperCase();
                const amount = parseFloat(entry.total) || 0;
                liveMap.set(sym, (liveMap.get(sym) ?? 0) + amount);
                if (!holdingsMap.has(sym)) holdingsMap.set(sym, []);
                holdingsMap.get(sym)!.push({
                    accountName: ab.account_name,
                    connectorType: cb.connector_type,
                    chain: entry.chain ?? cb.chain,
                    qty: amount,
                });
            }
        }
    }
    return { liveMap, holdingsMap };
}

// ── Row sub-component ──

const BalanceRowItem: React.FC<{
    row: BalanceRow;
    deltaThreshold: number;
    assetMap: Map<string, AssetRef>;
}> = ({ row, deltaThreshold, assetMap }) => {
    const [expanded, setExpanded] = useState(false);
    const isMismatch = row.covered && !row.matched && Math.abs(row.pct ?? 0) > deltaThreshold / 100;
    const canExpand = row.accounts.length > 0;

    return (
        <Box>
            <Box
                display="grid"
                gridTemplateColumns="minmax(120px, 1.2fr) 1fr 1fr 70px 50px"
                gap={1}
                px={2}
                py={1}
                borderBottom="1px solid"
                borderColor="gray.100"
                _hover={{ bg: 'gray.50' }}
                cursor={canExpand ? 'pointer' : 'default'}
                onClick={() => canExpand && setExpanded(!expanded)}
            >
                <Flex align="center" gap={1} minW={0}>
                    {canExpand && (
                        <Box color="gray.400" flexShrink={0}>
                            {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        </Box>
                    )}
                    <AssetBadge
                        asset={assetMap.get(row.symbol)}
                        sourceSymbol={row.symbol}
                        size="xs"
                        showWarning={false}
                    />
                </Flex>
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

            {/* Per-account drill-down */}
            {expanded && row.accounts.length > 0 && (
                <Box ml={5} mb={1} borderLeft="2px solid" borderColor="gray.100" pl={2}>
                    {row.accounts.map((h, i) => (
                        <Flex
                            key={`${h.accountName}-${h.connectorType}-${i}`}
                            justify="space-between"
                            align="center"
                            py={0.5}
                            px={1}
                        >
                            <Flex align="center" gap={1} flexWrap="wrap">
                                <AccountBadge accountName={h.accountName} size="xs" />
                                <Badge size="xs" variant="outline" colorPalette="blue" fontSize="2xs">
                                    {h.connectorType}
                                </Badge>
                                {h.chain && (
                                    <Badge size="xs" variant="subtle" colorPalette="gray" fontSize="2xs">
                                        {h.chain}
                                    </Badge>
                                )}
                            </Flex>
                            <Text fontSize="xs" fontFamily="mono" color="gray.600">
                                {formatQty(h.qty)}
                            </Text>
                        </Flex>
                    ))}
                </Box>
            )}
        </Box>
    );
};

// ── Unmapped row sub-component ──

const UnmappedRowItem: React.FC<{
    asset: UnmappedLiveAsset;
}> = ({ asset }) => {
    const [expanded, setExpanded] = useState(false);
    const canExpand = (asset.accounts?.length ?? 0) > 0;

    return (
        <Box>
            <Box
                display="grid"
                gridTemplateColumns="minmax(120px, 1.2fr) 1fr 1fr 70px 50px"
                gap={1}
                px={2}
                py={1}
                borderBottom="1px solid"
                borderColor="purple.100"
                bg="purple.50"
                _hover={{ bg: 'purple.100' }}
                cursor={canExpand ? 'pointer' : 'default'}
                onClick={() => canExpand && setExpanded(!expanded)}
            >
                <Flex align="center" gap={1} minW={0}>
                    {canExpand && (
                        <Box color="purple.400" flexShrink={0}>
                            {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        </Box>
                    )}
                    <Badge size="xs" colorPalette="purple" variant="subtle">
                        <Flex align="center" gap={0.5}>
                            <LuPackage size={10} />
                            <Text truncate>{asset.symbol}</Text>
                        </Flex>
                    </Badge>
                </Flex>
                <Text fontSize="xs" color="gray.400" textAlign="right" fontFamily="mono">
                    —
                </Text>
                <Text fontSize="xs" color="purple.600" textAlign="right" fontFamily="mono">
                    {formatQty(asset.totalQty)}
                </Text>
                <Text fontSize="xs" color="gray.400" textAlign="right" fontFamily="mono">
                    {asset.marketValue != null ? `$${asset.marketValue.toFixed(2)}` : '—'}
                </Text>
                <Flex justify="flex-end">
                    <Badge size="xs" colorPalette="purple" variant="subtle">
                        <LuPackage size={10} />
                    </Badge>
                </Flex>
            </Box>

            {/* Per-account drill-down for unmapped */}
            {expanded && asset.accounts && asset.accounts.length > 0 && (
                <Box ml={5} mb={1} borderLeft="2px solid" borderColor="purple.100" pl={2} bg="purple.50">
                    {asset.accounts.map((h, i) => (
                        <Flex
                            key={`${h.accountName}-${h.connectorType}-${i}`}
                            justify="space-between"
                            align="center"
                            py={0.5}
                            px={1}
                        >
                            <Flex align="center" gap={1} flexWrap="wrap">
                                <AccountBadge accountName={h.accountName} size="xs" />
                                <Badge size="xs" variant="outline" colorPalette="blue" fontSize="2xs">
                                    {h.connectorType}
                                </Badge>
                                {h.chain && (
                                    <Badge size="xs" variant="subtle" colorPalette="gray" fontSize="2xs">
                                        {h.chain}
                                    </Badge>
                                )}
                            </Flex>
                            <Text fontSize="xs" fontFamily="mono" color="purple.600">
                                {formatQty(h.qty)}
                            </Text>
                        </Flex>
                    ))}
                </Box>
            )}
        </Box>
    );
};

// ── Main Component ──

export const BalanceSlidePanel: React.FC<BalanceSlidePanelProps> = ({
    isOpen,
    onClose,
    pnlAssets,
    liveAccountBalances,
    deltaThreshold,
    onDeltaThresholdChange,
    unmappedLiveAssets = [],
}) => {
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<StatusFilter>('all');

    // Asset map for AssetBadge lookups
    const { assets: allDbAssets } = useAssets(isOpen);
    const assetMap = useMemo(() => {
        const map = new Map<string, AssetRef>();
        for (const a of allDbAssets) {
            if (a.symbol) {
                map.set(a.symbol.toUpperCase(), {
                    id: a.asset_id ?? null,
                    symbol: a.symbol,
                    label: a.label ?? null,
                });
            }
        }
        return map;
    }, [allDbAssets]);

    // Build live balance map + per-account holdings from raw account balances
    const { liveMap, holdingsMap } = useMemo(
        () => buildLiveData(liveAccountBalances),
        [liveAccountBalances],
    );

    const rows = useMemo<BalanceRow[]>(() => {
        return pnlAssets.map(a => {
            const sym = a.symbol.toUpperCase();
            const liveQty = liveMap.get(sym);
            const d = computeDelta(a.quantity, liveQty);
            return {
                symbol: sym,
                pnlQty: a.quantity,
                liveQty,
                delta: d?.delta ?? null,
                pct: d?.pct ?? null,
                matched: d?.matched ?? false,
                covered: liveQty !== undefined,
                accounts: holdingsMap.get(sym) ?? [],
            };
        }).sort((a, b) => {
            if (a.covered && !b.covered) return -1;
            if (!a.covered && b.covered) return 1;
            if (a.matched !== b.matched) return a.matched ? 1 : -1;
            return Math.abs(b.pct ?? 0) - Math.abs(a.pct ?? 0);
        });
    }, [pnlAssets, liveMap, holdingsMap]);

    const counts = useMemo(() => {
        let matched = 0, mismatch = 0, uncovered = 0;
        for (const r of rows) {
            if (!r.covered) uncovered++;
            else if (r.matched || Math.abs(r.pct ?? 0) <= deltaThreshold / 100) matched++;
            else mismatch++;
        }
        return { matched, mismatch, uncovered, unmapped: unmappedLiveAssets.length, all: rows.length + unmappedLiveAssets.length };
    }, [rows, deltaThreshold, unmappedLiveAssets]);

    const filtered = useMemo(() => {
        if (filter === 'unmapped') return [];
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

    const filteredUnmapped = useMemo(() => {
        if (filter !== 'all' && filter !== 'unmapped') return [];
        let result = unmappedLiveAssets;
        if (search) {
            const q = search.toUpperCase();
            result = result.filter(u => u.symbol.toUpperCase().includes(q));
        }
        return result;
    }, [unmappedLiveAssets, filter, search]);

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Live Balance Comparison" width="600px">
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
                    ...(counts.unmapped > 0 ? [['unmapped', `Unmapped (${counts.unmapped})`, 'purple']] : []),
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
                        {key === 'unmapped' && <LuPackage size={10} style={{ marginRight: 2 }} />}
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
                gridTemplateColumns="minmax(120px, 1.2fr) 1fr 1fr 70px 50px"
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
                {filtered.length === 0 && filteredUnmapped.length === 0 ? (
                    <Text fontSize="xs" color="gray.400" textAlign="center" py={4}>No assets match filter</Text>
                ) : (
                    <>
                        {filtered.map(row => (
                            <BalanceRowItem
                                key={row.symbol}
                                row={row}
                                deltaThreshold={deltaThreshold}
                                assetMap={assetMap}
                            />
                        ))}

                        {/* Unmapped live assets section */}
                        {filteredUnmapped.length > 0 && filtered.length > 0 && (
                            <Box px={2} py={1.5} bg="purple.50" borderBottom="1px solid" borderColor="purple.100">
                                <Flex align="center" gap={1}>
                                    <LuPackage size={12} color="var(--chakra-colors-purple-600)" />
                                    <Text fontSize="2xs" fontWeight="bold" color="purple.600">
                                        Unmapped — in live balance but no P&L record
                                    </Text>
                                </Flex>
                            </Box>
                        )}
                        {filteredUnmapped.map(u => (
                            <UnmappedRowItem key={u.symbol} asset={u} />
                        ))}
                    </>
                )}
            </Box>
        </SlidePanel>
    );
};
