/**
 * Data Explorer Panel
 * 
 * P&L Audit view with:
 * - Calculation Units (with expandable row details)
 * - Cost Lots with consumption history
 * - Realized P&L list
 * - Warnings section
 * 
 * Provides full traceability and drill-down capability.
 */

import React, { useState, useMemo, useEffect } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Input,
    Table,
    Tabs,
    Text,
} from '@chakra-ui/react';
import { FiSearch, FiChevronDown, FiChevronRight, FiAlertTriangle, FiLayers, FiDatabase, FiDollarSign, FiLoader, FiLink, FiActivity, FiPlus } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { CalculationUnit, CostLot, RealizedPnLRow, PnLWarningItem, OriginTransactionDetail, Settlement, ConsumedSliceDetail, CostLotEventEntry, FeeEntry } from './types';
import { API_URL } from '../../types';
import { Tooltip } from '../ui/tooltip';
import { AssetBadge } from '../AssetBadge';
import { AddManualPriceDialog } from './AddManualPriceDialog';
import { formatDateLocale, formatDateTimeLocale } from '../../utils/dateUtils';

interface DataExplorerPanelProps {
    isOpen: boolean;
    onClose: () => void;
    calculationUnits: CalculationUnit[];
    costLots: CostLot[];
    consumedSlices?: ConsumedSliceDetail[];  // Consumed lot slices from /consumed-slices endpoint
    realizedPnL: RealizedPnLRow[];
    warnings: PnLWarningItem[];
    settlements?: Settlement[];  // Audit trail for negative lot settlements
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    onAssetClick?: (assetId: number) => void;
    // Manual price entry support for warnings
    quoteAssetId?: number;
    onPriceAdded?: (assetId: number, warningId: string) => void;
    assets?: Array<{ id: number; name: string }>;
}

const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
};

const formatQty = (value: number): string => {
    if (value === 0) return '0';
    return value.toFixed(8).replace(/\.?0+$/, '');
};

// Using formatDateLocale from utils/dateUtils for consistent date formatting

// ============================================================================
// Transaction Tooltip - On-hover transaction details
// ============================================================================

interface TransactionTooltipProps {
    txId: number;
    children: React.ReactNode;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}

