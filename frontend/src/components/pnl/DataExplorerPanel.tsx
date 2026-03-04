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
import { FiSearch, FiChevronDown, FiChevronRight, FiAlertTriangle, FiLayers, FiDatabase, FiDollarSign, FiLoader, FiLink, FiActivity, FiPlus, FiFileText } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { CalculationUnit, CostLot, RealizedPnLRow, PnLWarningItem, OriginTransactionDetail, Settlement, ConsumedSliceDetail, CostLotEventEntry, FeeEntry } from './types';
import { API_URL, AssetRef } from '../../types';
import { Tooltip } from '../ui/tooltip';
import { AssetBadge } from '../AssetBadge';
import { CompactTransactionBadgeRow } from '../CompactTransactionBadgeRow';
import { TransactionRow } from '../TransactionRow';
import { TransactionsTable } from '../TransactionsTable';
import { defaultFilterState, TransactionFilterState, TransactionFilters } from '../TransactionFilters';
import { buildPnLFilterParams } from '../../utils/pnlFilterParams';
import { AddManualPriceDialog } from './AddManualPriceDialog';
import { formatDateLocale, formatDateTimeLocale } from '../../utils/dateUtils';
import { formatQuantity } from '../../utils/numberUtils';
const formatQty = formatQuantity;
import { ValueDisplay } from '../ValueDisplay';
import { TablePagination } from '../TablePagination';
import { usePagination } from '../../hooks/usePagination';
import { getWarningTypeConfig } from './warningStyles';
import { CostLotEventsTable, EVENT_TABLE_PRESETS } from './CostLotEventsTable';
import {
    UnitsTabWrapper,
    LotsTabWrapper,
    RealizedTabWrapper,
    FeesTabWrapper,
    WarningsTabWrapper,
    TransactionsTabWrapper,
} from './AuditTabWrappers';
// Re-export for backwards compatibility
export { getPersistedPageSize } from '../../hooks/usePagination';

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
                        <Text color="white" fontFamily="mono"><ValueDisplay value={txData.quantity} /></Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Unit Price</Text>
                        <Text color="white"><ValueDisplay value={txData.price} /></Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Total</Text>
                        <Text color="white">
                            {txData.total ? <ValueDisplay value={txData.total} currency={baseCurrency} /> : '-'}
                        </Text>
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
                        <Text color="white"><ValueDisplay value={txData.fee} /></Text>
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
                                ? (txData.from_account_name
                                    ? `${txData.from_account_name}${txData.source_from_account && txData.source_from_account !== txData.from_account_name ? ` (${txData.source_from_account})` : ''}`
                                    : (txData.source_from_account || '-'))
                                : (txData.to_account_name
                                    ? `${txData.to_account_name}${txData.source_to_account && txData.source_to_account !== txData.to_account_name ? ` (${txData.source_to_account})` : ''}`
                                    : (txData.source_to_account || '-'))}
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
                    <Text>• <ValueDisplay value={txData.total} currency={baseCurrency} /></Text>
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

    // Get all transaction IDs for this unit
    const allTxIds = useMemo(() => {
        return unit.transactions.map(tx => tx.id);
    }, [unit.transactions]);

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
                                        // Build source tooltip: show source address when linked account name is displayed
                                        const fromToSource = tx.direction === 'inflow'
                                            ? (tx.from_account_name && tx.source_from_account && tx.source_from_account !== tx.from_account_name ? `Source: ${tx.source_from_account}` : undefined)
                                            : (tx.to_account_name && tx.source_to_account && tx.source_to_account !== tx.to_account_name ? `Source: ${tx.source_to_account}` : undefined);

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
                                                    {tx.price ? <ValueDisplay value={tx.price} currency={baseCurrency} /> : '-'}
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="right">
                                                    {tx.total ? <ValueDisplay value={tx.total} currency={baseCurrency} /> : '-'}
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
                                                <Table.Cell fontSize="xs" color="gray.600" title={fromToSource}>
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
                                        {unit.legs.filter(leg => leg.leg_type === 'outflow').map((leg, i) => (
                                            <Badge key={i} size="xs" colorPalette="red">{leg.asset?.symbol}</Badge>
                                        ))}
                                    </Flex>
                                </Box>
                                <Box>
                                    <Text color="gray.500" fontWeight="bold">Inflows</Text>
                                    <Flex gap={1} wrap="wrap">
                                        {unit.legs.filter(leg => leg.leg_type === 'inflow').map((leg, i) => (
                                            <Badge key={i} size="xs" colorPalette="green">{leg.asset?.symbol}</Badge>
                                        ))}
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
                    {/* Cost Lot Events Card - Now using unified component in compact mode */}
                    <Card.Root size="sm" variant="outline" flex="1" minW="400px" overflow="hidden">
                        <Card.Body p={3} overflow="auto">
                            <Text fontSize="xs" fontWeight="bold" color="gray.600" mb={2}>
                                📦 Cost Lot Events
                            </Text>
                            {versionId && (
                                <CostLotEventsTable
                                    {...EVENT_TABLE_PRESETS.UNIT_DETAIL}
                                    versionId={versionId}
                                    unitId={unit.unit_id}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                    maxHeight="400px"
                                    hidePagination={true}
                                />
                            )}
                        </Card.Body>
                    </Card.Root>

                    {/* P&L Card */}
                    <Card.Root size="sm" variant="outline" flex="1" minW="280px">
                        <Card.Body p={3}>
                            <Text fontSize="xs" fontWeight="bold" color="green.600" mb={2}>
                                💰 Realized P&L ({unit.realized_entries?.length || 0})
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
                                                    <Badge size="xs">{entry.asset.symbol || `#${entry.asset.id}`}</Badge>
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="right">
                                                    <ValueDisplay value={entry.proceeds_in_base} currency={baseCurrency} />
                                                </Table.Cell>
                                                <Table.Cell fontSize="xs" textAlign="right">
                                                    <ValueDisplay value={entry.cost_basis_in_base} currency={baseCurrency} />
                                                </Table.Cell>
                                                <Table.Cell
                                                    fontSize="xs"
                                                    textAlign="right"
                                                    color={entry.pnl_in_base >= 0 ? 'green.600' : 'red.600'}
                                                    fontWeight="bold"
                                                >
                                                    <ValueDisplay value={entry.pnl_in_base} currency={baseCurrency} />
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
    /** Hide internal pagination (when parent provides pagination) */
    hidePagination?: boolean;
}> = ({ units = [], baseCurrency, costLots = [], versionId, onTransactionClick, hidePagination = false }) => {
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
                const symbols = u.legs.map(leg => leg.asset.symbol).join(' ').toLowerCase();
                const label = (u.unit_label || '').toLowerCase();
                return symbols.includes(s)
                label.includes(s) || u.unit_id.toString().includes(s);
            }
            return true;
        });
    }, [units, search, typeFilter]);

    // Pagination - only used when not hidden
    const pagination = usePagination({ storageKey: 'units_tab' });
    const paginatedUnits = hidePagination ? filtered : pagination.paginate(filtered);

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
                        {paginatedUnits.map((unit: CalculationUnit) => {
                            // Generate operation label from unit_label or compose compact preview
                            // For transfers: "Account A → Account B: BTC"
                            // For trades: "−: BTC → +: USD"
                            // Generate operation label based on pattern type
                            // For trades/swaps: "−: BTC → +: USD" 
                            // For transfers: "⇄ BTC" with transfer indicator
                            // Operation label renderer (frontend version of backend _generate_label)
                            const renderOperationLabel = () => {
                                // Use leg arrays from unit
                                const inflowLegs = unit.legs.filter(leg => leg.leg_type === 'inflow');
                                const outflowLegs = unit.legs.filter(leg => leg.leg_type === 'outflow');
                                const feeLegs = unit.legs.filter(leg => leg.leg_type === 'fee');
                                const hasLegs = inflowLegs.length > 0 || outflowLegs.length > 0 || feeLegs.length > 0;

                                if (hasLegs) {
                                    const inflow = inflowLegs.map((leg, idx) => (
                                        <Flex key={`inflow-${idx}`} align="center" gap={1} as="span">
                                            <Text fontSize="sm" color="green.500" fontWeight="bold">↓</Text>
                                            <Text fontSize="sm" color="green.600">{formatQty(leg.qty)}</Text>
                                            {leg.asset?.id ? (
                                                <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                            ) : (
                                                <Text fontSize="sm" color="green.600">{leg.asset?.symbol || '?'}</Text>
                                            )}
                                        </Flex>
                                    ));
                                    const outflow = outflowLegs.map((leg, idx) => (
                                        <Flex key={`outflow-${idx}`} align="center" gap={1} as="span">
                                            <Text fontSize="sm" color="red.500" fontWeight="bold">↑</Text>
                                            <Text fontSize="sm" color="red.600">{formatQty(leg.qty)}</Text>
                                            {leg.asset?.id ? (
                                                <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                            ) : (
                                                <Text fontSize="sm" color="red.600">{leg.asset?.symbol || '?'}</Text>
                                            )}
                                        </Flex>
                                    ));
                                    const fee = feeLegs.map((leg, idx) => (
                                        <Flex key={`fee-${idx}`} align="center" gap={1} as="span">
                                            <Text fontSize="sm" color="orange.500" fontWeight="bold">💸</Text>
                                            <Text fontSize="sm" color="orange.600">{formatQty(leg.qty)}</Text>
                                            {leg.asset?.id ? (
                                                <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                            ) : (
                                                <Text fontSize="sm" color="orange.600">{leg.asset?.symbol || '?'}</Text>
                                            )}
                                        </Flex>
                                    ));
                                    return (
                                        <Flex align="center" gap={1} flexWrap="wrap" ml={2}>
                                            {/* Inflow legs */}
                                            {inflow.length > 0 && inflow}
                                            {/* Separator if both inflow and outflow */}
                                            {inflow.length > 0 && outflow.length > 0 && (
                                                <Text fontSize="sm" color="gray.400" px={1}>|</Text>
                                            )}
                                            {/* Outflow legs */}
                                            {outflow.length > 0 && outflow}
                                            {/* Separator if any fee legs */}
                                            {(inflow.length > 0 || outflow.length > 0) && fee.length > 0 && (
                                                <Text fontSize="sm" color="gray.400" px={1}>|</Text>
                                            )}
                                            {/* Fee legs */}
                                            {fee.length > 0 && fee}
                                        </Flex>
                                    );
                                }
                                // Legacy format fallback
                                const inflow = (inflowLegs || []).map((leg, idx) => (
                                    <Flex key={`inflow-legacy-${idx}`} align="center" gap={1} as="span">
                                        <Text fontSize="xs" color="green.500" fontWeight="bold">↓</Text>
                                        <Text fontSize="xs" color="green.600">{leg.qty.toFixed(8)}</Text>
                                        {leg.asset?.id ? (
                                            <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                        ) : (
                                            <Text fontSize="xs" color="green.600">{leg.asset?.symbol || '?'}</Text>
                                        )}
                                    </Flex>
                                ));
                                const outflow = (outflowLegs || []).map((leg, idx) => (
                                    <Flex key={`outflow-legacy-${idx}`} align="center" gap={1} as="span">
                                        <Text fontSize="xs" color="red.500" fontWeight="bold">↑</Text>
                                        <Text fontSize="xs" color="red.600">{leg.qty.toFixed(8)}</Text>
                                        {leg.asset?.id ? (
                                            <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                        ) : (
                                            <Text fontSize="xs" color="red.600">{leg.asset?.symbol || '?'}</Text>
                                        )}
                                    </Flex>
                                ));
                                const fee = (feeLegs || []).map((leg, idx) => (
                                    <Flex key={`fee-legacy-${idx}`} align="center" gap={1} as="span">
                                        <Text fontSize="xs" color="orange.500" fontWeight="bold">💸</Text>
                                        <Text fontSize="xs" color="orange.600">{leg.qty.toFixed(8)}</Text>
                                        {leg.asset?.id ? (
                                            <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                        ) : (
                                            <Text fontSize="xs" color="orange.600">{leg.asset?.symbol || '?'}</Text>
                                        )}
                                    </Flex>
                                ));
                                return (
                                    <Flex align="center" gap={1} flexWrap="wrap" ml={2}>
                                        {inflow.length > 0 && inflow}
                                        {inflow.length > 0 && outflow.length > 0 && (
                                            <Text fontSize="xs" color="gray.400" px={1}>|</Text>
                                        )}
                                        {outflow.length > 0 && outflow}
                                        {(inflow.length > 0 || outflow.length > 0) && fee.length > 0 && (
                                            <Text fontSize="xs" color="gray.400" px={1}>|</Text>
                                        )}
                                        {fee.length > 0 && fee}
                                    </Flex>
                                );
                            };


                            const mainLabel = renderOperationLabel();
                            const warningCount = unit.warnings?.length || 0;
                            const txCount = Object.keys(unit.transactions || {}).length;

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
                                            <Flex direction="column" gap={1}>
                                                <Flex align="center" gap={1}>

                                                    <Text fontSize="sm" fontWeight="medium">
                                                        {mainLabel}
                                                    </Text>
                                                </Flex>
                                                {/* Display transactions with expandable leg details */}
                                                {(() => {

                                                    // Show transaction IDs as fallback
                                                    if (unit.transactions.length > 0) {
                                                        return (
                                                            <Flex direction="column" gap={0.5} mt={1} bg="gray.100">
                                                                {unit.transactions.slice(0, 3).map((tx: any) => (
                                                                    <TransactionRow
                                                                        key={tx.id}
                                                                        baseCurrency={baseCurrency}
                                                                        onTransactionClick={onTransactionClick}
                                                                        transaction={tx} />
                                                                ))}
                                                                {txCount > 3 && (
                                                                    <Text fontSize="2xs" color="gray.500" pl={1}>+{txCount - 3} more transactions</Text>
                                                                )}
                                                            </Flex>
                                                        );
                                                    }

                                                    return null;
                                                })()}
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
                                                <ValueDisplay value={unit.realized_pnl_in_base || 0} currency={baseCurrency} />
                                            </Text>
                                        </Table.Cell>
                                        <Table.Cell textAlign="right">
                                            {unit.has_fees && unit.total_fees_in_base ? (
                                                <Text fontSize="sm" color="orange.600">
                                                    <ValueDisplay value={unit.total_fees_in_base} currency={baseCurrency} />
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
            {!hidePagination && (
                <TablePagination
                    page={pagination.page}
                    pageSize={pagination.pageSize}
                    total={filtered.length}
                    onPageChange={pagination.setPage}
                    onPageSizeChange={pagination.setPageSize}
                />
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
}> = ({ lots = [], baseCurrency, onTransactionClick }) => {
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'exhausted' | 'negative'>('all');
    const [selectedAsset, setSelectedAsset] = useState<number | null>(null);

    // Get unique assets for filter
    const uniqueAssets = useMemo(() => {
        const assetMap = new Map<number, { id: number; symbol: string }>();
        lots.forEach(lot => {
            if (lot.asset_id) {
                assetMap.set(lot.asset_id, {
                    id: lot.asset_id,
                    symbol: lot.asset?.symbol ?? lot.asset_symbol ?? `#${lot.asset_id}`
                });
            }
        });
        return Array.from(assetMap.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
    }, [lots]);

    const filtered = useMemo(() => {
        return lots.filter(lot => {
            // Asset filter
            if (selectedAsset !== null && lot.asset_id !== selectedAsset) return false;

            // Status filter
            const isNegative = lot.unit_cost_in_base < 0 || lot.total_cost_in_base < 0 || lot.qty_remaining < 0;
            const isExhausted = lot.qty_remaining === 0;

            if (statusFilter === 'negative' && !isNegative) return false;
            if (statusFilter === 'open' && (isExhausted || isNegative)) return false;
            if (statusFilter === 'exhausted' && (!isExhausted || isNegative)) return false;

            // Search filter
            if (search) {
                const s = search.toLowerCase();
                const symbol = lot.asset?.symbol ?? lot.asset_symbol ?? '';
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
                <Flex align="center" bg="gray.50" px={2} borderRadius="md" flex="1" maxW="250px">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search asset, lot ID, account..."
                        size="sm"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        border="none"
                        _focus={{ boxShadow: 'none' }}
                    />
                </Flex>

                {/* Asset Filter */}
                {uniqueAssets.length > 1 && (
                    <select
                        value={selectedAsset ?? 'all'}
                        onChange={(e) => setSelectedAsset(e.target.value === 'all' ? null : Number(e.target.value))}
                        style={{
                            padding: '4px 8px',
                            borderRadius: '6px',
                            border: '1px solid #E2E8F0',
                            fontSize: '14px',
                            backgroundColor: 'white'
                        }}
                    >
                        <option value="all">All Assets</option>
                        {uniqueAssets.map(asset => (
                            <option key={asset.id} value={asset.id}>
                                {asset.symbol}
                            </option>
                        ))}
                    </select>
                )}
            </Flex>

            {/* Status Filter Buttons */}
            <Flex gap={1} mb={3} wrap="wrap">
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

            {/* Summary */}
            <Flex gap={4} mb={3} fontSize="sm" color="gray.600">
                <Text>
                    <Badge size="sm" colorPalette="green" mr={1}>Open</Badge>
                    <ValueDisplay value={stats.totalCostBasis} currency={baseCurrency} /> total cost basis
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
                        {sorted.map((lot) => {
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
                                        <Badge size="xs">{lot.asset?.symbol ?? lot.asset_symbol ?? `#${lot.asset_id}`}</Badge>
                                    </Table.Cell>
                                    <Table.Cell fontSize="xs">{formatDateLocale(lot.acquired_at)}</Table.Cell>
                                    <Table.Cell textAlign="right" fontFamily="mono" fontSize="xs">
                                        <ValueDisplay value={lot.qty_original} />
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontFamily="mono" fontSize="xs">
                                        <Text color={isExhausted ? 'gray.400' : undefined}>
                                            <ValueDisplay value={lot.qty_remaining} />
                                        </Text>
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontSize="xs">
                                        {lot.is_zero_cost ? (
                                            <Badge size="xs" colorPalette="purple">Zero</Badge>
                                        ) : (
                                            <Text color={isNegative ? 'red.600' : undefined}>
                                                <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                            </Text>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontSize="xs">
                                        {lot.is_zero_cost ? (
                                            <Badge size="xs" colorPalette="purple">Zero</Badge>
                                        ) : (
                                            <Text color={isNegative ? 'red.600' : undefined}>
                                                <ValueDisplay value={lot.total_cost_in_base} currency={baseCurrency} />
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
// Now using unified CostLotEventsTable component with server-side filtering
// ============================================================================

export const CostLotEventsTab: React.FC<{
    versionId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    /** Hide internal pagination (when parent provides pagination) */
    hidePagination?: boolean;
    /** Filter to a specific asset (for AssetDetailView) */
    assetId?: number;
}> = ({ versionId, baseCurrency, onTransactionClick, hidePagination = false, assetId }) => {
    // Use ASSET_DETAIL preset when filtering by asset (hides asset column and filter)
    const preset = assetId ? EVENT_TABLE_PRESETS.ASSET_DETAIL : EVENT_TABLE_PRESETS.AUDIT;

    return (
        <CostLotEventsTable
            {...preset}
            versionId={versionId}
            baseCurrency={baseCurrency}
            onTransactionClick={onTransactionClick}
            hidePagination={hidePagination}
            storageKey={assetId ? `pnl_asset_${assetId}_events` : "pnl_audit_events"}
            assetContext={assetId ? { id: assetId } : undefined}
        />
    );
};

// ============================================================================
// Realized P&L Tab - Shows disposal events with price, origin TX, warnings
// ============================================================================

const RealizedPnLTab: React.FC<{
    entries: RealizedPnLRow[];
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}> = ({ entries = [], baseCurrency, onTransactionClick }) => {
    const [search, setSearch] = useState('');
    const [taxableFilter, setTaxableFilter] = useState<'all' | 'taxable' | 'non-taxable'>('all');

    const filtered = useMemo(() => {
        return entries.filter(e => {
            if (taxableFilter === 'taxable' && !e.disposal_taxable) return false;
            if (taxableFilter === 'non-taxable' && e.disposal_taxable) return false;
            if (search) {
                const s = search.toLowerCase();
                const symbol = e.asset?.symbol ?? '';
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
                        Total P&L: <strong style={{ color: stats.totalPnL >= 0 ? 'green' : 'red' }}>
                            <ValueDisplay value={stats.totalPnL} currency={baseCurrency} />
                        </strong>
                    </Text>
                    <Text fontSize="sm" color="gray.500">
                        Taxable: <strong style={{ color: stats.taxablePnL >= 0 ? 'green' : 'red' }}>
                            <ValueDisplay value={stats.taxablePnL} currency={baseCurrency} />
                        </strong>
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
                        {sorted.map((entry) => {
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
                                        <Badge size="sm">{entry.asset.symbol}</Badge>
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontFamily="mono" fontSize="sm">
                                        {formatQty(entry.qty)}
                                    </Table.Cell>
                                    {/* Combined FMV Price & Source column */}
                                    <Table.Cell textAlign="right" fontSize="sm">
                                        <Flex direction="column" align="flex-end" gap={0}>
                                            <Text>
                                                {fmvPrice != null ? <ValueDisplay value={fmvPrice} currency={baseCurrency} /> : '-'}
                                            </Text>
                                            {sourceLabel && (
                                                <Badge size="xs" colorPalette={sourceColor} variant="subtle">
                                                    {sourceLabel}
                                                </Badge>
                                            )}
                                        </Flex>
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontSize="sm">
                                        <ValueDisplay value={entry.proceeds_in_base} currency={baseCurrency} />
                                    </Table.Cell>
                                    <Table.Cell textAlign="right" fontSize="sm">
                                        <ValueDisplay value={entry.cost_basis_in_base} currency={baseCurrency} />
                                    </Table.Cell>
                                    <Table.Cell
                                        textAlign="right"
                                        fontWeight="bold"
                                        color={entry.pnl_in_base >= 0 ? 'green.600' : 'red.600'}
                                    >
                                        <ValueDisplay value={entry.pnl_in_base} currency={baseCurrency} />
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
}> = ({ fees = [], baseCurrency, onTransactionClick, onUnitClick }) => {
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
                            <ValueDisplay value={totalFees} currency={baseCurrency} />
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
                        {filtered.map((fee) => (
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
                                        <ValueDisplay value={fee.fee_in_base} currency={baseCurrency} />
                                    </Text>
                                </Table.Cell>
                                <Table.Cell textAlign="right">
                                    <Text fontSize="xs" color="gray.600">
                                        {fee.cost_basis_consumed != null
                                            ? <ValueDisplay value={fee.cost_basis_consumed} currency={baseCurrency} />
                                            : '-'}
                                    </Text>
                                </Table.Cell>
                                <Table.Cell textAlign="right">
                                    {fee.realized_pnl != null ? (
                                        <Text
                                            fontSize="xs"
                                            color={fee.realized_pnl >= 0 ? 'green.600' : 'red.600'}
                                        >
                                            <ValueDisplay value={fee.realized_pnl} currency={baseCurrency} />
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
    assets?: Array<AssetRef>;
}> = ({ warnings = [], baseCurrency, onTransactionClick, quoteAssetId, onPriceAdded, assets }) => {
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
        return asset?.symbol || `#${assetId}`;
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
                        {filtered.map((warning, i) => {
                            const typeConfig = getWarningTypeConfig(warning.warning_type);
                            return (
                                <Table.Row key={i} bg={`${typeConfig.colorPalette}.50`}>
                                    <Table.Cell>
                                        <Text fontSize="2xs" color="gray.600">
                                            {warning.timestamp
                                                ? formatDateTimeLocale(warning.timestamp)
                                                : '-'
                                            }
                                        </Text>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Badge colorPalette={typeConfig.colorPalette} size="xs">
                                            {typeConfig.icon} {warning.warning_type}
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
                            );
                        })}
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
}> = ({ settlements = [], costLots = [], baseCurrency, onTransactionClick }) => {
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
                            <ValueDisplay value={stats.totalCostApplied} currency={baseCurrency} />
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
                        {sorted.map((settlement) => {
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
                                            <ValueDisplay value={settlement.cost_basis_applied} currency={baseCurrency} />
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
// Lot Events Tab - Audit trail for lot lifecycle events
// ============================================================================

const LotEventsTab: React.FC<{
    versionId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}> = ({ versionId, baseCurrency, onTransactionClick }) => {
    return (
        <CostLotEventsTable
            {...EVENT_TABLE_PRESETS.AUDIT}
            versionId={versionId}
            baseCurrency={baseCurrency}
            onTransactionClick={onTransactionClick}
            storageKey="pnl_audit_lot_events"
        />
    );
};

// ============================================================================
// Transactions Tab - Shows included/excluded transactions with toggle
// ============================================================================

const TransactionsTab: React.FC<{
    versionId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
}> = ({ versionId, baseCurrency, onTransactionClick }) => {
    const [view, setView] = useState<'included' | 'excluded'>('included');
    const [includedCount, setIncludedCount] = useState<number | null>(null);
    const [excludedCount, setExcludedCount] = useState<number | null>(null);

    // Controlled filter state
    const [filters, setFilters] = useState<TransactionFilterState>({
        reviewStatus: [],
        taxability: [],
        sources: [],
        accountIds: [],
        fromAccountIds: [],
        toAccountIds: [],
        relatedAccountIds: [],
        assetIds: [],
        relatedAssetIds: [],
        categoryIds: [],
        transactionTypes: [],
        directions: [],
        connectorRunIds: [],
        tagKeys: [],
        networks: [],
        dateFrom: '',
        dateTo: '',
        nonOwned: false,
        versionId: String(versionId),
        inclusionStatus: 'included',
    });

    // Update filters when view changes
    useEffect(() => {
        setFilters(prev => ({
            ...prev,
            inclusionStatus: view,
        }));
    }, [view]);

    // Fetch counts on mount
    useEffect(() => {
        const fetchCounts = async () => {
            try {
                // Fetch included count
                const includedRes = await fetch(
                    `${API_URL}/transactions?pnl_cal_version=${versionId}&pnl_cal_inclusions_status=included&limit=1`
                );
                if (includedRes.ok) {
                    const includedData = await includedRes.json();
                    setIncludedCount(includedData.metadata?.filtered_count ?? 0);
                }

                // Fetch excluded count
                const excludedRes = await fetch(
                    `${API_URL}/transactions?pnl_cal_version=${versionId}&pnl_cal_inclusions_status=excluded&limit=1`
                );
                if (excludedRes.ok) {
                    const excludedData = await excludedRes.json();
                    setExcludedCount(excludedData.metadata?.filtered_count ?? 0);
                }
            } catch (error) {
                console.error('Failed to fetch transaction counts:', error);
            }
        };

        fetchCounts();
    }, [versionId]);

    // Base filters for reset
    const baseFilters = useMemo(() => ({
        reviewStatus: [],
        taxability: [],
        sources: [],
        accountIds: [],
        fromAccountIds: [],
        toAccountIds: [],
        relatedAccountIds: [],
        assetIds: [],
        relatedAssetIds: [],
        categoryIds: [],
        transactionTypes: [],
        directions: [],
        connectorRunIds: [],
        tagKeys: [],
        networks: [],
        dateFrom: '',
        dateTo: '',
        versionId: String(versionId),
        inclusionStatus: view,
        nonOwned: false,
    }), [versionId, view]);

    return (
        <Box>
            {/* Toggle between included/excluded */}
            <Flex mb={4} justify="center" gap={2}>
                <Button
                    size="sm"
                    variant={view === 'included' ? 'solid' : 'outline'}
                    colorPalette={view === 'included' ? 'blue' : 'gray'}
                    onClick={() => setView('included')}
                >
                    Included {includedCount !== null && `(${includedCount})`}
                </Button>
                <Button
                    size="sm"
                    variant={view === 'excluded' ? 'solid' : 'outline'}
                    colorPalette={view === 'excluded' ? 'blue' : 'gray'}
                    onClick={() => setView('excluded')}
                >
                    Excluded {excludedCount !== null && `(${excludedCount})`}
                </Button>
            </Flex>

            {/* Controlled transactions table */}
            <TransactionsTable
                tableId="pnl-explorer"
                title=""
                subtitle=""
                filters={filters}
                onFiltersChange={setFilters}
                resetFilters={baseFilters}
                showFilters={true}
                showBundles={false}
                showSuggestions={false}
                compact={true}
            />
        </Box>
    );
};

// Legacy-compatible export for PnLPanel integration
// Accepts optional costLots, realizedPnL, warnings, settlements, consumedSlices, fees
interface PnLAuditViewProps {
    calculationUnits?: CalculationUnit[];
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
    assets?: Array<AssetRef>;
    // Pagination props per tab
    unitsPagination?: { page: number; pageSize: number; total: number };
    lotsPagination?: { page: number; pageSize: number; total: number };
    realizedPagination?: { page: number; pageSize: number; total: number };
    feesPagination?: { page: number; pageSize: number; total: number };
    warningsPagination?: { page: number; pageSize: number; total: number };
    eventsPagination?: { page: number; pageSize: number; total: number };
    // Pagination change handlers
    onUnitsPageChange?: (page: number, pageSize: number) => void;
    onLotsPageChange?: (page: number, pageSize: number) => void;
    onRealizedPageChange?: (page: number, pageSize: number) => void;
    onFeesPageChange?: (page: number, pageSize: number) => void;
    onWarningsPageChange?: (page: number, pageSize: number) => void;
    onEventsPageChange?: (page: number, pageSize: number) => void;
}

export const PnLAuditView: React.FC<PnLAuditViewProps> = ({
    calculationUnits = [],
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
    // Pagination props
    unitsPagination,
    lotsPagination,
    realizedPagination,
    feesPagination,
    warningsPagination,
    eventsPagination,
    onUnitsPageChange,
    onLotsPageChange,
    onRealizedPageChange,
    onFeesPageChange,
    onWarningsPageChange,
    onEventsPageChange,
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

    // ── Transaction-level filters for P&L audit ──
    const defaultPnlFilterState: TransactionFilterState = useMemo(() => ({
        ...defaultFilterState,
        reviewStatus: [],  // not relevant for P&L
        taxability: [],    // not relevant for P&L
    }), []);

    const [txFilters, setTxFilters] = useState<TransactionFilterState>(defaultPnlFilterState);
    const [txFilterExpanded, setTxFilterExpanded] = useState(false);

    const txFilterParams = useMemo(
        () => buildPnLFilterParams(txFilters),
        [txFilters],
    );

    const pnlHiddenFilters: (keyof TransactionFilterState)[] = useMemo(
        () => ['reviewStatus', 'taxability', 'connectorRunIds'],
        [],
    );

    // Use provided data directly - no fallback derivation
    const costLots = propCostLots || [];
    const consumedSlices = propConsumedSlices || [];
    const realizedPnL = propRealizedPnL || [];
    const warnings = propWarnings || [];
    const fees = propFees || [];
    const settlements = propSettlements || [];

    // Tab title counts: use pagination total if available, otherwise idCounts from calculation
    // Shows accurate counts even before full data is lazy-loaded
    const unitsCount = unitsPagination?.total ?? (idCounts?.unitCount ?? 0);
    const lotsCount = lotsPagination?.total ?? (idCounts?.lotCount ?? 0);
    const consumedCount = consumedSlices.length > 0 ? consumedSlices.length : (idCounts?.consumedCount ?? 0);
    const realizedCount = realizedPagination?.total ?? (realizedPnL.length > 0 ? realizedPnL.length : (idCounts?.realizedCount ?? 0));
    const feesCount = feesPagination?.total ?? (fees.length > 0 ? fees.length : (idCounts?.feeCount ?? 0));
    const warningsCount = warningsPagination?.total ?? (warnings.length > 0 ? warnings.length : (idCounts?.warningCount ?? 0));
    const settlementsCount = settlements.length > 0 ? settlements.length : (idCounts?.settlementCount ?? 0);
    const eventsCount = eventsPagination?.total ?? (idCounts?.eventCount ?? 0);

    return (
        <Box mt={4}>
            {/* Transaction-level filters for P&L audit data */}
            {versionId && (
                <Box mb={4}>
                    <TransactionFilters
                        filters={txFilters}
                        onChange={setTxFilters}
                        onClear={() => { setTxFilters(defaultPnlFilterState); }}
                        expanded={txFilterExpanded}
                        onExpandedChange={setTxFilterExpanded}
                        resetFilters={defaultPnlFilterState}
                        filterOptionsUrl={`${API_URL}/pnl/versions/${versionId}/filter-options`}
                        filterOptionsQueryKey={['pnlFilterOptions', String(versionId)]}
                        hiddenFilters={pnlHiddenFilters}
                    />
                </Box>
            )}

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
                    <Tabs.Trigger value="transactions">
                        <FiFileText style={{ marginRight: 4 }} />
                        Transactions
                    </Tabs.Trigger>
                    <Tabs.Trigger value="warnings">
                        <FiAlertTriangle style={{ marginRight: 4 }} />
                        Warnings ({warningsCount})
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="units">
                    {versionId ? (
                        <UnitsTabWrapper
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                            lazy={true}
                            enabled={activeTab === 'units'}
                            txFilterParams={txFilterParams}
                            renderTab={({ units, baseCurrency, versionId, onTransactionClick }) => (
                                <UnitsTab
                                    units={units}
                                    baseCurrency={baseCurrency}
                                    costLots={[]}
                                    versionId={versionId}
                                    onTransactionClick={onTransactionClick}
                                    hidePagination={true}
                                />
                            )}
                        />
                    ) : (
                        <Box p={4} textAlign="center" color="gray.500">
                            No version ID available
                        </Box>
                    )}
                </Tabs.Content>

                <Tabs.Content value="lots">
                    {versionId ? (
                        <LotsTabWrapper
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                            lazy={true}
                            enabled={activeTab === 'lots'}
                            txFilterParams={txFilterParams}
                            renderTab={({ lots, baseCurrency, onTransactionClick }) => (
                                <CostLotsTab
                                    lots={lots}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                />
                            )}
                        />
                    ) : (
                        <Box p={4} textAlign="center" color="gray.500">
                            No version ID available
                        </Box>
                    )}
                </Tabs.Content>

                <Tabs.Content value="realized">
                    {versionId ? (
                        <RealizedTabWrapper
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                            lazy={true}
                            enabled={activeTab === 'realized'}
                            txFilterParams={txFilterParams}
                            renderTab={({ entries, baseCurrency, onTransactionClick }) => (
                                <RealizedPnLTab
                                    entries={entries}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                />
                            )}
                        />
                    ) : (
                        <Box p={4} textAlign="center" color="gray.500">
                            No version ID available
                        </Box>
                    )}
                </Tabs.Content>

                <Tabs.Content value="fees">
                    {versionId ? (
                        <FeesTabWrapper
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                            onUnitClick={onUnitClick}
                            lazy={true}
                            enabled={activeTab === 'fees'}
                            txFilterParams={txFilterParams}
                            renderTab={({ fees, baseCurrency, onTransactionClick, onUnitClick }) => (
                                <FeesTab
                                    fees={fees}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                    onUnitClick={onUnitClick}
                                />
                            )}
                        />
                    ) : (
                        <Box p={4} textAlign="center" color="gray.500">
                            No version ID available
                        </Box>
                    )}
                </Tabs.Content>

                <Tabs.Content value="events">
                    {versionId ? (
                        <LotEventsTab
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                        />
                    ) : (
                        <Box p={4} textAlign="center" color="gray.500">
                            No version ID available
                        </Box>
                    )}
                </Tabs.Content>

                <Tabs.Content value="transactions">
                    {versionId ? (
                        <TransactionsTabWrapper
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                            lazy={true}
                            enabled={activeTab === 'transactions'}
                            txFilterParams={txFilterParams}
                            renderTab={({ versionId, baseCurrency, onTransactionClick }) => (
                                <TransactionsTab
                                    versionId={versionId}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                />
                            )}
                        />
                    ) : (
                        <Box p={4} textAlign="center" color="gray.500">
                            No version ID available
                        </Box>
                    )}
                </Tabs.Content>

                <Tabs.Content value="warnings">
                    {versionId ? (
                        <WarningsTabWrapper
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            onTransactionClick={onTransactionClick}
                            quoteAssetId={quoteAssetId}
                            onPriceAdded={onPriceAdded}
                            assets={assets}
                            lazy={true}
                            enabled={activeTab === 'warnings'}
                            txFilterParams={txFilterParams}
                            renderTab={({ warnings, baseCurrency, onTransactionClick, quoteAssetId, onPriceAdded, assets }) => (
                                <WarningsTab
                                    warnings={warnings}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                    quoteAssetId={quoteAssetId}
                                    onPriceAdded={onPriceAdded}
                                    assets={assets}
                                />
                            )}
                        />
                    ) : (
                        <Box p={4} textAlign="center" color="gray.500">
                            No version ID available
                        </Box>
                    )}
                </Tabs.Content>
            </Tabs.Root>
        </Box>
    );
};

export default PnLAuditView;
