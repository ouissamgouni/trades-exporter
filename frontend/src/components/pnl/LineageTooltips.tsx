/**
 * LineageTooltips — Lazy-loaded hover tooltips for cost lot and realized P&L lineage.
 *
 * Follows the same pattern as TransactionTooltip in DataExplorerPanel:
 * - Fetches data on first hover (onMouseEnter)
 * - Shows loading/error/data states
 * - Dark tooltip with structured rows
 */

import React, { useState } from 'react';
import { Badge, BadgeColorScheme } from '../ui/primitives';
import { Tooltip } from '../ui/tooltip';
import { ValueDisplay } from '../ValueDisplay';
import { API_URL } from '../../types';

export const costSourceColor = (source?: string): BadgeColorScheme => {
    switch (source) {
        case 'fmv': return 'purple';
        case 'provisional': return 'orange';
        case 'proceeds': return 'green';
        case 'inherited': return 'blue';
        default: return 'gray';
    }
};

// ============================================================================
// CostLotLineageTooltip — Shows consumed slices, settlements, origin TX
// ============================================================================

interface CostLotLineage {
    lot: {
        cost_lot_id: number;
        asset: { symbol: string };
        qty_original: number;
        qty_remaining: number;
        unit_cost_in_base: number;
        cost_source?: string;
        acquired_at: string;
        origin_transaction_id?: number;
    };
    consumed_slices: Array<{
        cost_lot_id: number;
        quantity: number;
        unit_cost_in_base: number;
        total_cost_in_base: number;
        holding_period_days?: number;
        consumed_at?: string;
        consumed_by_unit_id?: number;
    }>;
    settlements: Array<{
        settlement_id: number;
        settling_lot_id: number;
        qty_settled: number;
        cost_basis_applied?: number;
        settled_at: string;
    }>;
    events_count: number;
    origin_transaction?: {
        id: number;
        date_time?: string;
        source?: string;
        transaction_type?: string;
        account_name?: string;
    };
}

export interface CostLotLineageTooltipProps {
    lotId: number;
    versionId: number;
    baseCurrency: string;
    children: React.ReactNode;
    onTransactionClick?: (txId: number) => void;
}

