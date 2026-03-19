/**
 * LineageTooltips — Lazy-loaded hover tooltips for cost lot and realized P&L lineage.
 *
 * Follows the same pattern as TransactionTooltip in DataExplorerPanel:
 * - Fetches data on first hover (onMouseEnter)
 * - Shows loading/error/data states
 * - Dark tooltip with structured rows
 */

import React, { useState } from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { Tooltip } from '../ui/tooltip';
import { ValueDisplay } from '../ValueDisplay';
import { API_URL } from '../../types';

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
        <Box p={2} bg="gray.800" borderRadius="md" minW="280px" maxW="360px" onMouseEnter={fetchLineage}>
            {loading ? (
                <Text fontSize="xs" color="gray.300">Loading lineage…</Text>
            ) : error ? (
                <Text fontSize="xs" color="red.300">Error: {error}</Text>
            ) : data ? (
                <Box fontSize="xs">
                    {/* Lot summary */}
                    <Text fontWeight="semibold" color="white" mb={1}>
                        Lot #{data.lot.cost_lot_id} — {data.lot.asset.symbol}
                    </Text>
                    <Flex justify="space-between" mb={0.5}>
                        <Text color="gray.400">Qty</Text>
                        <Text color="white" fontFamily="mono">
                            {Number(data.lot.qty_original).toFixed(4)} → {Number(data.lot.qty_remaining).toFixed(4)} remaining
                        </Text>
                    </Flex>
                    <Flex justify="space-between" mb={0.5}>
                        <Text color="gray.400">Unit Cost</Text>
                        <Text color="white"><ValueDisplay value={data.lot.unit_cost_in_base} currency={baseCurrency} /></Text>
                    </Flex>
                    {data.lot.cost_source && (
                        <Flex justify="space-between" mb={0.5}>
                            <Text color="gray.400">Source</Text>
                            <Badge size="xs" colorPalette={
                                data.lot.cost_source === 'fmv' ? 'cyan' :
                                    data.lot.cost_source === 'provisional' ? 'orange' :
                                        data.lot.cost_source === 'proceeds' ? 'green' :
                                            data.lot.cost_source === 'inherited' ? 'blue' : 'gray'
                            }>{data.lot.cost_source}</Badge>
                        </Flex>
                    )}
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Acquired</Text>
                        <Text color="white">{data.lot.acquired_at ? new Date(data.lot.acquired_at).toLocaleDateString() : '-'}</Text>
                    </Flex>

                    {/* Origin TX */}
                    {data.origin_transaction && (
                        <>
                            <Box borderTop="1px solid" borderColor="gray.600" my={1} />
                            <Text fontWeight="semibold" color="gray.300" mb={0.5}>Origin Transaction</Text>
                            <Flex justify="space-between" mb={0.5}>
                                <Text color="gray.400">TX</Text>
                                <Text
                                    color="blue.300"
                                    cursor={onTransactionClick ? 'pointer' : undefined}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onTransactionClick && data.origin_transaction) {
                                            onTransactionClick(data.origin_transaction.id);
                                        }
                                    }}
                                    textDecoration={onTransactionClick ? 'underline' : undefined}
                                >
                                    #{data.origin_transaction.id}
                                </Text>
                            </Flex>
                            {data.origin_transaction.date_time && (
                                <Flex justify="space-between" mb={0.5}>
                                    <Text color="gray.400">Date</Text>
                                    <Text color="white">{new Date(data.origin_transaction.date_time).toLocaleString()}</Text>
                                </Flex>
                            )}
                            {data.origin_transaction.source && (
                                <Flex justify="space-between" mb={0.5}>
                                    <Text color="gray.400">Source</Text>
                                    <Text color="white">{data.origin_transaction.source}</Text>
                                </Flex>
                            )}
                            {data.origin_transaction.transaction_type && (
                                <Flex justify="space-between" mb={0.5}>
                                    <Text color="gray.400">Type</Text>
                                    <Text color="white">{data.origin_transaction.transaction_type}</Text>
                                </Flex>
                            )}
                        </>
                    )}

                    {/* Consumed slices */}
                    {data.consumed_slices.length > 0 && (
                        <>
                            <Box borderTop="1px solid" borderColor="gray.600" my={1} />
                            <Text fontWeight="semibold" color="gray.300" mb={0.5}>
                                Consumed × {data.consumed_slices.length}
                            </Text>
                            {data.consumed_slices.slice(0, 3).map((s, i) => (
                                <Flex key={i} justify="space-between" mb={0.5}>
                                    <Text color="gray.400">
                                        {s.consumed_at ? new Date(s.consumed_at).toLocaleDateString() : '-'}
                                        {s.holding_period_days != null && ` (${s.holding_period_days}d)`}
                                    </Text>
                                    <Text color="white" fontFamily="mono">
                                        {Number(s.quantity).toFixed(4)} @ <ValueDisplay value={s.unit_cost_in_base} currency={baseCurrency} />
                                    </Text>
                                </Flex>
                            ))}
                            {data.consumed_slices.length > 3 && (
                                <Text color="gray.400" fontSize="2xs">+{data.consumed_slices.length - 3} more…</Text>
                            )}
                        </>
                    )}

                    {/* Settlements (for negative lots) */}
                    {data.settlements.length > 0 && (
                        <>
                            <Box borderTop="1px solid" borderColor="gray.600" my={1} />
                            <Text fontWeight="semibold" color="gray.300" mb={0.5}>
                                Settlements × {data.settlements.length}
                            </Text>
                            {data.settlements.slice(0, 3).map((s, i) => (
                                <Flex key={i} justify="space-between" mb={0.5}>
                                    <Text color="gray.400">Lot #{s.settling_lot_id}</Text>
                                    <Text color="white" fontFamily="mono">
                                        {Number(s.qty_settled).toFixed(4)}
                                        {s.cost_basis_applied != null && ` @ ${Number(s.cost_basis_applied).toFixed(2)}`}
                                    </Text>
                                </Flex>
                            ))}
                        </>
                    )}

                    {/* Events count */}
                    {data.events_count > 0 && (
                        <Text color="gray.500" fontSize="2xs" mt={1}>
                            {data.events_count} event{data.events_count !== 1 ? 's' : ''} total
                        </Text>
                    )}
                </Box>
            ) : (
                <Text fontSize="xs" color="gray.400">Hover to load lineage</Text>
            )}
        </Box>
    );

    return (
        <Tooltip content={tooltipContent} openDelay={200} closeDelay={100}>
            <Box onMouseEnter={fetchLineage} display="inline-block">
                {children}
            </Box>
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
        <Box p={2} bg="gray.800" borderRadius="md" minW="280px" maxW="360px" onMouseEnter={fetchLineage}>
            {loading ? (
                <Text fontSize="xs" color="gray.300">Loading lineage…</Text>
            ) : error ? (
                <Text fontSize="xs" color="red.300">Error: {error}</Text>
            ) : data ? (
                <Box fontSize="xs">
                    {/* PnL summary */}
                    <Text fontWeight="semibold" color="white" mb={1}>
                        P&L #{data.pnl.pnl_id} — {data.pnl.asset.symbol}
                    </Text>
                    <Flex justify="space-between" mb={0.5}>
                        <Text color="gray.400">Qty Disposed</Text>
                        <Text color="white" fontFamily="mono">{Number(data.pnl.qty).toFixed(4)}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={0.5}>
                        <Text color="gray.400">Proceeds</Text>
                        <Text color="white"><ValueDisplay value={data.pnl.proceeds_in_base} currency={baseCurrency} /></Text>
                    </Flex>
                    <Flex justify="space-between" mb={0.5}>
                        <Text color="gray.400">Cost Basis</Text>
                        <Text color="white"><ValueDisplay value={data.pnl.cost_basis_in_base} currency={baseCurrency} /></Text>
                    </Flex>
                    <Flex justify="space-between" mb={0.5}>
                        <Text color="gray.400">P&L</Text>
                        <Text color={data.pnl.pnl_in_base >= 0 ? 'green.300' : 'red.300'} fontWeight="bold">
                            <ValueDisplay value={data.pnl.pnl_in_base} currency={baseCurrency} />
                        </Text>
                    </Flex>
                    {data.pnl.holding_period_days != null && (
                        <Flex justify="space-between" mb={0.5}>
                            <Text color="gray.400">Holding</Text>
                            <Text color="white">{data.pnl.holding_period_days} days</Text>
                        </Flex>
                    )}

                    {/* Disposal TX */}
                    {data.disposal_transaction && (
                        <>
                            <Box borderTop="1px solid" borderColor="gray.600" my={1} />
                            <Text fontWeight="semibold" color="gray.300" mb={0.5}>Disposal Transaction</Text>
                            <Flex justify="space-between" mb={0.5}>
                                <Text color="gray.400">TX</Text>
                                <Text
                                    color="blue.300"
                                    cursor={onTransactionClick ? 'pointer' : undefined}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onTransactionClick && data.disposal_transaction) {
                                            onTransactionClick(data.disposal_transaction.id);
                                        }
                                    }}
                                    textDecoration={onTransactionClick ? 'underline' : undefined}
                                >
                                    #{data.disposal_transaction.id}
                                </Text>
                            </Flex>
                            {data.disposal_transaction.date_time && (
                                <Flex justify="space-between" mb={0.5}>
                                    <Text color="gray.400">Date</Text>
                                    <Text color="white">{new Date(data.disposal_transaction.date_time).toLocaleString()}</Text>
                                </Flex>
                            )}
                            {data.disposal_transaction.source && (
                                <Flex justify="space-between" mb={0.5}>
                                    <Text color="gray.400">Source</Text>
                                    <Text color="white">{data.disposal_transaction.source}</Text>
                                </Flex>
                            )}
                        </>
                    )}

                    {/* Source lots (cost basis came from these lots) */}
                    {data.consumed_slices.length > 0 && (
                        <>
                            <Box borderTop="1px solid" borderColor="gray.600" my={1} />
                            <Text fontWeight="semibold" color="gray.300" mb={0.5}>
                                Source Lots × {data.consumed_slices.length}
                            </Text>
                            {data.consumed_slices.slice(0, 4).map((s, i) => {
                                const srcLot = data.source_lots.find(l => l.cost_lot_id === s.cost_lot_id);
                                return (
                                    <Flex key={i} justify="space-between" mb={0.5} align="center">
                                        <Flex align="center" gap={1}>
                                            <Text color="gray.400">Lot #{s.cost_lot_id}</Text>
                                            {srcLot?.cost_source && (
                                                <Badge size="xs" colorPalette={
                                                    srcLot.cost_source === 'fmv' ? 'cyan' :
                                                        srcLot.cost_source === 'provisional' ? 'orange' :
                                                            srcLot.cost_source === 'proceeds' ? 'green' : 'gray'
                                                }>{srcLot.cost_source}</Badge>
                                            )}
                                        </Flex>
                                        <Text color="white" fontFamily="mono">
                                            {Number(s.quantity).toFixed(4)} @ <ValueDisplay value={s.unit_cost_in_base} currency={baseCurrency} />
                                        </Text>
                                    </Flex>
                                );
                            })}
                            {data.consumed_slices.length > 4 && (
                                <Text color="gray.400" fontSize="2xs">+{data.consumed_slices.length - 4} more…</Text>
                            )}
                        </>
                    )}
                </Box>
            ) : (
                <Text fontSize="xs" color="gray.400">Hover to load lineage</Text>
            )}
        </Box>
    );

    return (
        <Tooltip content={tooltipContent} openDelay={200} closeDelay={100}>
            <Box onMouseEnter={fetchLineage} display="inline-block">
                {children}
            </Box>
        </Tooltip>
    );
};