const TransactionTooltip: React.FC<TransactionTooltipProps> = ({ txId, children, baseCurrency, onTransactionClick }) => {
    const [txData, setTxData] = useState<OriginTransactionDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasFetched, setHasFetched] = useState(false);

    const fetchTransaction = async () => {
        if (hasFetched || loading) return;
        setLoading(true);
        setHasFetched(true);
        try {
            const response = await fetch(`${API_URL}/transactions/${txId}`);
            if (!response.ok) throw new Error('Failed to fetch');
            const data = await response.json();
            setTxData({
                transaction_id: data.id,
                date_time: data.date_time,
                account_id: data.account_id,
                account_name: data.account_name || '-',  // Use server-side resolved account_name
                source: data.source,
                source_transaction_type: data.source_transaction_type,
                transaction_type: data.transaction_type,
                direction: data.direction,
                // Transfer fields
                from_account_id: data.from_account_id,
                from_account_name: data.from_account_name,
                to_account_id: data.to_account_id,
                to_account_name: data.to_account_name,
                source_from_account: data.source_from_account,
                source_to_account: data.source_to_account,
                // Nested asset refs
                linked_asset: data.linked_asset,
                price_quote_asset: data.price_quote_asset,
                fee_quote_asset: data.fee_quote_asset,
                // Legacy flat fields
                asset_id: data.asset_id,
                asset_symbol: data.linked_asset_symbol || data.source_asset_symbol,
                source_asset_symbol: data.source_asset_symbol,
                quantity: data.quantity,
                price: data.price,
                price_quote_asset_id: data.price_quote_asset_id,
                price_quote_asset_symbol: data.linked_price_quote_asset_symbol || data.source_price_quote_asset_symbol,
                source_price_quote_asset_symbol: data.source_price_quote_asset_symbol,
                total: data.total,
                fee: data.fee,
                fee_quote_asset_id: data.fee_quote_asset_id,
                fee_quote_asset_symbol: data.linked_fee_quote_asset_symbol || data.source_fee_quote_asset_symbol,
                source_fee_quote_asset_symbol: data.source_fee_quote_asset_symbol,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Error');
        } finally {
            setLoading(false);
        }
    };

    const tooltipContent = (
        <Box
            p={2}
            bg="gray.800"
            borderRadius="md"
            minW="250px"
            onMouseEnter={fetchTransaction}
        >
            {loading ? (
                <Flex align="center" gap={2}>
                    <FiLoader className="animate-spin" />
                    <Text fontSize="xs" color="gray.300">Loading...</Text>
                </Flex>
            ) : error ? (
                <Text fontSize="xs" color="red.300">Error: {error}</Text>
            ) : txData ? (
                <Box fontSize="xs">
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Date</Text>
                        <Text color="white">{txData.date_time ? formatDateTimeLocale(txData.date_time) : '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Account</Text>
                        <Text color="white">{txData.account_name || '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Type</Text>
                        <Text color="white">{txData.transaction_type || txData.source_transaction_type || '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Source</Text>
                        <Text color="white">{txData.source || '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1} align="center">
                        <Text color="gray.400">Asset</Text>
                        <AssetBadge
                            asset={txData.linked_asset}
                            sourceSymbol={txData.source_asset_symbol}
                            size="xs"
                            maxLength={18}
                        />
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Quantity</Text>
                        <Text color="white" fontFamily="mono">{formatQty(txData.quantity || 0)}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Unit Price</Text>
                        <Text color="white">{txData.price ? formatCurrency(txData.price, baseCurrency) : '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Total</Text>
                        <Text color="white">{txData.total ? formatCurrency(txData.total, baseCurrency) : '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1} align="center">
                        <Text color="gray.400">Quote Asset</Text>
                        <AssetBadge
                            asset={txData.price_quote_asset}
                            sourceSymbol={txData.source_price_quote_asset_symbol}
                            size="xs"
                            colorPalette="cyan"
                            maxLength={15}
                        />
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Fee</Text>
                        <Text color="white">{txData.fee ? formatQty(txData.fee) : '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1} align="center">
                        <Text color="gray.400">Fee Quote</Text>
                        <AssetBadge
                            asset={txData.fee_quote_asset}
                            sourceSymbol={txData.source_fee_quote_asset_symbol}
                            size="xs"
                            colorPalette="orange"
                            maxLength={15}
                        />
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">From/To Account</Text>
                        <Text color="white">
                            {txData.direction === 'inflow'
                                ? (txData.from_account_name || txData.source_from_account || '-')
                                : (txData.to_account_name || txData.source_to_account || '-')}
                        </Text>
                    </Flex>
                </Box>
            ) : (
                <Text fontSize="xs" color="gray.400">Hover to load details</Text>
            )}
        </Box>
    );

    return (
        <Tooltip
            content={tooltipContent}
            openDelay={200}
            closeDelay={100}
        >
            <Box onMouseEnter={fetchTransaction} display="inline-block">
                {children}
            </Box>
        </Tooltip>
    );
};

// ============================================================================
// Transaction Cell - Reusable transaction ID cell with tooltip
// ============================================================================

interface TransactionCellProps {
    txId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    prefix?: string;  // e.g., "TX" or "View TX"
    variant?: 'ghost' | 'outline' | 'solid' | 'subtle';
    size?: 'xs' | 'sm' | 'md';
}

const TransactionCell: React.FC<TransactionCellProps> = ({
    txId,
    baseCurrency,
    onTransactionClick,
    prefix = 'TX',
    variant = 'ghost',
    size = 'xs'
}) => {
    return (
        <TransactionTooltip txId={txId} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
            <Button
                size={size}
                variant={variant}
                onClick={(e) => {
                    e.stopPropagation();
                    onTransactionClick?.(txId);
                }}
            >
                {prefix}{prefix ? ' ' : ''}#{txId}
            </Button>
        </TransactionTooltip>
    );
};

// ============================================================================
// Compact Transaction Info - Inline transaction details (no tooltip, compact)
// ============================================================================

interface CompactTxInfoProps {
    txId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    showDate?: boolean;
    showType?: boolean;
    showAsset?: boolean;
    showQty?: boolean;
    showAccount?: boolean;
}

const CompactTxInfo: React.FC<CompactTxInfoProps> = ({
    txId,
    baseCurrency,
    onTransactionClick,
    showDate = true,
    showType = true,
    showAsset = true,
    showQty = true,
    showAccount = false,
}) => {
    const [txData, setTxData] = useState<OriginTransactionDetail | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchTx = async () => {
            try {
                const response = await fetch(`${API_URL}/transactions/${txId}`);
                if (!response.ok) return;
                const data = await response.json();
                setTxData({
                    transaction_id: data.id,
                    date_time: data.date_time,
                    account_id: data.account_id,
                    account_name: data.account || '-',
                    source: data.source,
                    source_transaction_type: data.source_transaction_type,
                    direction: data.direction,
                    asset_id: data.asset_id,
                    asset_symbol: data.linked_asset_symbol || data.source_asset_symbol,
                    quantity: data.quantity,
                    price: data.price,
                    price_quote_asset_id: data.price_quote_asset_id,
                    price_quote_asset_symbol: data.linked_price_quote_asset_symbol || data.source_price_quote_asset_symbol,
                    total: data.total,
                    fee: data.fee,
                    fee_quote_asset_id: data.fee_quote_asset_id,
                    fee_quote_asset_symbol: data.linked_fee_quote_asset_symbol || data.source_fee_quote_asset_symbol,
                });
            } catch {
                // Silent fail - just show TX ID
            } finally {
                setLoading(false);
            }
        };
        fetchTx();
    }, [txId]);

    if (loading) {
        return (
            <Flex align="center" gap={1}>
                <Button
                    size="xs"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); onTransactionClick?.(txId); }}
                >
                    TX #{txId}
                </Button>
                <FiLoader size={10} className="animate-spin" />
            </Flex>
        );
    }

    if (!txData) {
        return (
            <Button
                size="xs"
                variant="ghost"
                onClick={(e) => { e.stopPropagation(); onTransactionClick?.(txId); }}
            >
                TX #{txId}
            </Button>
        );
    }

    return (
        <Flex direction="column" gap={0} fontSize="2xs">
            <Flex align="center" gap={1} wrap="wrap">
                <Button
                    size="xs"
                    variant="ghost"
                    p={0}
                    h="auto"
                    minW="auto"
                    fontWeight="medium"
                    color="blue.600"
                    onClick={(e) => { e.stopPropagation(); onTransactionClick?.(txId); }}
                >
                    #{txId}
                </Button>
                {showType && txData.source_transaction_type && (
                    <Badge size="xs" colorPalette="gray" variant="subtle">
                        {txData.source_transaction_type}
                    </Badge>
                )}
                {showAsset && txData.asset_symbol && (
                    <Badge
                        size="xs"
                        colorPalette={txData.direction === 'inflow' ? 'green' : txData.direction === 'outflow' ? 'red' : 'gray'}
                    >
                        {txData.direction === 'inflow' ? '+' : txData.direction === 'outflow' ? '−' : ''}{txData.asset_symbol}
                    </Badge>
                )}
                {showQty && txData.quantity != null && (
                    <Text fontFamily="mono" color="gray.600">
                        {formatQty(txData.quantity)}
                    </Text>
                )}
            </Flex>
            <Flex align="center" gap={1} color="gray.500" wrap="wrap">
                {showDate && txData.date_time && (
                    <Text>{formatDateLocale(txData.date_time)}</Text>
                )}
                {showAccount && txData.account_name && (
                    <Text>• {txData.account_name}</Text>
                )}
                {txData.total != null && txData.total > 0 && (
                    <Text>• {formatCurrency(txData.total, baseCurrency)}</Text>
                )}
            </Flex>
        </Flex>
    );
};

// ============================================================================
// Unit Detail Expanded Row
// ============================================================================

interface UnitDetailRowProps {
    unit: CalculationUnit;
    baseCurrency: string;
    costLots: CostLot[];
    versionId?: number | null;
    onTransactionClick?: (txId: number) => void;
}

const UnitDetailRow: React.FC<UnitDetailRowProps> = ({ unit, baseCurrency, costLots, versionId, onTransactionClick }) => {
    // Fetch ALL origin transaction details on-demand (units can have multiple transactions)
    const [originTxs, setOriginTxs] = useState<OriginTransactionDetail[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Fetch lot events on-demand for this unit
    const [unitEvents, setUnitEvents] = useState<CostLotEventEntry[]>([]);
    const [loadingEvents, setLoadingEvents] = useState(false);

    // Get all transaction IDs for this unit
    // Get all transaction IDs for this unit
    const allTxIds = useMemo(() => {
        if (unit.transaction_ids && unit.transaction_ids.length > 0) {
            return [...unit.transaction_ids];
        }
        return [];
    }, [unit.transaction_ids]);

    useEffect(() => {
        const fetchOriginTransactions = async () => {
            if (allTxIds.length === 0) return;

            setLoading(true);
            setError(null);
            try {
                // Fetch all transactions in parallel
                const responses = await Promise.all(
                    allTxIds.map(txId => fetch(`${API_URL}/transactions/${txId}`))
                );

                const txDetails: OriginTransactionDetail[] = [];
                for (const response of responses) {
                    if (!response.ok) continue;
                    const data = await response.json();
                    txDetails.push({
                        transaction_id: data.id,
                        date_time: data.date_time,
                        account_id: data.account_id,
                        account_name: data.account_name || '-',  // Use server-side resolved account_name
                        source: data.source,
                        source_transaction_type: data.source_transaction_type,
                        transaction_type: data.transaction_type,
                        direction: data.direction,
                        // Transfer fields
                        from_account_id: data.from_account_id,
                        from_account_name: data.from_account_name,
                        to_account_id: data.to_account_id,
                        to_account_name: data.to_account_name,
                        source_from_account: data.source_from_account,
                        source_to_account: data.source_to_account,
                        // Nested asset refs
                        linked_asset: data.linked_asset,
                        price_quote_asset: data.price_quote_asset,
                        fee_quote_asset: data.fee_quote_asset,
                        // Legacy flat fields
                        asset_id: data.asset_id,
                        asset_symbol: data.linked_asset_symbol || data.source_asset_symbol,
                        source_asset_symbol: data.source_asset_symbol,
                        quantity: data.quantity,
                        price: data.price,
                        price_quote_asset_id: data.price_quote_asset_id,
                        price_quote_asset_symbol: data.linked_price_quote_asset_symbol || data.source_price_quote_asset_symbol,
                        source_price_quote_asset_symbol: data.source_price_quote_asset_symbol,
                        total: data.total,
                        fee: data.fee,
                        fee_quote_asset_id: data.fee_quote_asset_id,
                        fee_quote_asset_symbol: data.linked_fee_quote_asset_symbol || data.source_fee_quote_asset_symbol,
                        source_fee_quote_asset_symbol: data.source_fee_quote_asset_symbol,
                    });
                }
                setOriginTxs(txDetails);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Unknown error');
            } finally {
                setLoading(false);
            }
        };

        fetchOriginTransactions();
    }, [allTxIds]);

    // Build a map of cost_lot_id -> CostLot for quick lookup
    const lotMap = useMemo(() => {
        const map = new Map<number, CostLot>();
        for (const lot of costLots) {
            map.set(lot.cost_lot_id, lot);
        }
        return map;
    }, [costLots]);

    // Fetch lot events on-demand when row expands
    useEffect(() => {
        const fetchUnitEvents = async () => {
            if (!versionId || !unit.unit_id) return;
            setLoadingEvents(true);
            try {
                const response = await fetch(`${API_URL}/pnl/versions/${versionId}/lot-events?unit_id=${unit.unit_id}`);
                if (response.ok) {
                    const data = await response.json();
                    setUnitEvents(data);
                }
            } catch (err) {
                console.error('Failed to fetch unit events:', err);
            } finally {
                setLoadingEvents(false);
            }
        };
        fetchUnitEvents();
    }, [versionId, unit.unit_id]);

    return (
        <Box bg="gray.50" p={4} borderRadius="md">
            <Flex direction="column" gap={4}>
                {/* Origin Transactions - Full Width - Now shows ALL transactions in the unit */}
                <Card.Root size="sm" variant="outline">
                    <Card.Body p={3}>
                        <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={2}>
                            📄 Origin Transactions ({allTxIds.length})
                        </Text>
                        {loading ? (
                            <Flex align="center" gap={2} py={2}>
                                <FiLoader className="animate-spin" />
                                <Text fontSize="xs" color="gray.500">Loading transaction details...</Text>
                            </Flex>
                        ) : error ? (
                            <Text fontSize="xs" color="red.500">Error: {error}</Text>
                        ) : originTxs.length > 0 ? (
                            <Table.Root size="sm">
                                <Table.Header>
                                    <Table.Row>
                                        <Table.ColumnHeader fontSize="xs">TX ID</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs">Date</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs">Direction</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs">Asset</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs" textAlign="right">Qty</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs" textAlign="right">Price</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs" textAlign="right">Total</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs" textAlign="right">Fee</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs">Account</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs">Type</Table.ColumnHeader>
                                        <Table.ColumnHeader fontSize="xs">From/To</Table.ColumnHeader>
                                    </Table.Row>
                                </Table.Header>
                                <Table.Body>
                                    {originTxs.map((tx) => {
                                        const txType = tx.transaction_type || tx.source_transaction_type || '-';
                                        const fromAccount = tx.from_account_name || tx.source_from_account;
                                        const toAccount = tx.to_account_name || tx.source_to_account;
                                        // From/To Account: show from_account if inflow, to_account if outflow
                                        const fromToAccount = tx.direction === 'inflow' ? fromAccount : toAccount;

                                        return (
                                            <Table.Row key={tx.transaction_id}>
                                                <Table.Cell>
                                                    <TransactionCell
                                                        txId={tx.transaction_id}
                                                        baseCurrency={baseCurrency}
                                                        onTransactionClick={onTransactionClick}
                                                        prefix=""
                                                        size="xs"
                                                    />
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs">
                                                    {tx.date_time ? formatDateLocale(tx.date_time) : '-'}
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <Badge
                                                        size="xs"
                                                        colorPalette={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}
                                                    >
                                                        {tx.direction || '-'}
                                                    </Badge>
                                                </Table.Cell>
                                                <Table.Cell>
                                                    <AssetBadge
                                                        asset={tx.linked_asset}
                                                        sourceSymbol={tx.source_asset_symbol || tx.asset_symbol}
                                                        size="xs"
                                                        maxLength={15}
                                                    />
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                                    {formatQty(tx.quantity || 0)}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="right">
                                                    {tx.price ? formatCurrency(tx.price, baseCurrency) : '-'}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="right">
                                                    {tx.total ? formatCurrency(tx.total, baseCurrency) : '-'}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="right">
                                                    {tx.fee ? (
                                                        <Flex align="center" gap={1} justify="flex-end">
                                                            <Text color="orange.600">{formatQty(tx.fee)}</Text>
                                                            <AssetBadge
                                                                asset={tx.fee_quote_asset}
                                                                sourceSymbol={tx.source_fee_quote_asset_symbol || tx.fee_quote_asset_symbol}
                                                                size="xs"
                                                                colorPalette="orange"
                                                                maxLength={10}
                                                            />
                                                        </Flex>
                                                    ) : '-'}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs">{tx.account_name || '-'}</Table.Cell>
                                                <Table.Cell fontSize="xs">
                                                    <Badge size="xs" colorPalette={txType === 'transfer' ? 'blue' : 'gray'}>
                                                        {txType}
                                                    </Badge>
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" color="gray.600">
                                                    {fromToAccount || '-'}
                                                </Table.Cell>
                                            </Table.Row>
                                        );
                                    })}
                                </Table.Body>
                            </Table.Root>
                        ) : (
                            /* Fallback: show transaction IDs as clickable buttons */
                            <Flex gap={4} wrap="wrap" fontSize="xs" align="center">
                                <Box>
                                    <Text color="gray.500" fontWeight="bold">Date</Text>
                                    <Text>{formatDateLocale(unit.date)}</Text>
                                </Box>
                                <Box>
                                    <Text color="gray.500" fontWeight="bold">Outflows</Text>
                                    <Flex gap={1} wrap="wrap">
                                        {unit.outflow_asset_symbols?.map((symbol, i) => (
                                            <Badge key={i} size="xs" colorPalette="red">{symbol}</Badge>
                                        )) || <Text>-</Text>}
                                    </Flex>
                                </Box>
                                <Box>
                                    <Text color="gray.500" fontWeight="bold">Inflows</Text>
                                    <Flex gap={1} wrap="wrap">
                                        {unit.inflow_asset_symbols?.map((symbol, i) => (
                                            <Badge key={i} size="xs" colorPalette="green">{symbol}</Badge>
                                        )) || <Text>-</Text>}
                                    </Flex>
                                </Box>
                                <Box>
                                    <Text color="gray.500" fontWeight="bold">Transactions</Text>
                                    <Flex gap={1} wrap="wrap">
                                        {allTxIds.length > 0 ? (
                                            allTxIds.map(txId => (
                                                <Button
                                                    key={txId}
                                                    size="xs"
                                                    variant="outline"
                                                    onClick={() => onTransactionClick?.(txId)}
                                                >
                                                    #{txId}
                                                </Button>
                                            ))
                                        ) : (
                                            <Text color="gray.400">-</Text>
                                        )}
                                    </Flex>
                                </Box>
                            </Flex>
                        )}
                    </Card.Body>
                </Card.Root>

                {/* Two columns: Cost Lot Events | P&L + Warnings */}
                <Flex gap={4} wrap="wrap">
                    {/* Cost Lot Events Card - Shows actual CostLotEventEntry items */}
                    <Card.Root size="sm" variant="outline" flex="1" minW="400px" overflow="hidden">
                        <Card.Body p={3} overflow="auto">
                            {(() => {
                                // Consistent colors with CostLotEventsTab:
                                // - created: green (positive lot addition)
                                // - consumed: orange (lot consumption/reduction)
                                // - settled, transferred, adjusted: distinct colors
                                const eventTypeColors: Record<string, string> = {
                                    created: 'green',
                                    consumed: 'orange',
                                    settled: 'purple',
                                    transferred: 'blue',
                                    adjusted: 'blue',
                                };

                                return (
                                    <>
                                        <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={2}>
                                            📦 Cost Lot Events ({loadingEvents ? '...' : unitEvents.length})
                                        </Text>
                                        {loadingEvents ? (
                                            <Flex align="center" gap={2} py={2}>
                                                <FiLoader className="animate-spin" />
                                                <Text fontSize="xs" color="gray.500">Loading events...</Text>
                                            </Flex>
                                        ) : unitEvents.length > 0 ? (
                                            <Box overflowX="auto">
                                                <Table.Root size="sm">
                                                    <Table.Header>
                                                        <Table.Row>
                                                            <Table.ColumnHeader fontSize="xs" width="80px">Event</Table.ColumnHeader>
                                                            <Table.ColumnHeader fontSize="xs">Asset</Table.ColumnHeader>
                                                            <Table.ColumnHeader fontSize="xs">Account</Table.ColumnHeader>
                                                            <Table.ColumnHeader fontSize="xs" textAlign="right">Qty Δ</Table.ColumnHeader>
                                                            <Table.ColumnHeader fontSize="xs" textAlign="right">Cost Δ</Table.ColumnHeader>
                                                            <Table.ColumnHeader fontSize="xs" textAlign="right">Remaining</Table.ColumnHeader>
                                                        </Table.Row>
                                                    </Table.Header>
                                                    <Table.Body>
                                                        {unitEvents.map((event, i) => (
                                                            <Table.Row key={event.event_id} bg={`${eventTypeColors[event.event_type] || 'gray'}.50`}>
                                                                <Table.Cell>
                                                                    <Badge size="xs" colorPalette={eventTypeColors[event.event_type] || 'gray'}>
                                                                        {event.event_type}
                                                                    </Badge>
                                                                </Table.Cell>
                                                                <Table.Cell fontSize="xs">
                                                                    <Badge size="xs">{event.asset?.name || '-'}</Badge>
                                                                </Table.Cell>
                                                                <Table.Cell fontSize="xs" color="gray.600">
                                                                    {event.account_name || '-'}
                                                                </Table.Cell>
                                                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                                                    <Text color={event.quantity_delta >= 0 ? 'green.600' : 'red.600'}>
                                                                        {event.quantity_delta >= 0 ? '+' : ''}{formatQty(event.quantity_delta)}
                                                                    </Text>
                                                                </Table.Cell>
                                                                <Table.Cell fontSize="xs" textAlign="right">
                                                                    {event.cost_basis_delta != null ? (
                                                                        <Text color={event.cost_basis_delta >= 0 ? 'green.600' : 'red.600'}>
                                                                            {event.cost_basis_delta >= 0 ? '+' : ''}{formatCurrency(event.cost_basis_delta, baseCurrency)}
                                                                        </Text>
                                                                    ) : '-'}
                                                                </Table.Cell>
                                                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                                                    {formatQty(event.qty_remaining_after)}
                                                                </Table.Cell>
                                                            </Table.Row>
                                                        ))}
                                                    </Table.Body>
                                                </Table.Root>
                                            </Box>
                                        ) : (
                                            <Text fontSize="xs" color="gray.400">No lot events for this unit</Text>
                                        )}
                                    </>
                                );
                            })()}
                        </Card.Body>
                    </Card.Root>

                    {/* P&L Card */}
                    <Card.Root size="sm" variant="outline" flex="1" minW="280px">
                        <Card.Body p={3}>
                            <Text fontSize="xs" fontWeight="bold" color="green.600" mb={2}>
                                💰 Realized P&L ({unit.realized_entries?.length || unit.realized_entry_count || 0})
                            </Text>
                            {unit.realized_entries && unit.realized_entries.length > 0 ? (
                                <Table.Root size="sm">
                                    <Table.Header>
                                        <Table.Row>
                                            <Table.ColumnHeader fontSize="xs">Asset</Table.ColumnHeader>
                                            <Table.ColumnHeader fontSize="xs" textAlign="right">FMV</Table.ColumnHeader>
                                            <Table.ColumnHeader fontSize="xs" textAlign="right">Cost</Table.ColumnHeader>
                                            <Table.ColumnHeader fontSize="xs" textAlign="right">P&L</Table.ColumnHeader>
                                            <Table.ColumnHeader fontSize="xs" textAlign="center">Type</Table.ColumnHeader>
                                        </Table.Row>
                                    </Table.Header>
                                    <Table.Body>
                                        {unit.realized_entries.map((entry, i) => (
                                            <Table.Row key={i} bg={entry.is_fee ? 'orange.50' : undefined}>
                                                <Table.Cell fontSize="xs">
                                                    <Badge size="xs">{entry.asset.name || `#${entry.asset.id}`}</Badge>
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="right">
                                                    {formatCurrency(entry.proceeds_in_base, baseCurrency)}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="right">
                                                    {formatCurrency(entry.cost_basis_in_base, baseCurrency)}
                                                </Table.Cell>
                                                <Table.Cell
                                                    fontSize="xs"
                                                    textAlign="right"
                                                    color={entry.pnl_in_base >= 0 ? 'green.600' : 'red.600'}
                                                    fontWeight="bold"
                                                >
                                                    {formatCurrency(entry.pnl_in_base, baseCurrency)}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="center">
                                                    {entry.is_fee ? (
                                                        <Badge size="xs" colorPalette="orange">Fee</Badge>
                                                    ) : (
                                                        <Badge size="xs" colorPalette="blue">Disposal</Badge>
                                                    )}
                                                </Table.Cell>
                                            </Table.Row>
                                        ))}
                                    </Table.Body>
                                </Table.Root>
                            ) : (
                                <Text fontSize="xs" color="gray.400">No realized P&L</Text>
                            )}
                        </Card.Body>
                    </Card.Root>

                    {/* Warnings Card - Separate */}
                    {(unit.warnings && unit.warnings.length > 0) && (
                        <Card.Root size="sm" variant="outline" flex="1" minW="280px" borderColor="orange.200" bg="orange.50">
                            <Card.Body p={3}>
                                <Text fontSize="xs" fontWeight="bold" color="orange.600" mb={2}>
                                    <FiAlertTriangle style={{ display: 'inline', marginRight: 4 }} />
                                    Warnings ({unit.warnings.length})
                                </Text>
                                {unit.warnings.map((w, i) => (
                                    <Box key={i} bg="white" p={2} borderRadius="sm" mb={1} borderLeft="3px solid" borderColor="orange.400">
                                        <Text fontSize="xs" color="orange.800" fontWeight="medium">{w.warning_type}</Text>
                                        <Text fontSize="xs" color="gray.700">{w.message}</Text>
                                        {w.transaction_id && (
                                            <TransactionCell
                                                txId={w.transaction_id}
                                                baseCurrency={baseCurrency}
                                                onTransactionClick={onTransactionClick}
                                                prefix="View TX"
                                            />
                                        )}
                                    </Box>
                                ))}
                            </Card.Body>
                        </Card.Root>
                    )}
                </Flex>
            </Flex>
        </Box>
    );
};

// ============================================================================
// Calculation Units Tab (Enhanced)
// ============================================================================

export const UnitsTab: React.FC<{
    units: CalculationUnit[];
    baseCurrency: string;
    costLots: CostLot[];
    versionId?: number | null;
    onTransactionClick?: (txId: number) => void;
}> = ({ units, baseCurrency, costLots, versionId, onTransactionClick }) => {
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState<string>('all');
    const [expandedUnits, setExpandedUnits] = useState<Set<number>>(new Set());

    const types = useMemo(() => {
        const set = new Set(units.map(u => u.pattern || 'unknown'));
        return Array.from(set);
    }, [units]);

    const filtered = useMemo(() => {
        return units.filter(u => {
            if (typeFilter !== 'all' && (u.pattern || 'unknown') !== typeFilter) return false;
            if (search) {
                const s = search.toLowerCase();
                const outSymbols = (u.outflow_asset_symbols || []).join(' ').toLowerCase();
                const inSymbols = (u.inflow_asset_symbols || []).join(' ').toLowerCase();
                const label = (u.unit_label || '').toLowerCase();
                return outSymbols.includes(s) || inSymbols.includes(s) ||
                    label.includes(s) || u.unit_id.toString().includes(s);
            }
            return true;
        });
    }, [units, search, typeFilter]);

    const toggleExpand = (unitId: number) => {
        setExpandedUnits(prev => {
            const next = new Set(prev);
            if (next.has(unitId)) {
                next.delete(unitId);
            } else {
                next.add(unitId);
            }
            return next;
        });
    };

    return (
        <Box>
            {/* Filters only - no stats cards */}
            <Flex gap={2} mb={4} wrap="wrap">
                <Flex align="center" bg="gray.50" px={2} borderRadius="md" flex="1" maxW="300px">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search asset, label..."
                        size="sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        border="none"
                        _focus={{ boxShadow: 'none' }}
                    />
                </Flex>
                <Flex gap={1}>
                    <Button
                        size="xs"
                        variant={typeFilter === 'all' ? 'solid' : 'outline'}
                        onClick={() => setTypeFilter('all')}
                    >
                        All ({units.length})
                    </Button>
                    {types.map(type => (
                        <Button
                            key={type}
                            size="xs"
                            variant={typeFilter === type ? 'solid' : 'outline'}
                            onClick={() => setTypeFilter(type)}
                            textTransform="capitalize"
                        >
                            {type}
                        </Button>
                    ))}
                </Flex>
            </Flex>

            <Box overflowX="auto" style={{ fontSize: '8px' }}>
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader width="70px">Type</Table.ColumnHeader>
                            <Table.ColumnHeader width="80px">Date</Table.ColumnHeader>
                            <Table.ColumnHeader>Operation</Table.ColumnHeader>
                            <Table.ColumnHeader width="80px">Events</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right" width="90px">P&L</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right" width="80px">Fees</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="center" width="40px">⚠</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {filtered.slice(0, 200).map((unit) => {
                            // Generate operation label from unit_label or compose compact preview
                            // For transfers: "Account A → Account B: BTC"
                            // For trades: "−: BTC → +: USD"
                            // Generate operation label based on pattern type
                            // For trades/swaps: "−: BTC → +: USD" 
                            // For transfers: "⇄ BTC" with transfer indicator
                            const generateOperationDisplay = (): { mainLabel: string; subLabel?: string; icon: string } => {
                                const outSymbols = unit.outflow_asset_symbols || [];
                                const inSymbols = unit.inflow_asset_symbols || [];
                                const feeSymbols = unit.fee_asset_symbols || [];
                                const isTransfer = unit.pattern === 'transfer';
                                const isSwap = unit.pattern === 'swap';

                                // Format asset symbols for display
                                const formatAssets = (symbols: string[], max: number = 2): string => {
                                    if (!symbols.length) return '';
                                    const display = symbols.slice(0, max).join(', ');
                                    return symbols.length > max ? `${display}…` : display;
                                };

                                // If unit has a custom label, use it
                                if (unit.unit_label) {
                                    return { mainLabel: unit.unit_label, icon: isTransfer ? '⇄' : isSwap ? '↔' : '•' };
                                }

                                if (isTransfer) {
                                    // Transfer: show moved assets
                                    const assets = [...new Set([...outSymbols, ...inSymbols])];
                                    const assetLabel = formatAssets(assets) || 'assets';
                                    return {
                                        mainLabel: assetLabel,
                                        subLabel: 'moved between accounts',
                                        icon: '⇄'
                                    };
                                }

                                if (isSwap) {
                                    // Swap/Trade: show exchange "BTC → USD"
                                    const outPart = formatAssets(outSymbols);
                                    const inPart = formatAssets(inSymbols);
                                    const feePart = feeSymbols.length > 0 ? ` (fee: ${feeSymbols[0]})` : '';

                                    if (outPart && inPart) {
                                        return { mainLabel: `${outPart} → ${inPart}${feePart}`, icon: '↔' };
                                    } else if (outPart) {
                                        return { mainLabel: `Sell ${outPart}${feePart}`, icon: '↔' };
                                    } else if (inPart) {
                                        return { mainLabel: `Buy ${inPart}${feePart}`, icon: '↔' };
                                    }
                                }

                                // Default: generic format
                                const outPart = outSymbols.length ? `−${formatAssets(outSymbols)}` : '';
                                const inPart = inSymbols.length ? `+${formatAssets(inSymbols)}` : '';
                                const label = [outPart, inPart].filter(Boolean).join(' → ') || '—';
                                return { mainLabel: label, icon: '•' };
                            };

                            const { mainLabel, subLabel, icon } = generateOperationDisplay();
                            const warningCount = unit.warnings?.length || 0;
                            const txCount = unit.transaction_ids?.length || 0;
                            const isTransfer = unit.pattern === 'transfer';
                            const isSwap = unit.pattern === 'swap';
                            return (
                                <React.Fragment key={unit.unit_id}>
                                    <Table.Row onClick={() => toggleExpand(unit.unit_id)} style={{ cursor: 'pointer' }} _hover={{ bg: 'gray.50' }}>
                                        <Table.Cell>
                                            <Badge
                                                size="xs"
                                                colorPalette={
                                                    unit.pattern === 'swap' ? 'orange' :
                                                        unit.pattern === 'transfer' ? 'blue' : 'gray'
                                                }
                                            >
                                                {unit.pattern || 'unknown'}
                                            </Badge>
                                        </Table.Cell>
                                        <Table.Cell fontSize="xs">{formatDateLocale(unit.date)}</Table.Cell>
                                        {/* Operation Column: Icon + Label + Sub-label + Transactions */}
                                        <Table.Cell>
                                            <Flex direction="column" gap={0}>
                                                <Flex align="center" gap={1}>
                                                    <Text
                                                        fontSize="sm"
                                                        color={isTransfer ? 'blue.500' : isSwap ? 'orange.500' : 'gray.500'}
                                                        fontWeight="bold"
                                                    >
                                                        {icon}
                                                    </Text>
                                                    <Text fontSize="xs" fontWeight="medium">
                                                        {mainLabel}
                                                    </Text>
                                                </Flex>
                                                {subLabel && (
                                                    <Text fontSize="2xs" color="gray.500" ml={4}>
                                                        {subLabel}
                                                    </Text>
                                                )}
                                                {txCount > 0 && (
                                                    <Flex gap={1} wrap="wrap" mt={1}>
                                                        {(unit.transaction_ids || []).slice(0, 3).map(txId => (
                                                            <TransactionTooltip key={txId} txId={txId} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                                                <Badge
                                                                    size="xs"
                                                                    colorPalette="gray"
                                                                    variant="subtle"
                                                                    cursor="pointer"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        onTransactionClick?.(txId);
                                                                    }}
                                                                >
                                                                    TX#{txId}
                                                                </Badge>
                                                            </TransactionTooltip>
                                                        ))}
                                                        {txCount > 3 && (
                                                            <Text fontSize="2xs" color="gray.500">+{txCount - 3} more</Text>
                                                        )}
                                                    </Flex>
                                                )}
                                            </Flex>
                                        </Table.Cell>
                                        {/* Events count cell - uses event_ids from API (simple total count) */}
                                        <Table.Cell>
                                            {(() => {
                                                const eventCount = unit.event_ids?.length ?? 0;

                                                if (eventCount === 0) {
                                                    return <Text fontSize="2xs" color="gray.400">—</Text>;
                                                }

                                                return (
                                                    <Badge size="xs" colorPalette="blue">{eventCount}</Badge>
                                                );
                                            })()}
                                        </Table.Cell>
                                        <Table.Cell textAlign="right">
                                            <Text fontSize="sm" color={(unit.realized_pnl_in_base || 0) >= 0 ? 'green.600' : 'red.600'} fontWeight="medium">
                                                {formatCurrency(unit.realized_pnl_in_base || 0, baseCurrency)}
                                            </Text>
                                        </Table.Cell>
                                        <Table.Cell textAlign="right">
                                            {(unit.has_fees || unit.fee_count) ? (
                                                <Text fontSize="sm" color="orange.600">
                                                    {formatCurrency(unit.total_fees_in_base || 0, baseCurrency)}
                                                </Text>
                                            ) : (
                                                <Text fontSize="xs" color="gray.400">-</Text>
                                            )}
                                        </Table.Cell>
                                        <Table.Cell textAlign="center">
                                            {warningCount > 0 ? (
                                                <Badge size="sm" colorPalette="orange">
                                                    <FiAlertTriangle style={{ marginRight: 2 }} />
                                                    {warningCount}
                                                </Badge>
                                            ) : (
                                                <Text fontSize="xs" color="gray.400">-</Text>
                                            )}
                                        </Table.Cell>
                                    </Table.Row>
                                    {expandedUnits.has(unit.unit_id) && (
                                        <Table.Row>
                                            <Table.Cell colSpan={7} style={{ background: '#f9fafb', padding: 0 }}>
                                                <UnitDetailRow unit={unit} baseCurrency={baseCurrency} costLots={costLots} versionId={versionId} onTransactionClick={onTransactionClick} />
                                            </Table.Cell>
                                        </Table.Row>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </Table.Body>
                </Table.Root>
            </Box>
            {filtered.length > 200 && (
                <Text fontSize="sm" color="gray.500" mt={2} textAlign="center">
                    Showing first 200 of {filtered.length} units
                </Text>
            )}
        </Box>
    );
};

// ============================================================================
// Cost Lots Tab - Shows inventory of existing cost lots
// ============================================================================

const CostLotsTab: React.FC<{
    lots: CostLot[];
    consumedSlices?: ConsumedSliceDetail[];
    settlements?: Settlement[];
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}> = ({ lots, baseCurrency, onTransactionClick }) => {
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'exhausted' | 'negative'>('all');

    const filtered = useMemo(() => {
        return lots.filter(lot => {
            // Status filter
            const isNegative = lot.unit_cost_in_base < 0 || lot.total_cost_in_base < 0 || lot.qty_remaining < 0;
            const isExhausted = lot.qty_remaining === 0;

            if (statusFilter === 'negative' && !isNegative) return false;
            if (statusFilter === 'open' && (isExhausted || isNegative)) return false;
            if (statusFilter === 'exhausted' && (!isExhausted || isNegative)) return false;

            // Search filter
            if (search) {
                const s = search.toLowerCase();
                const symbol = lot.asset?.name ?? lot.asset_symbol ?? '';
                return symbol.toLowerCase().includes(s) ||
                    String(lot.cost_lot_id).includes(s) ||
                    (lot.account_name || '').toLowerCase().includes(s);
            }
            return true;
        });
    }, [lots, search, statusFilter]);

    const sorted = useMemo(() => {
        return [...filtered].sort((a, b) =>
            new Date(b.acquired_at).getTime() - new Date(a.acquired_at).getTime()
        );
    }, [filtered]);

    const stats = useMemo(() => {
        const negativeLots = lots.filter(l => l.unit_cost_in_base < 0 || l.total_cost_in_base < 0 || l.qty_remaining < 0);
        const openLots = lots.filter(l => l.qty_remaining > 0 && l.unit_cost_in_base >= 0 && l.total_cost_in_base >= 0);
        const exhaustedLots = lots.filter(l => l.qty_remaining === 0 && l.unit_cost_in_base >= 0 && l.total_cost_in_base >= 0);
        const totalCostBasis = openLots.reduce((sum, l) => sum + (l.qty_remaining * l.unit_cost_in_base), 0);
        return {
            total: lots.length,
            open: openLots.length,
            exhausted: exhaustedLots.length,
            negative: negativeLots.length,
            totalCostBasis,
        };
    }, [lots]);

    return (
        <Box>
            {/* Filters */}
            <Flex gap={2} mb={4} wrap="wrap" align="center">
                <Flex align="center" bg="gray.50" px={2} borderRadius="md" flex="1" maxW="300px">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search asset, lot UUID..."
                        size="sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        border="none"
                        _focus={{ boxShadow: 'none' }}
                    />
                </Flex>
                <Flex gap={1}>
                    <Button
                        size="xs"
                        variant={statusFilter === 'all' ? 'solid' : 'outline'}
                        onClick={() => setStatusFilter('all')}
                    >
                        All ({stats.total})
                    </Button>
                    <Button
                        size="xs"
                        variant={statusFilter === 'open' ? 'solid' : 'outline'}
                        colorPalette="green"
                        onClick={() => setStatusFilter('open')}
                    >
                        Open ({stats.open})
                    </Button>
                    <Button
                        size="xs"
                        variant={statusFilter === 'exhausted' ? 'solid' : 'outline'}
                        colorPalette="gray"
                        onClick={() => setStatusFilter('exhausted')}
                    >
                        Exhausted ({stats.exhausted})
                    </Button>
                    {stats.negative > 0 && (
                        <Button
                            size="xs"
                            variant={statusFilter === 'negative' ? 'solid' : 'outline'}
                            colorPalette="red"
                            onClick={() => setStatusFilter('negative')}
                        >
                            Negative ({stats.negative})
                        </Button>
                    )}
                </Flex>
            </Flex>

            {/* Summary */}
            <Flex gap={4} mb={3} fontSize="sm" color="gray.600">
                <Text>
                    <Badge size="sm" colorPalette="green" mr={1}>Open</Badge>
                    {formatCurrency(stats.totalCostBasis, baseCurrency)} total cost basis
                </Text>
            </Flex>

            {/* Table */}
            <Box overflowX="auto" style={{ fontSize: '8px' }}>
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader width="80px">Status</Table.ColumnHeader>
                            <Table.ColumnHeader>Asset</Table.ColumnHeader>
                            <Table.ColumnHeader width="100px">Acquired</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Qty Original</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Qty Remaining</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Unit Cost</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Total Cost</Table.ColumnHeader>
                            <Table.ColumnHeader>Account</Table.ColumnHeader>
                            <Table.ColumnHeader>Origin TX</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {sorted.slice(0, 300).map((lot) => {
                            const isNegative = lot.unit_cost_in_base < 0 || lot.total_cost_in_base < 0 || lot.qty_remaining < 0;
                            const isExhausted = lot.qty_remaining === 0;
                            const pctRemaining = lot.qty_original > 0 ? (lot.qty_remaining / lot.qty_original) * 100 : 0;

                            return (
                                <Table.Row
                                    key={lot.cost_lot_id}
                                    bg={isNegative ? 'red.50' : isExhausted ? 'gray.50' : undefined}
                                >
                                    <Table.Cell>
                                        <Flex direction="column" gap={1}>
                                            <Badge
                                                size="xs"
                                                colorPalette={isNegative ? 'red' : isExhausted ? 'gray' : 'green'}
                                            >
                                                {isNegative ? '⚠ Negative' : isExhausted ? 'Exhausted' : 'Open'}
                                            </Badge>
                                            {!isExhausted && !isNegative && pctRemaining < 100 && (
                                                <Text fontSize="2xs" color="gray.500">{pctRemaining.toFixed(0)}% left</Text>
                                            )}
                                        </Flex>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Badge size="xs">{lot.asset?.name ?? lot.asset_symbol ?? `#${lot.asset_id}`}</Badge>
                                    </Table.Cell>
                                    <Table.Cell fontSize="xs">{formatDateLocale(lot.acquired_at)}</Table.Cell>
                                    <Table.Cell textAlign="right" fontFamily="mono" fontSize="xs">
                                        {formatQty(lot.qty_original)}
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontFamily="mono" fontSize="xs">
                                        <Text color={isExhausted ? 'gray.400' : undefined}>
                                            {formatQty(lot.qty_remaining)}
                                        </Text>
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontSize="xs">
                                        {lot.is_zero_cost ? (
                                            <Badge size="xs" colorPalette="purple">Zero</Badge>
                                        ) : (
                                            <Text color={isNegative ? 'red.600' : undefined}>
                                                {formatCurrency(lot.unit_cost_in_base, baseCurrency)}
                                            </Text>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontSize="xs">
                                        {lot.is_zero_cost ? (
                                            <Badge size="xs" colorPalette="purple">Zero</Badge>
                                        ) : (
                                            <Text color={isNegative ? 'red.600' : undefined}>
                                                {formatCurrency(lot.total_cost_in_base, baseCurrency)}
                                            </Text>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell fontSize="xs">{lot.account_name || '-'}</Table.Cell>
                                    <Table.Cell>
                                        {lot.origin_transaction_id ? (
                                            <TransactionCell
                                                txId={lot.origin_transaction_id}
                                                baseCurrency={baseCurrency}
                                                onTransactionClick={onTransactionClick}
                                                prefix=""
                                                size="xs"
                                            />
                                        ) : (
                                            <Text fontSize="xs" color="gray.400">-</Text>
                                        )}
                                    </Table.Cell>
                                </Table.Row>
                            );
                        })}
                    </Table.Body>
                </Table.Root>
            </Box>
            {sorted.length > 300 && (
                <Text fontSize="sm" color="gray.500" mt={2} textAlign="center">
                    Showing first 300 of {sorted.length} lots
                </Text>
            )}
        </Box>
    );
};

// ============================================================================
// Cost Lot Events Tab - Shows raw events from backend CostLotEventEntry
// ============================================================================

export const CostLotEventsTab: React.FC<{
    events: CostLotEventEntry[];
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}> = ({ events, baseCurrency, onTransactionClick }) => {
    const [search, setSearch] = useState('');
    const [eventTypeFilter, setEventTypeFilter] = useState<'all' | 'created' | 'consumed' | 'adjusted'>('all');

    const filtered = useMemo(() => {
        return events.filter(event => {
            if (eventTypeFilter !== 'all' && event.event_type !== eventTypeFilter) return false;
            if (search) {
                const s = search.toLowerCase();
                return String(event.lot_id).includes(s) ||
                    (event.asset?.name || '').toLowerCase().includes(s);
            }
            return true;
        });
    }, [events, search, eventTypeFilter]);

    const sorted = useMemo(() => {
        return [...filtered].sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
    }, [filtered]);

    const stats = useMemo(() => {
        const createdCount = events.filter(e => e.event_type === 'created').length;
        const consumedCount = events.filter(e => e.event_type === 'consumed').length;
        const adjustedCount = events.filter(e => e.event_type === 'adjusted').length;
        const totalQtyDelta = events.reduce((sum, e) => sum + e.quantity_delta, 0);
        const totalCostDelta = events.reduce((sum, e) => sum + (e.cost_basis_delta ?? 0), 0);
        return { createdCount, consumedCount, adjustedCount, totalQtyDelta, totalCostDelta };
    }, [events]);

    // Handle empty events case
    if (events.length === 0) {
        return (
            <Box p={4}>
                <Flex
                    direction="column"
                    align="center"
                    justify="center"
                    py={12}
                    px={4}
                    bg="gray.50"
                    borderRadius="md"
                    minH="200px"
                >
                    <FiActivity size={48} color="gray" />
                    <Text fontSize="lg" fontWeight="medium" color="gray.600" mt={4} mb={2}>
                        No Cost Lot Events
                    </Text>
                    <Text fontSize="sm" color="gray.500" textAlign="center">
                        Cost lot events will appear here after P&L calculation.
                        Events track lot creation, consumption, and settlements.
                    </Text>
                </Flex>
            </Box>
        );
    }

    return (
        <Box p={4}>
            {/* Filters */}
            <Flex gap={2} mb={4} wrap="wrap" align="center">
                <Flex align="center" bg="gray.50" px={2} borderRadius="md" flex="1" maxW="250px">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search lot, asset..."
                        size="sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        border="none"
                        _focus={{ boxShadow: 'none' }}
                    />
                </Flex>

                <Flex gap={1}>
                    <Button
                        size="xs"
                        variant={eventTypeFilter === 'all' ? 'solid' : 'outline'}
                        onClick={() => setEventTypeFilter('all')}
                    >
                        All ({events.length})
                    </Button>
                    <Button
                        size="xs"
                        variant={eventTypeFilter === 'created' ? 'solid' : 'outline'}
                        colorPalette="green"
                        onClick={() => setEventTypeFilter('created')}
                    >
                        Created ({stats.createdCount})
                    </Button>
                    <Button
                        size="xs"
                        variant={eventTypeFilter === 'consumed' ? 'solid' : 'outline'}
                        colorPalette="orange"
                        onClick={() => setEventTypeFilter('consumed')}
                    >
                        Consumed ({stats.consumedCount})
                    </Button>
                    {stats.adjustedCount > 0 && (
                        <Button
                            size="xs"
                            variant={eventTypeFilter === 'adjusted' ? 'solid' : 'outline'}
                            colorPalette="blue"
                            onClick={() => setEventTypeFilter('adjusted')}
                        >
                            Adjusted ({stats.adjustedCount})
                        </Button>
                    )}
                </Flex>
            </Flex>

            {/* Summary */}
            <Flex gap={4} mb={3} fontSize="sm" color="gray.600" wrap="wrap">
                <Text>
                    Total qty delta: <Text as="span" fontWeight="bold">{formatQty(stats.totalQtyDelta)}</Text>
                </Text>
                <Text>
                    Total cost delta: <Text as="span" fontWeight="bold">{formatCurrency(stats.totalCostDelta, baseCurrency)}</Text>
                </Text>
            </Flex>

            <Box overflowX="auto" style={{ fontSize: '8px' }}>
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader width="50px">Type</Table.ColumnHeader>
                            <Table.ColumnHeader>Timestamp</Table.ColumnHeader>
                            <Table.ColumnHeader>Asset</Table.ColumnHeader>
                            <Table.ColumnHeader>Account</Table.ColumnHeader>
                            <Table.ColumnHeader>Lot ID</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Qty Delta</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Cost Delta</Table.ColumnHeader>
                            <Table.ColumnHeader>Triggered By</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {sorted.slice(0, 300).map((event) => (
                            <Table.Row
                                key={event.event_id}
                                bg={
                                    event.event_type === 'created' ? 'green.50' :
                                        event.event_type === 'consumed' ? 'orange.50' :
                                            event.event_type === 'adjusted' ? 'blue.50' : undefined
                                }
                            >
                                <Table.Cell>
                                    <Badge
                                        size="xs"
                                        colorPalette={
                                            event.event_type === 'created' ? 'green' :
                                                event.event_type === 'consumed' ? 'orange' : 'blue'
                                        }
                                    >
                                        {event.event_type === 'created' ? '+' :
                                            event.event_type === 'consumed' ? '−' : '⟳'}
                                    </Badge>
                                </Table.Cell>
                                <Table.Cell fontSize="xs">{formatDateLocale(event.timestamp)}</Table.Cell>
                                <Table.Cell>
                                    <Badge size="xs">{event.asset?.name || '?'}</Badge>
                                </Table.Cell>
                                <Table.Cell fontSize="xs" color="gray.600">
                                    {event.account_name || '-'}
                                </Table.Cell>
                                <Table.Cell fontSize="2xs" fontFamily="mono" color="gray.500">
                                    #{event.lot_id}
                                </Table.Cell>
                                <Table.Cell textAlign="right" fontFamily="mono" fontSize="xs">
                                    <Text color={event.quantity_delta >= 0 ? 'green.600' : 'red.600'}>
                                        {event.quantity_delta >= 0 ? '+' : ''}{formatQty(event.quantity_delta)}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell textAlign="right" fontSize="xs">
                                    <Text color={(event.cost_basis_delta ?? 0) >= 0 ? 'green.600' : 'red.600'}>
                                        {(event.cost_basis_delta ?? 0) >= 0 ? '+' : ''}{formatCurrency(event.cost_basis_delta ?? 0, baseCurrency)}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell fontSize="xs">
                                    {event.triggered_by_unit_id ? (
                                        <Text fontSize="2xs" color="blue.600">
                                            📐 {event.triggered_by_unit_label || `Unit ${event.triggered_by_unit_id}`}
                                        </Text>
                                    ) : event.triggered_by_transaction_id ? (
                                        <TransactionTooltip txId={event.triggered_by_transaction_id} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                            <Button
                                                size="xs"
                                                variant="ghost"
                                                p={0}
                                                h="auto"
                                                minW="auto"
                                                fontWeight="medium"
                                                color="blue.600"
                                                fontSize="2xs"
                                                onClick={(e) => { e.stopPropagation(); onTransactionClick?.(event.triggered_by_transaction_id!); }}
                                            >
                                                TX #{event.triggered_by_transaction_id}
                                            </Button>
                                        </TransactionTooltip>
                                    ) : (
                                        <Text fontSize="2xs" color="gray.400">—</Text>
                                    )}
                                </Table.Cell>
                            </Table.Row>
                        ))}
                    </Table.Body>
                </Table.Root>
            </Box>
            {sorted.length > 300 && (
                <Text fontSize="sm" color="gray.500" mt={2} textAlign="center">
                    Showing first 300 of {sorted.length} events
                </Text>
            )}
        </Box>
    );
};

// ============================================================================
// Realized P&L Tab - Shows disposal events with price, origin TX, warnings
// ============================================================================

const RealizedPnLTab: React.FC<{
    entries: RealizedPnLRow[];
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}> = ({ entries, baseCurrency, onTransactionClick }) => {
    const [search, setSearch] = useState('');
    const [taxableFilter, setTaxableFilter] = useState<'all' | 'taxable' | 'non-taxable'>('all');

    const filtered = useMemo(() => {
        return entries.filter(e => {
            if (taxableFilter === 'taxable' && !e.disposal_taxable) return false;
            if (taxableFilter === 'non-taxable' && e.disposal_taxable) return false;
            if (search) {
                const s = search.toLowerCase();
                const symbol = e.asset?.name ?? e.asset_symbol ?? '';
                return symbol.toLowerCase().includes(s);
            }
            return true;
        });
    }, [entries, search, taxableFilter]);

    const sorted = useMemo(() => {
        return [...filtered].sort((a, b) =>
            new Date(b.realized_at).getTime() - new Date(a.realized_at).getTime()
        );
    }, [filtered]);

    const stats = useMemo(() => {
        const totalPnL = entries.reduce((sum, e) => sum + e.pnl_in_base, 0);
        const taxablePnL = entries.filter(e => e.disposal_taxable).reduce((sum, e) => sum + e.pnl_in_base, 0);
        const nonTaxablePnL = entries.filter(e => !e.disposal_taxable).reduce((sum, e) => sum + e.pnl_in_base, 0);
        const taxableCount = entries.filter(e => e.disposal_taxable).length;
        const nonTaxableCount = entries.filter(e => !e.disposal_taxable).length;
        const withWarnings = entries.filter(e => e.warnings && e.warnings.length > 0).length;
        return { totalPnL, taxablePnL, nonTaxablePnL, taxableCount, nonTaxableCount, withWarnings };
    }, [entries]);

    return (
        <Box>
            {/* Filters */}
            <Flex gap={2} mb={4} wrap="wrap" align="center">
                <Flex align="center" bg="gray.50" px={2} borderRadius="md" flex="1" maxW="300px">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search asset..."
                        size="sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        border="none"
                        _focus={{ boxShadow: 'none' }}
                    />
                </Flex>
                <Flex gap={1}>
                    <Button
                        size="xs"
                        variant={taxableFilter === 'all' ? 'solid' : 'outline'}
                        onClick={() => setTaxableFilter('all')}
                    >
                        All ({entries.length})
                    </Button>
                    <Button
                        size="xs"
                        variant={taxableFilter === 'taxable' ? 'solid' : 'outline'}
                        colorPalette="red"
                        onClick={() => setTaxableFilter('taxable')}
                    >
                        Taxable ({stats.taxableCount})
                    </Button>
                    <Button
                        size="xs"
                        variant={taxableFilter === 'non-taxable' ? 'solid' : 'outline'}
                        colorPalette="green"
                        onClick={() => setTaxableFilter('non-taxable')}
                    >
                        Non-taxable ({stats.nonTaxableCount})
                    </Button>
                </Flex>
                <Flex gap={4} ml="auto">
                    <Text fontSize="sm" color="gray.500">
                        Total P&L: <strong style={{ color: stats.totalPnL >= 0 ? 'green' : 'red' }}>{formatCurrency(stats.totalPnL, baseCurrency)}</strong>
                    </Text>
                    <Text fontSize="sm" color="gray.500">
                        Taxable: <strong style={{ color: stats.taxablePnL >= 0 ? 'green' : 'red' }}>{formatCurrency(stats.taxablePnL, baseCurrency)}</strong>
                    </Text>
                </Flex>
            </Flex>

            <Box overflowX="auto">
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader>Date</Table.ColumnHeader>
                            <Table.ColumnHeader>Asset</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Qty</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">FMV Price</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Proceeds</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Cost Basis</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">P&L</Table.ColumnHeader>
                            <Table.ColumnHeader>Taxable</Table.ColumnHeader>
                            <Table.ColumnHeader>Origin TX</Table.ColumnHeader>
                            <Table.ColumnHeader>⚠</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {sorted.slice(0, 200).map((entry) => {
                            // Compute FMV price and source display
                            const fmvPrice = entry.proceeds_price != null
                                ? entry.proceeds_price
                                : entry.disposal_price_in_base
                                    ? entry.disposal_price_in_base
                                    : entry.qty > 0
                                        ? entry.proceeds_in_base / entry.qty
                                        : null;

                            const sourceLabel = entry.proceeds_source === 'fmv_lookup'
                                ? (entry.proceeds_price_source || 'FMV')
                                : entry.proceeds_source === 'base_currency'
                                    ? 'base'
                                    : entry.proceeds_source === 'transfer'
                                        ? 'transfer'
                                        : null;

                            const sourceColor = entry.proceeds_source === 'fmv_lookup'
                                ? 'blue'
                                : entry.proceeds_source === 'base_currency'
                                    ? 'green'
                                    : 'gray';

                            return (
                                <Table.Row
                                    key={entry.id}
                                    bg={entry.warnings && entry.warnings.length > 0 ? 'orange.50' : undefined}
                                >
                                    <Table.Cell fontSize="sm">{formatDateLocale(entry.realized_at)}</Table.Cell>
                                    <Table.Cell>
                                        <Badge size="sm">{entry.asset_symbol}</Badge>
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontFamily="mono" fontSize="sm">
                                        {formatQty(entry.qty)}
                                    </Table.Cell>
                                    {/* Combined FMV Price & Source column */}
                                    <Table.Cell textAlign="right" fontSize="sm">
                                        <Flex direction="column" align="flex-end" gap={0}>
                                            <Text>{fmvPrice != null ? formatCurrency(fmvPrice, baseCurrency) : '-'}</Text>
                                            {sourceLabel && (
                                                <Badge size="xs" colorPalette={sourceColor} variant="subtle">
                                                    {sourceLabel}
                                                </Badge>
                                            )}
                                        </Flex>
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontSize="sm">
                                        {formatCurrency(entry.proceeds_in_base, baseCurrency)}
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontSize="sm">
                                        {formatCurrency(entry.cost_basis_in_base, baseCurrency)}
                                    </Table.Cell>
                                    <Table.Cell
                                        textAlign="right"
                                        fontWeight="bold"
                                        color={entry.pnl_in_base >= 0 ? 'green.600' : 'red.600'}
                                    >
                                        {formatCurrency(entry.pnl_in_base, baseCurrency)}
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Badge colorPalette={entry.disposal_taxable ? 'red' : 'green'} size="sm">
                                            {entry.disposal_taxable ? 'Yes' : 'No'}
                                        </Badge>
                                    </Table.Cell>
                                    <Table.Cell>
                                        {entry.transaction_id ? (
                                            <Flex direction="column" gap={0}>
                                                <TransactionCell
                                                    txId={entry.transaction_id}
                                                    baseCurrency={baseCurrency}
                                                    onTransactionClick={onTransactionClick}
                                                />
                                                {(entry.origin_tx_type || entry.origin_tx_source) && (
                                                    <Text fontSize="xs" color="gray.500" pl={1}>
                                                        {entry.origin_tx_type}{entry.origin_tx_source ? ` • ${entry.origin_tx_source}` : ''}
                                                    </Text>
                                                )}
                                            </Flex>
                                        ) : (
                                            <Text fontSize="xs" color="gray.400">-</Text>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell>
                                        {entry.warnings && entry.warnings.length > 0 && (
                                            <Badge colorPalette="orange" size="sm" title={entry.warnings.map(w => w.message).join(', ')}>
                                                {entry.warnings.length}
                                            </Badge>
                                        )}
                                    </Table.Cell>
                                </Table.Row>
                            );
                        })}
                    </Table.Body>
                </Table.Root>
            </Box>
            {sorted.length > 200 && (
                <Text fontSize="sm" color="gray.500" mt={2} textAlign="center">
                    Showing first 200 of {sorted.length} entries
                </Text>
            )}
        </Box>
    );
};

// ============================================================================
// Fees Tab - Shows fees with traceability
// ============================================================================

const FeesTab: React.FC<{
    fees: FeeEntry[];
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
}> = ({ fees, baseCurrency, onTransactionClick, onUnitClick }) => {
    const [search, setSearch] = useState('');
    const [sourceFilter, setSourceFilter] = useState<string>('all');

    // Sort fees by date descending (most recent first)
    const sortedFees = useMemo(() => {
        return [...fees].sort((a, b) => {
            const da = new Date(a.date || 0).getTime();
            const db = new Date(b.date || 0).getTime();
            return db - da;
        });
    }, [fees]);

    // Unique sources for filtering
    const sources = useMemo(() => {
        const set = new Set(sortedFees.map(f => f.source));
        return Array.from(set);
    }, [sortedFees]);

    const filtered = useMemo(() => {
        return sortedFees.filter(fee => {
            if (search && !fee.asset_symbol.toLowerCase().includes(search.toLowerCase())) {
                return false;
            }
            if (sourceFilter !== 'all' && fee.source !== sourceFilter) {
                return false;
            }
            return true;
        });
    }, [sortedFees, search, sourceFilter]);

    const sourceCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        fees.forEach(f => {
            counts[f.source] = (counts[f.source] || 0) + 1;
        });
        return counts;
    }, [fees]);

    // Aggregate totals
    const totalFees = useMemo(() => {
        return fees.reduce((sum, f) => sum + (f.fee_in_base || 0), 0);
    }, [fees]);

    if (fees.length === 0) {
        return (
            <Box textAlign="center" py={8}>
                <Text color="gray.500" fontWeight="bold">No fees recorded</Text>
                <Text fontSize="sm" color="gray.400">Fee entries will appear here after calculation</Text>
            </Box>
        );
    }

    return (
        <Box>
            {/* Summary */}
            <Flex gap={4} mb={4} wrap="wrap">
                <Card.Root flex="1" minW="150px">
                    <Card.Body py={2}>
                        <Text fontSize="xs" color="gray.500">Total Fees</Text>
                        <Text fontSize="lg" fontWeight="bold">
                            {formatCurrency(totalFees, baseCurrency)}
                        </Text>
                    </Card.Body>
                </Card.Root>
                <Card.Root flex="1" minW="150px">
                    <Card.Body py={2}>
                        <Text fontSize="xs" color="gray.500">Fee Entries</Text>
                        <Text fontSize="lg" fontWeight="bold">{fees.length}</Text>
                    </Card.Body>
                </Card.Root>
            </Flex>

            {/* Filters */}
            <Flex gap={2} mb={4} wrap="wrap" align="center">
                <Box position="relative" flex="1" maxW="200px">
                    <Input
                        placeholder="Search asset..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        size="sm"
                        pl={8}
                    />
                    <Box position="absolute" left={2} top="50%" transform="translateY(-50%)">
                        <FiSearch size={14} color="gray" />
                    </Box>
                </Box>
                <Button
                    size="xs"
                    variant={sourceFilter === 'all' ? 'solid' : 'outline'}
                    colorPalette="purple"
                    onClick={() => setSourceFilter('all')}
                >
                    All ({fees.length})
                </Button>
                {sources.map(src => (
                    <Button
                        key={src}
                        size="xs"
                        variant={sourceFilter === src ? 'solid' : 'outline'}
                        colorPalette="purple"
                        onClick={() => setSourceFilter(src)}
                    >
                        {src} ({sourceCounts[src]})
                    </Button>
                ))}
            </Flex>

            {/* Table */}
            <Box overflowX="auto">
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader width="100px">Date</Table.ColumnHeader>
                            <Table.ColumnHeader width="80px">Source</Table.ColumnHeader>
                            <Table.ColumnHeader width="70px">Asset</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Fee Qty</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Fee Value</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Cost Basis</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Realized P&L</Table.ColumnHeader>
                            <Table.ColumnHeader>Transaction</Table.ColumnHeader>
                            <Table.ColumnHeader width="60px">Unit</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {filtered.slice(0, 200).map((fee) => (
                            <Table.Row key={fee.id}>
                                <Table.Cell>
                                    <Text fontSize="2xs" color="gray.600">
                                        {fee.date ? formatDateLocale(fee.date) : '-'}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell>
                                    <Badge size="xs" variant="subtle">{fee.source}</Badge>
                                </Table.Cell>
                                <Table.Cell>
                                    <Badge size="xs">{fee.asset_symbol}</Badge>
                                </Table.Cell>
                                <Table.Cell textAlign="right">
                                    <Text fontSize="xs" fontFamily="mono">
                                        {formatQty(fee.fee_amount)}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell textAlign="right">
                                    <Text fontSize="xs">
                                        {formatCurrency(fee.fee_in_base, baseCurrency)}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell textAlign="right">
                                    <Text fontSize="xs" color="gray.600">
                                        {fee.cost_basis_consumed != null
                                            ? formatCurrency(fee.cost_basis_consumed, baseCurrency)
                                            : '-'}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell textAlign="right">
                                    {fee.realized_pnl != null ? (
                                        <Text
                                            fontSize="xs"
                                            color={fee.realized_pnl >= 0 ? 'green.600' : 'red.600'}
                                        >
                                            {formatCurrency(fee.realized_pnl, baseCurrency)}
                                        </Text>
                                    ) : (
                                        <Text fontSize="xs" color="gray.400">-</Text>
                                    )}
                                </Table.Cell>
                                <Table.Cell>
                                    {fee.transaction_id ? (
                                        <TransactionCell
                                            txId={fee.transaction_id}
                                            baseCurrency={baseCurrency}
                                            onTransactionClick={onTransactionClick}
                                            prefix=""
                                            size="xs"
                                        />
                                    ) : (
                                        <Text fontSize="xs" color="gray.400">-</Text>
                                    )}
                                </Table.Cell>
                                <Table.Cell>
                                    {fee.unit_id ? (
                                        <Text
                                            fontSize="xs"
                                            color="blue.600"
                                            cursor="pointer"
                                            _hover={{ textDecoration: 'underline' }}
                                            onClick={() => onUnitClick?.(fee.unit_id!)}
                                        >
                                            #{fee.unit_id}
                                        </Text>
                                    ) : (
                                        <Text fontSize="xs" color="gray.400">-</Text>
                                    )}
                                </Table.Cell>
                            </Table.Row>
                        ))}
                    </Table.Body>
                </Table.Root>
            </Box>
            {filtered.length > 200 && (
                <Text fontSize="xs" color="gray.500" mt={2} textAlign="center">
                    Showing first 200 of {filtered.length} entries
                </Text>
            )}
        </Box>
    );
};

// ============================================================================
// Warnings Tab - Shows warnings ordered by date with transaction hover details
// ============================================================================

const WarningsTab: React.FC<{
    warnings: PnLWarningItem[];
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    // Manual price entry support
    quoteAssetId?: number;
    onPriceAdded?: (assetId: number, warningId: string) => void;
    assets?: Array<{ id: number; name: string }>;
}> = ({ warnings, baseCurrency, onTransactionClick, quoteAssetId, onPriceAdded, assets }) => {
    const [typeFilter, setTypeFilter] = useState<string>('all');

    // State for manual price dialog
    const [dialogOpen, setDialogOpen] = useState(false);
    const [selectedWarning, setSelectedWarning] = useState<PnLWarningItem | null>(null);

    // Check if warning is a price-related warning
    const isPriceWarning = (warning: PnLWarningItem) =>
        (warning.warning_type === 'missing_price' || warning.warning_type === 'stale_price') &&
        warning.asset_id != null;

    // Get asset name from assets list or fallback
    const getAssetName = (assetId: number) => {
        const asset = assets?.find(a => a.id === assetId);
        return asset?.name || `Asset #${assetId}`;
    };

    // Get default date from warning details
    const getDefaultDateFromWarning = (warning: PnLWarningItem): string => {
        const transactionDate = warning.details?.transaction_date as string | undefined;
        if (transactionDate) return transactionDate;
        return new Date().toISOString();
    };

    const handleAddPriceClick = (warning: PnLWarningItem) => {
        setSelectedWarning(warning);
        setDialogOpen(true);
    };

    const handlePriceSaved = () => {
        if (selectedWarning && selectedWarning.asset_id && onPriceAdded) {
            onPriceAdded(selectedWarning.asset_id, selectedWarning.id);
        }
        setDialogOpen(false);
        setSelectedWarning(null);
    };

    // Sort warnings by date descending (most recent first)
    const sortedWarnings = useMemo(() => {
        return [...warnings].sort((a, b) => {
            const da = new Date(a.timestamp || 0).getTime();
            const db = new Date(b.timestamp || 0).getTime();
            return db - da;  // Most recent first
        });
    }, [warnings]);

    // Types for filtering (from sorted warnings)
    const types = useMemo(() => {
        const set = new Set(sortedWarnings.map(w => w.warning_type));
        return Array.from(set);
    }, [sortedWarnings]);

    const filtered = useMemo(() => {
        if (typeFilter === 'all') return sortedWarnings;
        return sortedWarnings.filter(w => w.warning_type === typeFilter);
    }, [sortedWarnings, typeFilter]);

    const typeCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        warnings.forEach(w => {
            counts[w.warning_type] = (counts[w.warning_type] || 0) + 1;
        });
        return counts;
    }, [warnings]);

    if (warnings.length === 0) {
        return (
            <Box textAlign="center" py={8}>
                <Text color="green.600" fontWeight="bold">✓ No warnings</Text>
                <Text fontSize="sm" color="gray.500">All calculations completed without issues</Text>
            </Box>
        );
    }

    return (
        <Box>
            <Flex gap={2} mb={4} wrap="wrap">
                <Button
                    size="xs"
                    variant={typeFilter === 'all' ? 'solid' : 'outline'}
                    colorPalette="orange"
                    onClick={() => setTypeFilter('all')}
                >
                    All ({warnings.length})
                </Button>
                {types.map(type => (
                    <Button
                        key={type}
                        size="xs"
                        variant={typeFilter === type ? 'solid' : 'outline'}
                        colorPalette="orange"
                        onClick={() => setTypeFilter(type)}
                    >
                        {type} ({typeCounts[type]})
                    </Button>
                ))}
            </Flex>

            <Box overflowX="auto" style={{ fontSize: '8px' }}>
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader width="100px">Date</Table.ColumnHeader>
                            <Table.ColumnHeader width="90px">Type</Table.ColumnHeader>
                            <Table.ColumnHeader>Message</Table.ColumnHeader>
                            <Table.ColumnHeader width="180px">Transaction</Table.ColumnHeader>
                            {quoteAssetId && <Table.ColumnHeader width="80px">Action</Table.ColumnHeader>}
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {filtered.map((warning, i) => (
                            <Table.Row key={i} bg="orange.50">
                                <Table.Cell>
                                    <Text fontSize="2xs" color="gray.600">
                                        {warning.timestamp
                                            ? formatDateTimeLocale(warning.timestamp)
                                            : '-'
                                        }
                                    </Text>
                                </Table.Cell>
                                <Table.Cell>
                                    <Badge colorPalette="orange" size="xs">
                                        {warning.warning_type}
                                    </Badge>
                                </Table.Cell>
                                <Table.Cell>
                                    <Text fontSize="xs">{warning.message}</Text>
                                </Table.Cell>
                                <Table.Cell>
                                    {warning.transaction_id ? (
                                        <TransactionCell
                                            txId={warning.transaction_id}
                                            baseCurrency={baseCurrency}
                                            onTransactionClick={onTransactionClick}
                                        />
                                    ) : (
                                        <Text fontSize="xs" color="gray.400">-</Text>
                                    )}
                                </Table.Cell>
                                {quoteAssetId && (
                                    <Table.Cell>
                                        {isPriceWarning(warning) && (
                                            <Button
                                                size="xs"
                                                colorPalette="green"
                                                onClick={() => handleAddPriceClick(warning)}
                                            >
                                                <FiPlus size={10} />
                                            </Button>
                                        )}
                                    </Table.Cell>
                                )}
                            </Table.Row>
                        ))}
                    </Table.Body>
                </Table.Root>
            </Box>

            {/* Manual Price Dialog */}
            {selectedWarning && selectedWarning.asset_id && quoteAssetId && (
                <AddManualPriceDialog
                    isOpen={dialogOpen}
                    onClose={() => {
                        setDialogOpen(false);
                        setSelectedWarning(null);
                    }}
                    onSave={handlePriceSaved}
                    assetId={selectedWarning.asset_id}
                    assetName={getAssetName(selectedWarning.asset_id)}
                    defaultDate={getDefaultDateFromWarning(selectedWarning)}
                    quoteAssetId={quoteAssetId}
                    quoteAssetName={baseCurrency}
                />
            )}
        </Box>
    );
};

// ============================================================================
// Settlements Tab - Audit trail for negative lot settlements
// ============================================================================

const SettlementsTab: React.FC<{
    settlements: Settlement[];
    costLots: CostLot[];
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}> = ({ settlements, costLots, baseCurrency, onTransactionClick }) => {
    const [search, setSearch] = useState('');

    // Build a map of cost_lot_id -> CostLot for enrichment
    const lotMap = useMemo(() => {
        const map = new Map<number, CostLot>();
        for (const lot of costLots) {
            map.set(lot.cost_lot_id, lot);
        }
        return map;
    }, [costLots]);

    const filtered = useMemo(() => {
        if (!search) return settlements;
        const s = search.toLowerCase();
        return settlements.filter(settlement => {
            const negativeLot = lotMap.get(settlement.negative_lot_id);
            const settlingLot = lotMap.get(settlement.settling_lot_id);
            return (
                String(settlement.settlement_id).includes(s) ||
                String(settlement.negative_lot_id).includes(s) ||
                String(settlement.settling_lot_id).includes(s) ||
                (negativeLot?.asset_symbol || '').toLowerCase().includes(s) ||
                (settlingLot?.asset_symbol || '').toLowerCase().includes(s)
            );
        });
    }, [settlements, search, lotMap]);

    const sorted = useMemo(() => {
        return [...filtered].sort((a, b) =>
            new Date(b.settled_at).getTime() - new Date(a.settled_at).getTime()
        );
    }, [filtered]);

    const stats = useMemo(() => {
        const totalQtySettled = settlements.reduce((sum, s) => sum + s.qty_settled, 0);
        const totalCostApplied = settlements.reduce((sum, s) => sum + (s.cost_basis_applied || 0), 0);
        const uniqueNegativeLots = new Set(settlements.map(s => s.negative_lot_id)).size;
        const uniqueSettlingLots = new Set(settlements.map(s => s.settling_lot_id)).size;
        return { totalQtySettled, totalCostApplied, uniqueNegativeLots, uniqueSettlingLots };
    }, [settlements]);

    if (settlements.length === 0) {
        return (
            <Box textAlign="center" py={8}>
                <Text color="gray.600" fontWeight="bold">No settlements</Text>
                <Text fontSize="sm" color="gray.500">No negative lots have been settled yet</Text>
            </Box>
        );
    }

    return (
        <Box>
            {/* Search */}
            <Flex gap={2} mb={4} wrap="wrap" align="center">
                <Flex align="center" bg="gray.50" px={2} borderRadius="md" flex="1" maxW="300px">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search lot UUID, asset..."
                        size="sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        border="none"
                        _focus={{ boxShadow: 'none' }}
                    />
                </Flex>
            </Flex>

            {/* Stats */}
            <Flex gap={4} mb={3} fontSize="sm" color="gray.600" wrap="wrap">
                <Text>
                    <Badge size="sm" colorPalette="blue" mr={1}>{settlements.length}</Badge>
                    Settlements
                </Text>
                <Text>
                    <Badge size="sm" colorPalette="red" mr={1}>{stats.uniqueNegativeLots}</Badge>
                    Negative lots settled
                </Text>
                <Text>
                    <Badge size="sm" colorPalette="green" mr={1}>{stats.uniqueSettlingLots}</Badge>
                    Settling lots used
                </Text>
                {stats.totalCostApplied > 0 && (
                    <Text>
                        <Badge size="sm" colorPalette="purple" mr={1}>
                            {formatCurrency(stats.totalCostApplied, baseCurrency)}
                        </Badge>
                        Cost basis applied
                    </Text>
                )}
            </Flex>

            <Box overflowX="auto" style={{ fontSize: '8px' }}>
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader>Date</Table.ColumnHeader>
                            <Table.ColumnHeader>Negative Lot</Table.ColumnHeader>
                            <Table.ColumnHeader>→</Table.ColumnHeader>
                            <Table.ColumnHeader>Settling Lot</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Qty Settled</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right">Cost Basis</Table.ColumnHeader>
                            <Table.ColumnHeader>Transaction</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {sorted.slice(0, 200).map((settlement) => {
                            const negativeLot = lotMap.get(settlement.negative_lot_id);
                            const settlingLot = lotMap.get(settlement.settling_lot_id);
                            return (
                                <Table.Row key={settlement.settlement_id}>
                                    <Table.Cell fontSize="xs">
                                        {formatDateLocale(settlement.settled_at)}
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Flex direction="column" gap={0}>
                                            <Flex align="center" gap={1}>
                                                <Badge size="xs" colorPalette="red">⚠</Badge>
                                                {negativeLot && (
                                                    <Badge size="xs">{negativeLot.asset_symbol}</Badge>
                                                )}
                                            </Flex>
                                            <Text fontSize="2xs" fontFamily="mono" color="gray.500">
                                                #{settlement.negative_lot_id}
                                            </Text>
                                            {negativeLot && (
                                                <Flex direction="column" gap={0} fontSize="2xs" color="gray.600">
                                                    <Text>Orig: {formatQty(Math.abs(negativeLot.qty_original))}</Text>
                                                    {negativeLot.origin_transaction_id && (
                                                        <TransactionTooltip txId={negativeLot.origin_transaction_id} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                                            <Button
                                                                size="xs"
                                                                variant="ghost"
                                                                p={0}
                                                                h="auto"
                                                                minW="auto"
                                                                fontWeight="normal"
                                                                color="blue.600"
                                                                fontSize="2xs"
                                                                onClick={(e) => { e.stopPropagation(); onTransactionClick?.(negativeLot.origin_transaction_id!); }}
                                                            >
                                                                TX #{negativeLot.origin_transaction_id}
                                                            </Button>
                                                        </TransactionTooltip>
                                                    )}
                                                    {negativeLot.is_fully_settled ? (
                                                        <Badge size="xs" colorPalette="green">✓ Settled</Badge>
                                                    ) : (
                                                        <Badge size="xs" colorPalette="orange">⏳ Pending</Badge>
                                                    )}
                                                </Flex>
                                            )}
                                        </Flex>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <FiLink size={12} color="gray" />
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Flex direction="column" gap={0}>
                                            <Flex align="center" gap={1}>
                                                <Badge size="xs" colorPalette="green">+</Badge>
                                                {settlingLot && (
                                                    <Badge size="xs">{settlingLot.asset_symbol}</Badge>
                                                )}
                                            </Flex>
                                            <Text fontSize="2xs" fontFamily="mono" color="gray.500">
                                                #{settlement.settling_lot_id}
                                            </Text>
                                            {settlingLot && settlingLot.origin_transaction_id && (
                                                <TransactionTooltip txId={settlingLot.origin_transaction_id} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                                    <Button
                                                        size="xs"
                                                        variant="ghost"
                                                        p={0}
                                                        h="auto"
                                                        minW="auto"
                                                        fontWeight="normal"
                                                        color="blue.600"
                                                        fontSize="2xs"
                                                        onClick={(e) => { e.stopPropagation(); onTransactionClick?.(settlingLot.origin_transaction_id!); }}
                                                    >
                                                        TX #{settlingLot.origin_transaction_id}
                                                    </Button>
                                                </TransactionTooltip>
                                            )}
                                        </Flex>
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontFamily="mono" fontSize="xs">
                                        {formatQty(settlement.qty_settled)}
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontSize="xs">
                                        {settlement.cost_basis_applied != null ? (
                                            formatCurrency(settlement.cost_basis_applied, baseCurrency)
                                        ) : (
                                            <Text fontSize="xs" color="gray.400">-</Text>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell>
                                        {settlement.settling_transaction_id ? (
                                            <TransactionCell
                                                txId={settlement.settling_transaction_id}
                                                baseCurrency={baseCurrency}
                                                onTransactionClick={onTransactionClick}
                                                prefix=""
                                            />
                                        ) : (
                                            <Text fontSize="xs" color="gray.400">-</Text>
                                        )}
                                    </Table.Cell>
                                </Table.Row>
                            );
                        })}
                    </Table.Body>
                </Table.Root>
            </Box>
            {sorted.length > 200 && (
                <Text fontSize="sm" color="gray.500" mt={2} textAlign="center">
                    Showing first 200 of {sorted.length} settlements
                </Text>
            )}
        </Box>
    );
};

// ============================================================================
// Main Panel
// ============================================================================

export const DataExplorerPanel: React.FC<DataExplorerPanelProps> = ({
    isOpen,
    onClose,
    calculationUnits,
    costLots,
    consumedSlices = [],
    realizedPnL,
    warnings,
    settlements = [],
    baseCurrency,
    onTransactionClick,
    onAssetClick,
    quoteAssetId,
    onPriceAdded,
    assets,
}) => {
    return (
        <SlidePanel
            isOpen={isOpen}
            onClose={onClose}
            title="P&L Audit"
            titleIcon={<FiLayers size={20} />}
            width="1000px"
        >
            <Tabs.Root defaultValue="units">
                <Tabs.List mb={4}>
                    <Tabs.Trigger value="units">
                        <FiLayers style={{ marginRight: 4 }} />
                        Calculation Units ({calculationUnits.length})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="lots">
                        <FiDatabase style={{ marginRight: 4 }} />
                        Cost Lots ({costLots.length}{settlements.length > 0 ? ` + ${settlements.length} settlements` : ''})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="realized">
                        <FiDollarSign style={{ marginRight: 4 }} />
                        Realized P&L ({realizedPnL.length})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="warnings">
                        <FiAlertTriangle style={{ marginRight: 4 }} />
                        Warnings ({warnings.length})
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="units">
                    <UnitsTab
                        units={calculationUnits}
                        baseCurrency={baseCurrency}
                        costLots={costLots}
                        onTransactionClick={onTransactionClick}
                    />
                </Tabs.Content>

                <Tabs.Content value="lots">
                    <CostLotsTab
                        lots={costLots}
                        consumedSlices={consumedSlices}
                        settlements={settlements}
                        baseCurrency={baseCurrency}
                        onTransactionClick={onTransactionClick}
                    />
                </Tabs.Content>

                <Tabs.Content value="realized">
                    <RealizedPnLTab
                        entries={realizedPnL}
                        baseCurrency={baseCurrency}
                        onTransactionClick={onTransactionClick}
                    />
                </Tabs.Content>

                <Tabs.Content value="warnings">
                    <WarningsTab
                        warnings={warnings}
                        baseCurrency={baseCurrency}
                        onTransactionClick={onTransactionClick}
                        quoteAssetId={quoteAssetId}
                        onPriceAdded={onPriceAdded}
                        assets={assets}
                    />
                </Tabs.Content>
            </Tabs.Root>
        </SlidePanel>
    );
};

// Embedded version (no slide panel)
export const DataExplorerContent: React.FC<Omit<DataExplorerPanelProps, 'isOpen' | 'onClose'>> = ({
    calculationUnits,
    costLots,
    consumedSlices = [],
    realizedPnL,
    warnings,
    baseCurrency,
    onTransactionClick,
    onAssetClick,
    quoteAssetId,
    onPriceAdded,
    assets,
}) => {
    return (
        <Box mt={4}>
            <Tabs.Root defaultValue="units">
                <Tabs.List mb={4}>
                    <Tabs.Trigger value="units">
                        <FiLayers style={{ marginRight: 4 }} />
                        Calculation Units ({calculationUnits.length})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="lots">
                        <FiDatabase style={{ marginRight: 4 }} />
                        Cost Lots ({costLots.length})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="realized">
                        <FiDollarSign style={{ marginRight: 4 }} />
                        Realized P&L ({realizedPnL.length})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="warnings">
                        <FiAlertTriangle style={{ marginRight: 4 }} />
                        Warnings ({warnings.length})
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="units">
                    <UnitsTab
                        units={calculationUnits}
                        baseCurrency={baseCurrency}
                        costLots={costLots}
                        onTransactionClick={onTransactionClick}
                    />
                </Tabs.Content>

                <Tabs.Content value="lots">
                    <CostLotsTab
                        lots={costLots}
                        consumedSlices={consumedSlices}
                        baseCurrency={baseCurrency}
                        onTransactionClick={onTransactionClick}
                    />
                </Tabs.Content>

                <Tabs.Content value="realized">
                    <RealizedPnLTab
                        entries={realizedPnL}
                        baseCurrency={baseCurrency}
                        onTransactionClick={onTransactionClick}
                    />
                </Tabs.Content>

                <Tabs.Content value="warnings">
                    <WarningsTab
                        warnings={warnings}
                        baseCurrency={baseCurrency}
                        onTransactionClick={onTransactionClick}
                        quoteAssetId={quoteAssetId}
                        onPriceAdded={onPriceAdded}
                        assets={assets}
                    />
                </Tabs.Content>
            </Tabs.Root>
        </Box>
    );
};

// ============================================================================
// Lot Events Tab - Audit trail for lot lifecycle events
// ============================================================================

const LotEventsTab: React.FC<{
    events: CostLotEventEntry[];
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}> = ({ events, baseCurrency, onTransactionClick }) => {
    const [typeFilter, setTypeFilter] = useState<string>('all');
    const [search, setSearch] = useState('');

    // Event type colors
    const eventTypeColors: Record<string, string> = {
        created: 'green',
        consumed: 'red',
        settled: 'purple',
        transferred: 'blue',
        adjusted: 'orange',
    };

    // Sort events by timestamp descending (most recent first)
    const sortedEvents = useMemo(() => {
        return [...events].sort((a, b) => {
            const da = new Date(a.timestamp).getTime();
            const db = new Date(b.timestamp).getTime();
            return db - da;  // Most recent first
        });
    }, [events]);

    // Types for filtering
    const types = useMemo(() => {
        const set = new Set(events.map(e => e.event_type));
        return Array.from(set);
    }, [events]);

    const typeCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        events.forEach(e => {
            counts[e.event_type] = (counts[e.event_type] || 0) + 1;
        });
        return counts;
    }, [events]);

    const filtered = useMemo(() => {
        let result = sortedEvents;
        if (typeFilter !== 'all') {
            result = result.filter(e => e.event_type === typeFilter);
        }
        if (search) {
            const s = search.toLowerCase();
            result = result.filter(e =>
                (e.asset?.name && e.asset.name.toLowerCase().includes(s)) ||
                String(e.lot_id).includes(s)
            );
        }
        return result;
    }, [sortedEvents, typeFilter, search]);

    const formatQty = (num: number | undefined | null) => {
        if (num === undefined || num === null) return '-';
        return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
    };

    const formatCost = (num: number | undefined | null) => {
        if (num === undefined || num === null) return '-';
        return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    if (events.length === 0) {
        return (
            <Box textAlign="center" py={8}>
                <Text color="gray.500">No lot events recorded</Text>
                <Text fontSize="sm" color="gray.400">Events will appear here after P&L calculation</Text>
            </Box>
        );
    }

    return (
        <Box>
            {/* Filters */}
            <Flex gap={2} mb={4} wrap="wrap" align="center">
                <Flex align="center" bg="gray.50" px={2} borderRadius="md" flex="1" maxW="300px">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search lot UUID, asset..."
                        size="sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        border="none"
                        _focus={{ boxShadow: 'none' }}
                    />
                </Flex>
                <Button
                    size="xs"
                    variant={typeFilter === 'all' ? 'solid' : 'outline'}
                    colorPalette="blue"
                    onClick={() => setTypeFilter('all')}
                >
                    All ({events.length})
                </Button>
                {types.map(type => (
                    <Button
                        key={type}
                        size="xs"
                        variant={typeFilter === type ? 'solid' : 'outline'}
                        colorPalette={eventTypeColors[type] || 'gray'}
                        onClick={() => setTypeFilter(type)}
                    >
                        {type} ({typeCounts[type]})
                    </Button>
                ))}
            </Flex>

            <Text fontSize="xs" color="gray.500" mb={2}>
                Showing {filtered.length} of {events.length} events
            </Text>

            <Box overflowX="auto" style={{ fontSize: '8px' }}>
                <Table.Root size="sm" striped>
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader width="140px">Time</Table.ColumnHeader>
                            <Table.ColumnHeader width="90px">Event</Table.ColumnHeader>
                            <Table.ColumnHeader width="100px">Lot</Table.ColumnHeader>
                            <Table.ColumnHeader width="80px">Asset</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right" width="100px">Qty Δ</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right" width="120px">Cost Δ</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right" width="100px">Qty After</Table.ColumnHeader>
                            <Table.ColumnHeader width="120px">Trigger</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {filtered.slice(0, 500).map((event) => (
                            <Table.Row key={event.event_id} bg={`${eventTypeColors[event.event_type] || 'gray'}.50`}>
                                <Table.Cell>
                                    <Text fontSize="2xs" color="gray.600">
                                        {formatDateTimeLocale(event.timestamp)}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell>
                                    <Badge colorPalette={eventTypeColors[event.event_type] || 'gray'} size="xs">
                                        {event.event_type}
                                    </Badge>
                                </Table.Cell>
                                <Table.Cell fontFamily="mono" fontSize="2xs">
                                    #{event.lot_id}
                                </Table.Cell>
                                <Table.Cell>
                                    <Text fontSize="xs" fontWeight="medium">
                                        {event.asset?.name || '-'}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell textAlign="right">
                                    <Text
                                        fontSize="xs"
                                        color={event.quantity_delta >= 0 ? 'green.600' : 'red.600'}
                                        fontWeight="medium"
                                    >
                                        {event.quantity_delta >= 0 ? '+' : ''}{formatQty(event.quantity_delta)}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell textAlign="right">
                                    {event.cost_basis_delta !== undefined && event.cost_basis_delta !== null ? (
                                        <Text
                                            fontSize="xs"
                                            color={event.cost_basis_delta >= 0 ? 'green.600' : 'red.600'}
                                        >
                                            {event.cost_basis_delta >= 0 ? '+' : ''}{formatCost(event.cost_basis_delta)} {baseCurrency}
                                        </Text>
                                    ) : (
                                        <Text fontSize="xs" color="gray.400">-</Text>
                                    )}
                                </Table.Cell>
                                <Table.Cell textAlign="right">
                                    <Text fontSize="xs">{formatQty(event.qty_remaining_after)}</Text>
                                </Table.Cell>
                                <Table.Cell>
                                    {event.triggered_by_transaction_id ? (
                                        <TransactionCell
                                            txId={event.triggered_by_transaction_id}
                                            baseCurrency={baseCurrency}
                                            onTransactionClick={onTransactionClick}
                                            prefix=""
                                            size="xs"
                                        />
                                    ) : event.triggered_by_unit_label ? (
                                        <Text fontSize="2xs" color="gray.600">{event.triggered_by_unit_label}</Text>
                                    ) : event.triggered_by_unit_id ? (
                                        <Text fontSize="2xs" color="gray.500">Unit #{event.triggered_by_unit_id}</Text>
                                    ) : (
                                        <Text fontSize="2xs" color="gray.400">-</Text>
                                    )}
                                </Table.Cell>
                            </Table.Row>
                        ))}
                    </Table.Body>
                </Table.Root>
            </Box>

            {filtered.length > 500 && (
                <Text fontSize="xs" color="gray.500" mt={2} textAlign="center">
                    Showing first 500 events. Use filters to narrow results.
                </Text>
            )}
        </Box>
    );
};

// Legacy-compatible export for PnLPanel integration
// Accepts optional costLots, realizedPnL, warnings, settlements, consumedSlices, fees
interface PnLAuditViewProps {
    calculationUnits: CalculationUnit[];
    costLots?: CostLot[];
    consumedSlices?: ConsumedSliceDetail[];  // Consumed slices from /consumed-slices endpoint
    realizedPnL?: RealizedPnLRow[];
    warnings?: PnLWarningItem[];
    fees?: FeeEntry[];  // Fee entries for Fees tab
    settlements?: Settlement[];  // Audit trail for negative lot settlements
    lotEvents?: CostLotEventEntry[];  // Audit trail for lot lifecycle events (only for Cost Lot Events tab)
    baseCurrency: string;
    versionId?: number | null;  // Version ID for on-demand loading in expanded rows
    onTransactionClick?: (txId: number) => void;
    onAssetClick?: (assetId: number) => void;
    onUnitClick?: (unitId: number) => void;
    defaultTab?: 'units' | 'lots' | 'realized' | 'fees' | 'warnings' | 'events';  // Control initial tab
    onTabChange?: (tab: string) => void;  // Callback when tab changes - triggers lazy loading
    isLoadingUnits?: boolean;  // Loading state for units tab
    isLoadingLots?: boolean;   // Loading state for lots tab
    isLoadingRealized?: boolean;  // Loading state for realized tab
    isLoadingFees?: boolean;  // Loading state for fees tab
    isLoadingWarnings?: boolean;  // Loading state for warnings tab
    isLoadingEvents?: boolean;  // Loading state for events tab
    idCounts?: {  // ID array counts from calculation (for tab titles, derived from list.length)
        unitCount: number;
        lotCount: number;
        consumedCount: number;
        realizedCount: number;
        feeCount: number;
        warningCount: number;
        settlementCount: number;
        eventCount: number;
    };
    // Manual price entry support for warnings
    quoteAssetId?: number;
    onPriceAdded?: (assetId: number, warningId: string) => void;
    assets?: Array<{ id: number; name: string }>;
}

export const PnLAuditView: React.FC<PnLAuditViewProps> = ({
    calculationUnits,
    costLots: propCostLots,
    consumedSlices: propConsumedSlices,
    realizedPnL: propRealizedPnL,
    warnings: propWarnings,
    fees: propFees,
    settlements: propSettlements,
    lotEvents: propLotEvents,
    baseCurrency,
    versionId,
    onTransactionClick,
    onAssetClick,
    onUnitClick,
    defaultTab = 'units',
    onTabChange,
    isLoadingUnits = false,
    isLoadingLots = false,
    isLoadingRealized = false,
    isLoadingFees = false,
    isLoadingWarnings = false,
    isLoadingEvents = false,
    idCounts,
    quoteAssetId,
    onPriceAdded,
    assets,
}) => {
    // Controlled tab state - initialized from defaultTab prop and updates when it changes
    const [activeTab, setActiveTab] = useState<string>(defaultTab);

    // Update activeTab when defaultTab prop changes (for navigation from warnings card)
    useEffect(() => {
        setActiveTab(defaultTab);
    }, [defaultTab]);

    // Handle tab change - notify parent for lazy loading
    const handleTabChange = (tab: string) => {
        setActiveTab(tab);
        onTabChange?.(tab);
    };

    // Use provided data directly - no fallback derivation
    const costLots = propCostLots || [];
    const consumedSlices = propConsumedSlices || [];
    const realizedPnL = propRealizedPnL || [];
    const warnings = propWarnings || [];
    const fees = propFees || [];
    const settlements = propSettlements || [];
    const lotEvents = propLotEvents || [];

    // Tab title counts: use idCounts from calculation (derived from ID array lengths)
    // Shows accurate counts even before full data is lazy-loaded
    const unitsCount = calculationUnits.length > 0 ? calculationUnits.length : (idCounts?.unitCount ?? 0);
    const lotsCount = costLots.length > 0 ? costLots.length : (idCounts?.lotCount ?? 0);
    const consumedCount = consumedSlices.length > 0 ? consumedSlices.length : (idCounts?.consumedCount ?? 0);
    const realizedCount = realizedPnL.length > 0 ? realizedPnL.length : (idCounts?.realizedCount ?? 0);
    const feesCount = fees.length > 0 ? fees.length : (idCounts?.feeCount ?? 0);
    const warningsCount = warnings.length > 0 ? warnings.length : (idCounts?.warningCount ?? 0);
    const settlementsCount = settlements.length > 0 ? settlements.length : (idCounts?.settlementCount ?? 0);
    const eventsCount = lotEvents.length > 0 ? lotEvents.length : (idCounts?.eventCount ?? 0);

    return (
        <Box mt={4}>
            <Tabs.Root value={activeTab} onValueChange={(e) => handleTabChange(e.value)}>
                <Tabs.List mb={4}>
                    <Tabs.Trigger value="units">
                        <FiLayers style={{ marginRight: 4 }} />
                        Calculation Units ({unitsCount})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="lots">
                        <FiDatabase style={{ marginRight: 4 }} />
                        Cost Lots ({lotsCount})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="realized">
                        <FiDollarSign style={{ marginRight: 4 }} />
                        Realized P&L ({realizedCount})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="fees">
                        💰 Fees ({feesCount})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="events">
                        <FiActivity style={{ marginRight: 4 }} />
                        Cost Lot Events ({eventsCount})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="warnings">
                        <FiAlertTriangle style={{ marginRight: 4 }} />
                        Warnings ({warningsCount})
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="units">
                    {isLoadingUnits ? (
                        <Flex align="center" justify="center" py={8} gap={2}>
                            <FiLoader className="animate-spin" />
                            <Text color="gray.500">Loading calculation units...</Text>
                        </Flex>
                    ) : (
                        <UnitsTab
                            units={calculationUnits}
                            baseCurrency={baseCurrency}
                            costLots={costLots}
                            versionId={versionId}
                            onTransactionClick={onTransactionClick}
                        />
                    )}
                </Tabs.Content>

                <Tabs.Content value="lots">
                    {isLoadingLots ? (
                        <Flex align="center" justify="center" py={8} gap={2}>
                            <FiLoader className="animate-spin" />
                            <Text color="gray.500">Loading cost lots...</Text>
                        </Flex>
                    ) : (
                        <CostLotsTab
                            lots={costLots}
                            consumedSlices={consumedSlices}
                            settlements={settlements}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                        />
                    )}
                </Tabs.Content>

                <Tabs.Content value="realized">
                    {isLoadingRealized ? (
                        <Flex align="center" justify="center" py={8} gap={2}>
                            <FiLoader className="animate-spin" />
                            <Text color="gray.500">Loading realized P&L...</Text>
                        </Flex>
                    ) : (
                        <RealizedPnLTab
                            entries={realizedPnL}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                        />
                    )}
                </Tabs.Content>

                <Tabs.Content value="fees">
                    {isLoadingFees ? (
                        <Flex align="center" justify="center" py={8} gap={2}>
                            <FiLoader className="animate-spin" />
                            <Text color="gray.500">Loading fees...</Text>
                        </Flex>
                    ) : (
                        <FeesTab
                            fees={fees}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                            onUnitClick={onUnitClick}
                        />
                    )}
                </Tabs.Content>

                <Tabs.Content value="events">
                    {isLoadingEvents ? (
                        <Flex align="center" justify="center" py={8} gap={2}>
                            <FiLoader className="animate-spin" />
                            <Text color="gray.500">Loading lot events...</Text>
                        </Flex>
                    ) : (
                        <LotEventsTab
                            events={lotEvents}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                        />
                    )}
                </Tabs.Content>

                <Tabs.Content value="warnings">
                    {isLoadingWarnings ? (
                        <Flex align="center" justify="center" py={8} gap={2}>
                            <FiLoader className="animate-spin" />
                            <Text color="gray.500">Loading warnings...</Text>
                        </Flex>
                    ) : (
                        <WarningsTab
                            warnings={warnings}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                            quoteAssetId={quoteAssetId}
                            onPriceAdded={onPriceAdded}
                            assets={assets}
                        />
                    )}
                </Tabs.Content>
            </Tabs.Root>
        </Box>
    );
};

export default DataExplorerPanel;
