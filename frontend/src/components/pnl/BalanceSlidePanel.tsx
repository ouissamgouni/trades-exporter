/**
 * BalanceSlidePanel — Slide panel showing per-asset live vs P&L balance comparison.
 *
 * Displays a searchable table of all assets with expected qty, live qty, delta, and status.
 * Includes a tolerance slider to control the mismatch threshold.
 * Assets are shown per-account with expandable drill-down (inspired by BalanceDrawer).
 * Mapped assets use AssetBadge (with info icon), unmapped use an unlinked icon.
 */

import React, { useMemo, useState } from 'react';
import { Badge, BadgeColorScheme, Input } from '../ui/primitives';
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { LuLink2Off } from 'react-icons/lu';
import { SlidePanel } from './SlidePanel';
import { computeDelta, deltaColor, formatPct } from './deltaUtils';
import { AssetBadge } from '../AssetBadge';
import { AccountBadge } from '../AccountBadge';
import { useAssets } from '../../hooks/useAssets';
import { EntityInfoButton } from '../EntityInfoButton';
import type { UnmappedLiveAsset } from './types';
import { liveEntryKey, type AccountBalance, type AssetRef } from '../../types';

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
    const assetIdMap = new Map<string, number>();

    for (const ab of accountBalances) {
        for (const cb of ab.connector_balances) {
            for (const entry of cb.entries) {
                const sym = liveEntryKey(entry);
                const amount = parseFloat(entry.total) || 0;
                if (entry.asset_id != null && !assetIdMap.has(sym)) assetIdMap.set(sym, entry.asset_id);
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
    return { liveMap, holdingsMap, assetIdMap };
}

// ── Row sub-component ──

const BalanceRowItem: React.FC<{
    row: BalanceRow;
    deltaThreshold: number;
    assetMap: Map<string, AssetRef>;
    assetIdMap: Map<string, number>;
}> = ({ row, deltaThreshold, assetMap, assetIdMap }) => {
    const [expanded, setExpanded] = useState(false);
    const isMismatch = row.covered && !row.matched && Math.abs(row.pct ?? 0) > deltaThreshold / 100;
    const canExpand = row.accounts.length > 0;

    return (
        <div>
            <div
                className="grid grid-cols-[minmax(120px,1.2fr)_1fr_1fr_70px_50px] gap-1 border-b border-gray-100 px-2 py-1 hover:bg-gray-50"
                style={{ cursor: canExpand ? 'pointer' : 'default' }}
                onClick={() => canExpand && setExpanded(!expanded)}
            >
                <div className="flex min-w-0 items-center gap-1">
                    {canExpand && (
                        <span className="shrink-0 text-gray-400">
                            {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        </span>
                    )}
                    <AssetBadge
                        asset={assetMap.get(row.symbol)}
                        sourceSymbol={row.symbol}
                        size="xs"
                        showWarning={false}
                        hideInfoIcon
                    />
                    <EntityInfoButton
                        kind="asset"
                        id={assetMap.get(row.symbol)?.id ?? assetIdMap.get(row.symbol)}
                        label={row.symbol}
                        size={12}
                    />
                </div>
                <div className="text-right font-mono text-xs text-gray-600">
                    {formatQty(row.pnlQty)}
                </div>
                <div className={`text-right font-mono text-xs ${row.covered ? 'text-gray-600' : 'text-gray-400'}`}>
                    {row.covered ? formatQty(row.liveQty!) : '—'}
                </div>
                <div className={`text-right font-mono text-xs ${row.pct != null ? deltaColor(row.pct) : 'text-gray-400'}`}>
                    {row.pct != null ? formatPct(row.pct) : '—'}
                </div>
                <div className="flex justify-end">
                    {!row.covered ? (
                        <Badge colorScheme="gray">N/A</Badge>
                    ) : isMismatch ? (
                        <Badge colorScheme="orange">Δ</Badge>
                    ) : (
                        <Badge colorScheme="green">✓</Badge>
                    )}
                </div>
            </div>

            {/* Per-account drill-down */}
            {expanded && row.accounts.length > 0 && (
                <div className="mb-1 ml-5 border-l-2 border-gray-100 pl-2">
                    {row.accounts.map((h, i) => (
                        <div
                            key={`${h.accountName}-${h.connectorType}-${i}`}
                            className="flex items-center justify-between px-1 py-0.5"
                        >
                            <div className="flex flex-wrap items-center gap-1">
                                <AccountBadge accountName={h.accountName} size="xs" />
                                <Badge colorScheme="blue" className="text-[10px]">
                                    {h.connectorType}
                                </Badge>
                                {h.chain && (
                                    <Badge colorScheme="gray" className="text-[10px]">
                                        {h.chain}
                                    </Badge>
                                )}
                            </div>
                            <span className="font-mono text-xs text-gray-600">
                                {formatQty(h.qty)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ── Unmapped row sub-component ──

const UnmappedRowItem: React.FC<{
    asset: UnmappedLiveAsset;
}> = ({ asset }) => {
    const [expanded, setExpanded] = useState(false);
    const canExpand = (asset.accounts?.length ?? 0) > 0;

    return (
        <div>
            <div
                className="grid grid-cols-[minmax(120px,1.2fr)_1fr_1fr_70px_50px] gap-1 border-b border-purple-100 bg-purple-50 px-2 py-1 hover:bg-purple-100"
                style={{ cursor: canExpand ? 'pointer' : 'default' }}
                onClick={() => canExpand && setExpanded(!expanded)}
            >
                <div className="flex min-w-0 items-center gap-1">
                    {canExpand && (
                        <span className="shrink-0 text-purple-400">
                            {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        </span>
                    )}
                    <Badge colorScheme="purple" title={asset.contractAddress ?? undefined}>
                        <span className="flex items-center gap-0.5">
                            <LuLink2Off size={10} />
                            <span className="truncate">{asset.symbol}</span>
                        </span>
                    </Badge>
                    {asset.spamReason && (
                        <Badge
                            colorScheme="red"
                            className="shrink-0 text-[10px]"
                            title={asset.spamReason === 'spam_rule' ? 'Token contract blocked as spam' : 'Only seen in rejected transactions'}
                        >
                            spam
                        </Badge>
                    )}
                    <EntityInfoButton kind="asset" id={asset.assetId} label={asset.symbol} size={12} />
                </div>
                <div className="text-right font-mono text-xs text-gray-400">
                    —
                </div>
                <div className="text-right font-mono text-xs text-purple-600">
                    {formatQty(asset.totalQty)}
                </div>
                <div className="text-right font-mono text-xs text-gray-400">
                    {asset.marketValue != null ? `$${asset.marketValue.toFixed(2)}` : '—'}
                </div>
                <div className="flex justify-end">
                    <Badge colorScheme="purple">
                        <LuLink2Off size={10} />
                    </Badge>
                </div>
            </div>

            {/* Per-account drill-down for unmapped */}
            {expanded && asset.accounts && asset.accounts.length > 0 && (
                <div className="mb-1 ml-5 border-l-2 border-purple-100 bg-purple-50 pl-2">
                    {asset.accounts.map((h, i) => (
                        <div
                            key={`${h.accountName}-${h.connectorType}-${i}`}
                            className="flex items-center justify-between px-1 py-0.5"
                        >
                            <div className="flex flex-wrap items-center gap-1">
                                <AccountBadge accountName={h.accountName} size="xs" />
                                <Badge colorScheme="blue" className="text-[10px]">
                                    {h.connectorType}
                                </Badge>
                                {h.chain && (
                                    <Badge colorScheme="gray" className="text-[10px]">
                                        {h.chain}
                                    </Badge>
                                )}
                            </div>
                            <span className="font-mono text-xs text-purple-600">
                                {formatQty(h.qty)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
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
    const { liveMap, holdingsMap, assetIdMap } = useMemo(
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
            <div className="mb-3 rounded-md bg-gray-50 p-3">
                <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-600">Tolerance threshold</span>
                    <span className="text-xs font-medium text-gray-500">{deltaThreshold}%</span>
                </div>
                <input
                    type="range"
                    min={0}
                    max={50}
                    step={1}
                    value={deltaThreshold}
                    onChange={(e) => onDeltaThresholdChange(Number(e.target.value))}
                    className="h-1 w-full accent-blue-500"
                />
            </div>

            {/* Status filter badges */}
            <div className="mb-2 flex flex-wrap gap-1">
                {([
                    ['all', `All (${counts.all})`, 'gray'],
                    ['matched', `Matched (${counts.matched})`, 'green'],
                    ['mismatch', `Mismatch (${counts.mismatch})`, 'orange'],
                    ['uncovered', `No data (${counts.uncovered})`, 'gray'],
                    ...(counts.unmapped > 0 ? [['unmapped', `Unmapped (${counts.unmapped})`, 'purple']] : []),
                ] as [StatusFilter, string, BadgeColorScheme][]).map(([key, label, color]) => (
                    <Badge
                        key={key}
                        className={`cursor-pointer px-1.5 ${filter === key ? 'ring-2 ring-blue-400' : ''}`}
                        colorScheme={filter === key ? color : 'gray'}
                        onClick={() => setFilter(key)}
                    >
                        {key === 'unmapped' && <LuLink2Off size={10} style={{ marginRight: 2 }} />}
                        {label}
                    </Badge>
                ))}
            </div>

            {/* Search */}
            <Input
                placeholder="Search asset..."
                className="mb-2"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
            />

            {/* Table header */}
            <div className="mb-1 grid grid-cols-[minmax(120px,1.2fr)_1fr_1fr_70px_50px] gap-1 rounded-md bg-gray-100 px-2 py-1">
                <span className="text-[10px] font-bold text-gray-500">Asset</span>
                <span className="text-right text-[10px] font-bold text-gray-500">P&L Qty</span>
                <span className="text-right text-[10px] font-bold text-gray-500">Live Qty</span>
                <span className="text-right text-[10px] font-bold text-gray-500">Delta</span>
                <span className="text-right text-[10px] font-bold text-gray-500">Status</span>
            </div>

            {/* Table rows */}
            <div className="max-h-[calc(100vh-340px)] overflow-y-auto">
                {filtered.length === 0 && filteredUnmapped.length === 0 ? (
                    <div className="py-4 text-center text-xs text-gray-400">No assets match filter</div>
                ) : (
                    <>
                        {filtered.map(row => (
                            <BalanceRowItem
                                key={row.symbol}
                                row={row}
                                deltaThreshold={deltaThreshold}
                                assetMap={assetMap}
                                assetIdMap={assetIdMap}
                            />
                        ))}

                        {/* Unmapped live assets section */}
                        {filteredUnmapped.length > 0 && filtered.length > 0 && (
                            <div className="border-b border-purple-100 bg-purple-50 px-2 py-1.5">
                                <div className="flex items-center gap-1">
                                    <LuLink2Off size={12} className="text-purple-600" />
                                    <span className="text-[10px] font-bold text-purple-600">
                                        Unmapped — in live balance but no P&L record
                                    </span>
                                </div>
                            </div>
                        )}
                        {filteredUnmapped.map(u => (
                            <UnmappedRowItem key={u.symbol} asset={u} />
                        ))}
                    </>
                )}
            </div>
        </SlidePanel>
    );
};