export const CostLotLineageTooltip: React.FC<CostLotLineageTooltipProps> = ({
    lotId, versionId, baseCurrency, children, onTransactionClick,
}) => {
    const [data, setData] = useState<CostLotLineage | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasFetched, setHasFetched] = useState(false);

    const fetchLineage = async () => {
        if (hasFetched || loading) return;
        setLoading(true);
        setHasFetched(true);
        try {
            const res = await fetch(`${API_URL}/pnl/versions/${versionId}/lots/${lotId}/lineage`);
            if (!res.ok) throw new Error('Failed to fetch');
            setData(await res.json());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Error');
        } finally {
            setLoading(false);
        }
    };

    const tooltipContent = (
        <div className="min-w-[280px] max-w-[360px] rounded-md bg-gray-800 p-2" onMouseEnter={fetchLineage}>
            {loading ? (
                <div className="text-xs text-gray-300">Loading lineage…</div>
            ) : error ? (
                <div className="text-xs text-red-300">Error: {error}</div>
            ) : data ? (
                <div className="text-xs">
                    {/* Lot summary */}
                    <div className="mb-1 font-semibold text-white">
                        Lot #{data.lot.cost_lot_id} — {data.lot.asset.symbol}
                    </div>
                    <div className="mb-0.5 flex justify-between">
                        <span className="text-gray-400">Qty</span>
                        <span className="font-mono text-white">
                            {Number(data.lot.qty_original).toFixed(4)} → {Number(data.lot.qty_remaining).toFixed(4)} remaining
                        </span>
                    </div>
                    <div className="mb-0.5 flex justify-between">
                        <span className="text-gray-400">Unit Cost</span>
                        <span className="text-white"><ValueDisplay value={data.lot.unit_cost_in_base} currency={baseCurrency} /></span>
                    </div>
                    {data.lot.cost_source && (
                        <div className="mb-0.5 flex justify-between">
                            <span className="text-gray-400">Source</span>
                            <Badge colorScheme={costSourceColor(data.lot.cost_source)}>{data.lot.cost_source}</Badge>
                        </div>
                    )}
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">Acquired</span>
                        <span className="text-white">{data.lot.acquired_at ? new Date(data.lot.acquired_at).toLocaleDateString() : '-'}</span>
                    </div>

                    {/* Origin TX */}
                    {data.origin_transaction && (
                        <>
                            <div className="my-1 border-t border-gray-600" />
                            <div className="mb-0.5 font-semibold text-gray-300">Origin Transaction</div>
                            <div className="mb-0.5 flex justify-between">
                                <span className="text-gray-400">TX</span>
                                <span
                                    className={`text-blue-300 ${onTransactionClick ? 'cursor-pointer underline' : ''}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onTransactionClick && data.origin_transaction) {
                                            onTransactionClick(data.origin_transaction.id);
                                        }
                                    }}
                                >
                                    #{data.origin_transaction.id}
                                </span>
                            </div>
                            {data.origin_transaction.date_time && (
                                <div className="mb-0.5 flex justify-between">
                                    <span className="text-gray-400">Date</span>
                                    <span className="text-white">{new Date(data.origin_transaction.date_time).toLocaleString()}</span>
                                </div>
                            )}
                            {data.origin_transaction.source && (
                                <div className="mb-0.5 flex justify-between">
                                    <span className="text-gray-400">Source</span>
                                    <span className="text-white">{data.origin_transaction.source}</span>
                                </div>
                            )}
                            {data.origin_transaction.transaction_type && (
                                <div className="mb-0.5 flex justify-between">
                                    <span className="text-gray-400">Type</span>
                                    <span className="text-white">{data.origin_transaction.transaction_type}</span>
                                </div>
                            )}
                        </>
                    )}

                    {/* Consumed slices */}
                    {data.consumed_slices.length > 0 && (
                        <>
                            <div className="my-1 border-t border-gray-600" />
                            <div className="mb-0.5 font-semibold text-gray-300">
                                Consumed × {data.consumed_slices.length}
                            </div>
                            {data.consumed_slices.slice(0, 3).map((s, i) => (
                                <div key={i} className="mb-0.5 flex justify-between">
                                    <span className="text-gray-400">
                                        {s.consumed_at ? new Date(s.consumed_at).toLocaleDateString() : '-'}
                                        {s.holding_period_days != null && ` (${s.holding_period_days}d)`}
                                    </span>
                                    <span className="font-mono text-white">
                                        {Number(s.quantity).toFixed(4)} @ <ValueDisplay value={s.unit_cost_in_base} currency={baseCurrency} />
                                    </span>
                                </div>
                            ))}
                            {data.consumed_slices.length > 3 && (
                                <div className="text-[10px] text-gray-400">+{data.consumed_slices.length - 3} more…</div>
                            )}
                        </>
                    )}

                    {/* Settlements (for negative lots) */}
                    {data.settlements.length > 0 && (
                        <>
                            <div className="my-1 border-t border-gray-600" />
                            <div className="mb-0.5 font-semibold text-gray-300">
                                Settlements × {data.settlements.length}
                            </div>
                            {data.settlements.slice(0, 3).map((s, i) => (
                                <div key={i} className="mb-0.5 flex justify-between">
                                    <span className="text-gray-400">Lot #{s.settling_lot_id}</span>
                                    <span className="font-mono text-white">
                                        {Number(s.qty_settled).toFixed(4)}
                                        {s.cost_basis_applied != null && ` @ ${Number(s.cost_basis_applied).toFixed(2)}`}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}

                    {/* Events count */}
                    {data.events_count > 0 && (
                        <div className="mt-1 text-[10px] text-gray-500">
                            {data.events_count} event{data.events_count !== 1 ? 's' : ''} total
                        </div>
                    )}
                </div>
            ) : (
                <div className="text-xs text-gray-400">Hover to load lineage</div>
            )}
        </div>
    );

    return (
        <Tooltip content={tooltipContent} openDelay={200} closeDelay={100}>
            <div onMouseEnter={fetchLineage} className="inline-block">
                {children}
            </div>
        </Tooltip>
    );
};


// ============================================================================
// RealizedPnlLineageTooltip — Shows source lots that contributed cost basis
// ============================================================================

interface RealizedPnlLineage {
    pnl: {
        pnl_id: number;
        asset: { symbol: string };
        qty: number;
        proceeds_in_base: number;
        cost_basis_in_base: number;
        pnl_in_base: number;
        taxable: boolean;
        transaction_id?: number;
        realized_at: string;
        holding_period_days?: number;
        proceeds_source?: string;
    };
    source_lots: Array<{
        cost_lot_id: number;
        asset: { symbol: string };
        unit_cost_in_base: number;
        cost_source?: string;
        acquired_at: string;
        origin_transaction_id?: number;
    }>;
    consumed_slices: Array<{
        cost_lot_id: number;
        quantity: number;
        unit_cost_in_base: number;
        total_cost_in_base: number;
        holding_period_days?: number;
    }>;
    disposal_transaction?: {
        id: number;
        date_time?: string;
        source?: string;
        transaction_type?: string;
        account_name?: string;
    };
}

export interface RealizedPnlLineageTooltipProps {
    pnlId: number;
    versionId: number;
    baseCurrency: string;
    children: React.ReactNode;
    onTransactionClick?: (txId: number) => void;
}

export const RealizedPnlLineageTooltip: React.FC<RealizedPnlLineageTooltipProps> = ({
    pnlId, versionId, baseCurrency, children, onTransactionClick,
}) => {
    const [data, setData] = useState<RealizedPnlLineage | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasFetched, setHasFetched] = useState(false);

    const fetchLineage = async () => {
        if (hasFetched || loading) return;
        setLoading(true);
        setHasFetched(true);
        try {
            const res = await fetch(`${API_URL}/pnl/versions/${versionId}/realized-pnl/${pnlId}/lineage`);
            if (!res.ok) throw new Error('Failed to fetch');
            setData(await res.json());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Error');
        } finally {
            setLoading(false);
        }
    };

    const tooltipContent = (
        <div className="min-w-[280px] max-w-[360px] rounded-md bg-gray-800 p-2" onMouseEnter={fetchLineage}>
            {loading ? (
                <div className="text-xs text-gray-300">Loading lineage…</div>
            ) : error ? (
                <div className="text-xs text-red-300">Error: {error}</div>
            ) : data ? (
                <div className="text-xs">
                    {/* PnL summary */}
                    <div className="mb-1 font-semibold text-white">
                        P&L #{data.pnl.pnl_id} — {data.pnl.asset.symbol}
                    </div>
                    <div className="mb-0.5 flex justify-between">
                        <span className="text-gray-400">Qty Disposed</span>
                        <span className="font-mono text-white">{Number(data.pnl.qty).toFixed(4)}</span>
                    </div>
                    <div className="mb-0.5 flex justify-between">
                        <span className="text-gray-400">Proceeds</span>
                        <span className="text-white"><ValueDisplay value={data.pnl.proceeds_in_base} currency={baseCurrency} /></span>
                    </div>
                    <div className="mb-0.5 flex justify-between">
                        <span className="text-gray-400">Cost Basis</span>
                        <span className="text-white"><ValueDisplay value={data.pnl.cost_basis_in_base} currency={baseCurrency} /></span>
                    </div>
                    <div className="mb-0.5 flex justify-between">
                        <span className="text-gray-400">P&L</span>
                        <span className={`font-bold ${data.pnl.pnl_in_base >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                            <ValueDisplay value={data.pnl.pnl_in_base} currency={baseCurrency} />
                        </span>
                    </div>
                    {data.pnl.holding_period_days != null && (
                        <div className="mb-0.5 flex justify-between">
                            <span className="text-gray-400">Holding</span>
                            <span className="text-white">{data.pnl.holding_period_days} days</span>
                        </div>
                    )}

                    {/* Disposal TX */}
                    {data.disposal_transaction && (
                        <>
                            <div className="my-1 border-t border-gray-600" />
                            <div className="mb-0.5 font-semibold text-gray-300">Disposal Transaction</div>
                            <div className="mb-0.5 flex justify-between">
                                <span className="text-gray-400">TX</span>
                                <span
                                    className={`text-blue-300 ${onTransactionClick ? 'cursor-pointer underline' : ''}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onTransactionClick && data.disposal_transaction) {
                                            onTransactionClick(data.disposal_transaction.id);
                                        }
                                    }}
                                >
                                    #{data.disposal_transaction.id}
                                </span>
                            </div>
                            {data.disposal_transaction.date_time && (
                                <div className="mb-0.5 flex justify-between">
                                    <span className="text-gray-400">Date</span>
                                    <span className="text-white">{new Date(data.disposal_transaction.date_time).toLocaleString()}</span>
                                </div>
                            )}
                            {data.disposal_transaction.source && (
                                <div className="mb-0.5 flex justify-between">
                                    <span className="text-gray-400">Source</span>
                                    <span className="text-white">{data.disposal_transaction.source}</span>
                                </div>
                            )}
                        </>
                    )}

                    {/* Source lots (cost basis came from these lots) */}
                    {data.consumed_slices.length > 0 && (
                        <>
                            <div className="my-1 border-t border-gray-600" />
                            <div className="mb-0.5 font-semibold text-gray-300">
                                Source Lots × {data.consumed_slices.length}
                            </div>
                            {data.consumed_slices.slice(0, 4).map((s, i) => {
                                const srcLot = data.source_lots.find(l => l.cost_lot_id === s.cost_lot_id);
                                return (
                                    <div key={i} className="mb-0.5 flex items-center justify-between">
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-400">Lot #{s.cost_lot_id}</span>
                                            {srcLot?.cost_source && (
                                                <Badge colorScheme={costSourceColor(srcLot.cost_source)}>{srcLot.cost_source}</Badge>
                                            )}
                                        </div>
                                        <span className="font-mono text-white">
                                            {Number(s.quantity).toFixed(4)} @ <ValueDisplay value={s.unit_cost_in_base} currency={baseCurrency} />
                                        </span>
                                    </div>
                                );
                            })}
                            {data.consumed_slices.length > 4 && (
                                <div className="text-[10px] text-gray-400">+{data.consumed_slices.length - 4} more…</div>
                            )}
                        </>
                    )}
                </div>
            ) : (
                <div className="text-xs text-gray-400">Hover to load lineage</div>
            )}
        </div>
    );

    return (
        <Tooltip content={tooltipContent} openDelay={200} closeDelay={100}>
            <div onMouseEnter={fetchLineage} className="inline-block">
                {children}
            </div>
        </Tooltip>
    );
};
