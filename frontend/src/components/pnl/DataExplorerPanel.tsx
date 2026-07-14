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
import { Badge, Button, Input, type BadgeColorScheme } from '../ui/primitives';
import { FiSearch, FiChevronDown, FiChevronRight, FiAlertTriangle, FiLayers, FiDatabase, FiDollarSign, FiLoader, FiLink, FiActivity, FiPlus, FiFileText } from 'react-icons/fi';
import { CalculationUnit, CostLot, RealizedPnLRow, PnLWarningItem, OriginTransactionDetail, Settlement, ConsumedSliceDetail, CostLotEventEntry, FeeEntry } from './types';
import { API_URL, AssetRef } from '../../types';
import { Tooltip } from '../ui/tooltip';
import { AssetBadge } from '../AssetBadge';
import { CompactTransactionBadgeRow } from '../CompactTransactionBadgeRow';
import { TransactionRow } from '../TransactionRow';
import { TransactionsTable } from '../TransactionsTable';
import { defaultFilterState, TransactionFilterState, TransactionFilters } from '../TransactionFilters';
import { buildPnLFilterParams } from '../../utils/pnlFilterParams';
import { PriceSetterDialog } from './PriceSetterDialog';
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

// Maps getWarningTypeConfig()'s free-form colorPalette string to a static Tailwind
// bg-*-50 class (Tailwind JIT requires literal class names, not interpolated ones).
const WARNING_BG: Record<string, string> = {
    orange: 'bg-orange-50',
    purple: 'bg-purple-50',
    red: 'bg-red-50',
    yellow: 'bg-yellow-50',
    gray: 'bg-gray-50',
    blue: 'bg-blue-50',
    green: 'bg-green-50',
};

const VALID_BADGE_COLORS: BadgeColorScheme[] = ['gray', 'blue', 'green', 'red', 'yellow', 'purple', 'orange'];
const toBadgeColor = (c: string): BadgeColorScheme =>
    (VALID_BADGE_COLORS as string[]).includes(c) ? (c as BadgeColorScheme) : 'gray';

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
        <div
            className="min-w-[250px] rounded-md bg-gray-800 p-2"
            onMouseEnter={fetchTransaction}
        >
            {loading ? (
                <div className="flex items-center gap-2">
                    <FiLoader className="animate-spin" />
                    <span className="text-xs text-gray-300">Loading...</span>
                </div>
            ) : error ? (
                <span className="text-xs text-red-300">Error: {error}</span>
            ) : txData ? (
                <div className="text-xs">
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">Date</span>
                        <span className="text-white">{txData.date_time ? formatDateTimeLocale(txData.date_time) : '-'}</span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">Account</span>
                        <span className="text-white">{txData.account_name || '-'}</span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">Type</span>
                        <span className="text-white">{txData.transaction_type || txData.source_transaction_type || '-'}</span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">Source</span>
                        <span className="text-white">{txData.source || '-'}</span>
                    </div>
                    <div className="mb-1 flex items-center justify-between">
                        <span className="text-gray-400">Asset</span>
                        <AssetBadge
                            asset={txData.linked_asset}
                            sourceSymbol={txData.source_asset_symbol}
                            size="xs"
                            maxLength={18}
                        />
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">Quantity</span>
                        <span className="font-mono text-white"><ValueDisplay value={txData.quantity} /></span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">Unit Price</span>
                        <span className="text-white"><ValueDisplay value={txData.price} /></span>
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">Total</span>
                        <span className="text-white">
                            {txData.total ? <ValueDisplay value={txData.total} currency={baseCurrency} /> : '-'}
                        </span>
                    </div>
                    <div className="mb-1 flex items-center justify-between">
                        <span className="text-gray-400">Quote Asset</span>
                        <AssetBadge
                            asset={txData.price_quote_asset}
                            sourceSymbol={txData.source_price_quote_asset_symbol}
                            size="xs"
                            colorPalette="cyan"
                            maxLength={15}
                        />
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">Fee</span>
                        <span className="text-white"><ValueDisplay value={txData.fee} /></span>
                    </div>
                    <div className="mb-1 flex items-center justify-between">
                        <span className="text-gray-400">Fee Quote</span>
                        <AssetBadge
                            asset={txData.fee_quote_asset}
                            sourceSymbol={txData.source_fee_quote_asset_symbol}
                            size="xs"
                            colorPalette="orange"
                            maxLength={15}
                        />
                    </div>
                    <div className="mb-1 flex justify-between">
                        <span className="text-gray-400">From/To Account</span>
                        <span className="text-white">
                            {txData.direction === 'inflow'
                                ? (txData.from_account_name
                                    ? `${txData.from_account_name}${txData.source_from_account && txData.source_from_account !== txData.from_account_name ? ` (${txData.source_from_account})` : ''}`
                                    : (txData.source_from_account || '-'))
                                : (txData.to_account_name
                                    ? `${txData.to_account_name}${txData.source_to_account && txData.source_to_account !== txData.to_account_name ? ` (${txData.source_to_account})` : ''}`
                                    : (txData.source_to_account || '-'))}
                        </span>
                    </div>
                </div>
            ) : (
                <span className="text-xs text-gray-400">Hover to load details</span>
            )}
        </div>
    );

    return (
        <Tooltip
            content={tooltipContent}
            openDelay={200}
            closeDelay={100}
        >
            <div className="inline-block" onMouseEnter={fetchTransaction}>
                {children}
            </div>
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
                size={size === 'xs' ? undefined : size}
                variant={variant}
                className={size === 'xs' ? 'h-6 px-2 text-xs' : undefined}
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
            <div className="flex items-center gap-1">
                <Button
                    className="h-6 px-2 text-xs"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); onTransactionClick?.(txId); }}
                >
                    TX #{txId}
                </Button>
                <FiLoader size={10} className="animate-spin" />
            </div>
        );
    }

    if (!txData) {
        return (
            <Button
                className="h-6 px-2 text-xs"
                variant="ghost"
                onClick={(e) => { e.stopPropagation(); onTransactionClick?.(txId); }}
            >
                TX #{txId}
            </Button>
        );
    }

    return (
        <div className="flex flex-col gap-0 text-[10px]">
            <div className="flex flex-wrap items-center gap-1">
                <Button
                    variant="ghost"
                    className="h-auto min-w-0 p-0 text-xs font-medium text-blue-600"
                    onClick={(e) => { e.stopPropagation(); onTransactionClick?.(txId); }}
                >
                    #{txId}
                </Button>
                {showType && txData.source_transaction_type && (
                    <Badge colorScheme="gray" className="text-[10px]">
                        {txData.source_transaction_type}
                    </Badge>
                )}
                {showAsset && txData.asset_symbol && (
                    <Badge
                        colorScheme={txData.direction === 'inflow' ? 'green' : txData.direction === 'outflow' ? 'red' : 'gray'}
                        className="text-[10px]"
                    >
                        {txData.direction === 'inflow' ? '+' : txData.direction === 'outflow' ? '−' : ''}{txData.asset_symbol}
                    </Badge>
                )}
                {showQty && txData.quantity != null && (
                    <span className="font-mono text-gray-600">
                        {formatQty(txData.quantity)}
                    </span>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-1 text-gray-500">
                {showDate && txData.date_time && (
                    <span>{formatDateLocale(txData.date_time)}</span>
                )}
                {showAccount && txData.account_name && (
                    <span>• {txData.account_name}</span>
                )}
                {txData.total != null && txData.total > 0 && (
                    <span>• <ValueDisplay value={txData.total} currency={baseCurrency} /></span>
                )}
            </div>
        </div>
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

export const UnitDetailRow: React.FC<UnitDetailRowProps> = ({ unit, baseCurrency, costLots, versionId, onTransactionClick }) => {
    // Get all transaction IDs for this unit
    const allTxIds = useMemo(() => {
        return unit.transactions.map(tx => tx.id);
    }, [unit.transactions]);

    // Build filters to show only this unit's transactions
    const txFilters = useMemo<TransactionFilterState>(() => ({
        ...defaultFilterState,
        transactionIds: allTxIds,
    }), [allTxIds]);

    // Build a map of cost_lot_id -> CostLot for quick lookup
    const lotMap = useMemo(() => {
        const map = new Map<number, CostLot>();
        for (const lot of costLots) {
            map.set(lot.cost_lot_id, lot);
        }
        return map;
    }, [costLots]);

    return (
        <div className="rounded-md bg-gray-50 p-4">
            <div className="flex flex-col gap-4">
                {/* Origin Transactions - Full Width - Uses TransactionsTable in embedded mode */}
                <div className="border border-gray-200 bg-white">
                    <div className="p-3">
                        <div className="mb-2 text-xs font-bold text-gray-600">
                            📄 Origin Transactions ({allTxIds.length})
                        </div>
                        {allTxIds.length > 0 ? (
                            <TransactionsTable
                                filters={txFilters}
                                showFilters={false}
                                showBundles={false}
                                embeddedMode={true}
                                compact={true}
                                tableId={`unit-detail-${unit.unit_id}`}
                            />
                        ) : (
                            <span className="text-xs text-gray-400">No transactions</span>
                        )}
                    </div>
                </div>

                {/* Realized P&L - Full Width */}
                <div className="overflow-hidden border border-gray-200 bg-white">
                    <div className="overflow-auto p-3">
                        <div className="mb-2 text-xs font-bold text-green-600">
                            💰 Realized P&L ({unit.realized_entries?.length || 0})
                        </div>
                        {unit.realized_entries && unit.realized_entries.length > 0 ? (
                            <div className="overflow-x-auto">
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' }}>Asset</th>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'right' }}>Qty</th>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'right' }}>Proceeds</th>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'right' }}>FMV Price</th>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'center' }}>Source</th>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' }}>FMV Time</th>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'right' }}>Cost Basis</th>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'right' }}>P&L</th>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'center' }}>Taxability</th>
                                            <th style={{ padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'center' }}>Origin</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {unit.realized_entries.map((entry, i) => (
                                            <tr key={i} style={{ borderBottom: '1px solid #f1f3f5', background: entry.is_fee ? '#FFFAF0' : undefined }}>
                                                <td style={{ padding: '3px 6px' }}>
                                                    <Badge className="text-[10px]">{entry.asset.symbol || `#${entry.asset.id}`}</Badge>
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    <ValueDisplay value={entry.qty} />
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    <ValueDisplay value={entry.proceeds_in_base} currency={baseCurrency} />
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    {entry.proceeds_price != null
                                                        ? <ValueDisplay value={entry.proceeds_price} currency={baseCurrency} />
                                                        : <span className="text-[10px] text-gray-400">-</span>}
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                                                    {entry.proceeds_price_source ? (
                                                        <Badge className="text-[10px]"
                                                            colorScheme={
                                                                entry.proceeds_source === 'fmv' || entry.proceeds_source === 'fmv_lookup' ? 'yellow'
                                                                    : entry.proceeds_source === 'provisional' ? 'orange'
                                                                        : 'gray'
                                                            }>
                                                            {entry.proceeds_price_source}
                                                        </Badge>
                                                    ) : <span className="text-[10px] text-gray-400">-</span>}
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    <span className="whitespace-nowrap text-[10px] text-gray-500">
                                                        {entry.proceeds_price_timestamp ? formatDateLocale(entry.proceeds_price_timestamp) : '-'}
                                                    </span>
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    <ValueDisplay value={entry.cost_basis_in_base} currency={baseCurrency} />
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    <span className={`text-[10px] font-medium ${entry.pnl_in_base >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                        <ValueDisplay value={entry.pnl_in_base} currency={baseCurrency} />
                                                    </span>
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                                                    <Badge className="text-[10px]"
                                                        colorScheme={entry.disposal_taxable ? 'red' : 'green'}>
                                                        {entry.disposal_taxable ? 'Taxable' : 'Non-Taxable'}
                                                    </Badge>
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                                                    <Badge colorScheme={entry.is_fee ? 'orange' : 'blue'} className="text-[10px]">
                                                        {entry.is_fee ? 'Fee' : 'Disposal'}
                                                    </Badge>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <span className="text-xs text-gray-400">No realized P&L</span>
                        )}
                    </div>
                </div>

                {/* Cost Lot Events - Full Width */}
                <div className="overflow-hidden border border-gray-200 bg-white">
                    <div className="overflow-auto p-3">
                        <div className="mb-2 text-xs font-bold text-gray-600">
                            📦 Cost Lot Events
                        </div>
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
                    </div>
                </div>

                {/* Warnings Card - Full Width */}
                {(unit.warnings && unit.warnings.length > 0) && (
                    <div className="border border-orange-200 bg-orange-50">
                        <div className="p-3">
                            <div className="mb-2 text-xs font-bold text-orange-600">
                                <FiAlertTriangle style={{ display: 'inline', marginRight: 4 }} />
                                Warnings ({unit.warnings.length})
                            </div>
                            {unit.warnings.map((w, i) => (
                                <div key={i} className="mb-1 border-l-[3px] border-orange-400 bg-white p-2">
                                    <div className="text-xs font-medium text-orange-800">{w.warning_type}</div>
                                    <div className="text-xs text-gray-700">{w.message}</div>
                                    {w.transaction_id && (
                                        <TransactionCell
                                            txId={w.transaction_id}
                                            baseCurrency={baseCurrency}
                                            onTransactionClick={onTransactionClick}
                                            prefix="View TX"
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
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
        <div>
            {/* Filters only - no stats cards */}
            <div className="mb-4 flex flex-wrap gap-2">
                <div className="flex max-w-[300px] flex-1 items-center gap-1 rounded-md bg-gray-50 px-2">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search asset, label..."
                        className="h-8 border-none text-sm focus:shadow-none"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <div className="flex gap-1">
                    <Button
                        className="h-6 px-2 text-xs"
                        variant={typeFilter === 'all' ? 'solid' : 'outline'}
                        onClick={() => setTypeFilter('all')}
                    >
                        All ({units.length})
                    </Button>
                    {types.map(type => (
                        <Button
                            key={type}
                            className="h-6 px-2 text-xs capitalize"
                            variant={typeFilter === type ? 'solid' : 'outline'}
                            onClick={() => setTypeFilter(type)}
                        >
                            {type}
                        </Button>
                    ))}
                </div>
            </div>

            <div className="overflow-x-auto" style={{ fontSize: '8px' }}>
                <table className="w-full text-sm">
                    <thead>
                        <tr>
                            <th className="w-[70px] text-left">Type</th>
                            <th className="w-[80px] text-left">Date</th>
                            <th className="text-left">Operation</th>
                            <th className="w-[80px] text-left">Events</th>
                            <th className="w-[90px] text-right">P&L</th>
                            <th className="w-[80px] text-right">Fees</th>
                            <th className="w-[40px] text-center">⚠</th>
                        </tr>
                    </thead>
                    <tbody>
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
                                        <span key={`inflow-${idx}`} className="inline-flex items-center gap-0.5">
                                            <span className="text-xs font-bold text-green-500">↓</span>
                                            <span className="text-xs text-green-600">{formatQty(leg.qty)}</span>
                                            {leg.asset?.id ? (
                                                <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                            ) : (
                                                <span className="text-xs text-green-600">{leg.asset?.symbol || '?'}</span>
                                            )}
                                        </span>
                                    ));
                                    const outflow = outflowLegs.map((leg, idx) => (
                                        <span key={`outflow-${idx}`} className="inline-flex items-center gap-0.5">
                                            <span className="text-xs font-bold text-red-500">↑</span>
                                            <span className="text-xs text-red-600">{formatQty(leg.qty)}</span>
                                            {leg.asset?.id ? (
                                                <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                            ) : (
                                                <span className="text-xs text-red-600">{leg.asset?.symbol || '?'}</span>
                                            )}
                                        </span>
                                    ));
                                    const fee = feeLegs.map((leg, idx) => (
                                        <span key={`fee-${idx}`} className="inline-flex items-center gap-0.5">
                                            <span className="text-xs font-bold text-orange-500">💸</span>
                                            <span className="text-xs text-orange-600">{formatQty(leg.qty)}</span>
                                            {leg.asset?.id ? (
                                                <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                            ) : (
                                                <span className="text-xs text-orange-600">{leg.asset?.symbol || '?'}</span>
                                            )}
                                        </span>
                                    ));
                                    return (
                                        <div className="ml-2 flex flex-wrap items-center gap-0.5">
                                            {/* Inflow legs */}
                                            {inflow.length > 0 && inflow}
                                            {/* Separator if both inflow and outflow */}
                                            {inflow.length > 0 && outflow.length > 0 && (
                                                <span className="px-0.5 text-xs text-gray-400">|</span>
                                            )}
                                            {/* Outflow legs */}
                                            {outflow.length > 0 && outflow}
                                            {/* Separator if any fee legs */}
                                            {(inflow.length > 0 || outflow.length > 0) && fee.length > 0 && (
                                                <span className="px-0.5 text-xs text-gray-400">|</span>
                                            )}
                                            {/* Fee legs */}
                                            {fee.length > 0 && fee}
                                        </div>
                                    );
                                }
                                // Legacy format fallback
                                const inflow = (inflowLegs || []).map((leg, idx) => (
                                    <span key={`inflow-legacy-${idx}`} className="inline-flex items-center gap-1">
                                        <span className="text-xs font-bold text-green-500">↓</span>
                                        <span className="text-xs text-green-600">{leg.qty.toFixed(8)}</span>
                                        {leg.asset?.id ? (
                                            <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                        ) : (
                                            <span className="text-xs text-green-600">{leg.asset?.symbol || '?'}</span>
                                        )}
                                    </span>
                                ));
                                const outflow = (outflowLegs || []).map((leg, idx) => (
                                    <span key={`outflow-legacy-${idx}`} className="inline-flex items-center gap-1">
                                        <span className="text-xs font-bold text-red-500">↑</span>
                                        <span className="text-xs text-red-600">{leg.qty.toFixed(8)}</span>
                                        {leg.asset?.id ? (
                                            <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                        ) : (
                                            <span className="text-xs text-red-600">{leg.asset?.symbol || '?'}</span>
                                        )}
                                    </span>
                                ));
                                const fee = (feeLegs || []).map((leg, idx) => (
                                    <span key={`fee-legacy-${idx}`} className="inline-flex items-center gap-1">
                                        <span className="text-xs font-bold text-orange-500">💸</span>
                                        <span className="text-xs text-orange-600">{leg.qty.toFixed(8)}</span>
                                        {leg.asset?.id ? (
                                            <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
                                        ) : (
                                            <span className="text-xs text-orange-600">{leg.asset?.symbol || '?'}</span>
                                        )}
                                    </span>
                                ));
                                return (
                                    <div className="ml-2 flex flex-wrap items-center gap-1">
                                        {inflow.length > 0 && inflow}
                                        {inflow.length > 0 && outflow.length > 0 && (
                                            <span className="px-1 text-xs text-gray-400">|</span>
                                        )}
                                        {outflow.length > 0 && outflow}
                                        {(inflow.length > 0 || outflow.length > 0) && fee.length > 0 && (
                                            <span className="px-1 text-xs text-gray-400">|</span>
                                        )}
                                        {fee.length > 0 && fee}
                                    </div>
                                );
                            };


                            const mainLabel = renderOperationLabel();
                            const warningCount = unit.warnings?.length || 0;
                            const txCount = Object.keys(unit.transactions || {}).length;

                            return (
                                <React.Fragment key={unit.unit_id}>
                                    <tr onClick={() => toggleExpand(unit.unit_id)} className="cursor-pointer hover:bg-gray-50">
                                        <td>
                                            <Badge
                                                className="text-[10px]"
                                                colorScheme={
                                                    unit.pattern === 'swap' ? 'orange' :
                                                        unit.pattern === 'transfer' ? 'blue' : 'gray'
                                                }
                                            >
                                                {unit.pattern || 'unknown'}
                                            </Badge>
                                        </td>
                                        <td className="text-[10px]">{formatDateLocale(unit.date)}</td>
                                        {/* Operation Column: Icon + Label + Sub-label + Transactions */}
                                        <td>
                                            <div className="flex flex-col gap-0.5">
                                                <div className="flex items-center gap-1">
                                                    <span className="text-xs font-medium">
                                                        {mainLabel}
                                                    </span>
                                                </div>
                                                {/* Display transactions with truncated account/source badges */}
                                                {(() => {
                                                    if (unit.transactions.length > 0) {
                                                        return (
                                                            <div className="mt-0.5 flex flex-col gap-0.5 bg-gray-100">
                                                                {unit.transactions.slice(0, 3).map((tx: any) => (
                                                                    <TransactionRow
                                                                        key={tx.id}
                                                                        baseCurrency={baseCurrency}
                                                                        onTransactionClick={onTransactionClick}
                                                                        transaction={tx} />
                                                                ))}
                                                                {txCount > 3 && (
                                                                    <span className="pl-1 text-[10px] text-gray-500">+{txCount - 3} more transactions</span>
                                                                )}
                                                            </div>
                                                        );
                                                    }
                                                    return null;
                                                })()}
                                            </div>
                                        </td>
                                        {/* Events count cell - uses event_ids from API (simple total count) */}
                                        <td>
                                            {(() => {
                                                const eventCount = unit.event_ids?.length ?? 0;

                                                if (eventCount === 0) {
                                                    return <span className="text-[10px] text-gray-400">—</span>;
                                                }

                                                return (
                                                    <Badge className="text-[10px]" colorScheme="blue">{eventCount}</Badge>
                                                );
                                            })()}
                                        </td>
                                        <td className="text-right">
                                            <span className={`text-xs font-medium ${(unit.realized_pnl_in_base || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                <ValueDisplay value={unit.realized_pnl_in_base || 0} currency={baseCurrency} />
                                            </span>
                                        </td>
                                        <td className="text-right">
                                            {unit.has_fees && unit.total_fees_in_base ? (
                                                <span className="text-xs text-orange-600">
                                                    <ValueDisplay value={unit.total_fees_in_base} currency={baseCurrency} />
                                                </span>
                                            ) : (
                                                <span className="text-[10px] text-gray-400">-</span>
                                            )}
                                        </td>
                                        <td className="text-center">
                                            {warningCount > 0 ? (
                                                <Badge className="text-[10px]" colorScheme="orange">
                                                    <FiAlertTriangle style={{ marginRight: 2 }} />
                                                    {warningCount}
                                                </Badge>
                                            ) : (
                                                <span className="text-[10px] text-gray-400">-</span>
                                            )}
                                        </td>
                                    </tr>
                                    {expandedUnits.has(unit.unit_id) && (
                                        <tr>
                                            <td colSpan={7} style={{ background: '#f9fafb', padding: 0 }}>
                                                <UnitDetailRow unit={unit} baseCurrency={baseCurrency} costLots={costLots} versionId={versionId} onTransactionClick={onTransactionClick} />
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {!hidePagination && (
                <TablePagination
                    page={pagination.page}
                    pageSize={pagination.pageSize}
                    total={filtered.length}
                    onPageChange={pagination.setPage}
                    onPageSizeChange={pagination.setPageSize}
                />
            )}
        </div>
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
        <div>
            {/* Filters */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="flex max-w-[250px] flex-1 items-center gap-1 rounded-md bg-gray-50 px-2">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search asset, lot ID, account..."
                        className="h-8 border-none text-sm focus:shadow-none"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>

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
            </div>

            {/* Status Filter Buttons */}
            <div className="mb-3 flex flex-wrap gap-1">
                <Button
                    className="h-6 px-2 text-xs"
                    variant={statusFilter === 'all' ? 'solid' : 'outline'}
                    onClick={() => setStatusFilter('all')}
                >
                    All ({stats.total})
                </Button>
                <Button
                    className="h-6 px-2 text-xs"
                    variant={statusFilter === 'open' ? 'solid' : 'outline'}
                    colorScheme="green"
                    onClick={() => setStatusFilter('open')}
                >
                    Open ({stats.open})
                </Button>
                <Button
                    className="h-6 px-2 text-xs"
                    variant={statusFilter === 'exhausted' ? 'solid' : 'outline'}
                    colorScheme="gray"
                    onClick={() => setStatusFilter('exhausted')}
                >
                    Exhausted ({stats.exhausted})
                </Button>
                {stats.negative > 0 && (
                    <Button
                        className="h-6 px-2 text-xs"
                        variant={statusFilter === 'negative' ? 'solid' : 'outline'}
                        colorScheme="red"
                        onClick={() => setStatusFilter('negative')}
                    >
                        Negative ({stats.negative})
                    </Button>
                )}
            </div>

            {/* Summary */}
            <div className="mb-3 flex gap-4 text-sm text-gray-600">
                <span>
                    <Badge colorScheme="green" className="mr-1">Open</Badge>
                    <ValueDisplay value={stats.totalCostBasis} currency={baseCurrency} /> total cost basis
                </span>
            </div>

            {/* Table */}
            <div className="overflow-x-auto" style={{ fontSize: '8px' }}>
                <table className="w-full text-sm">
                    <thead>
                        <tr>
                            <th className="w-[80px] text-left">Status</th>
                            <th className="text-left">Asset</th>
                            <th className="w-[100px] text-left">Acquired</th>
                            <th className="text-right">Qty Original</th>
                            <th className="text-right">Qty Remaining</th>
                            <th className="text-right">Unit Cost</th>
                            <th className="text-right">Total Cost</th>
                            <th className="text-left">Source</th>
                            <th className="text-left">Account</th>
                            <th className="text-left">Origin TX</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((lot) => {
                            const isNegative = lot.unit_cost_in_base < 0 || lot.total_cost_in_base < 0 || lot.qty_remaining < 0;
                            const isExhausted = lot.qty_remaining === 0;
                            const pctRemaining = lot.qty_original > 0 ? (lot.qty_remaining / lot.qty_original) * 100 : 0;

                            return (
                                <tr
                                    key={lot.cost_lot_id}
                                    className={isNegative ? 'bg-red-50' : isExhausted ? 'bg-gray-50' : undefined}
                                >
                                    <td>
                                        <div className="flex flex-col gap-1">
                                            <Badge
                                                className="text-[10px]"
                                                colorScheme={isNegative ? 'red' : isExhausted ? 'gray' : 'green'}
                                            >
                                                {isNegative ? '⚠ Negative' : isExhausted ? 'Exhausted' : 'Open'}
                                            </Badge>
                                            {!isExhausted && !isNegative && pctRemaining < 100 && (
                                                <span className="text-[10px] text-gray-500">{pctRemaining.toFixed(0)}% left</span>
                                            )}
                                        </div>
                                    </td>
                                    <td>
                                        <Badge className="text-[10px]">{lot.asset?.symbol ?? lot.asset_symbol ?? `#${lot.asset_id}`}</Badge>
                                    </td>
                                    <td className="text-xs">{formatDateLocale(lot.acquired_at)}</td>
                                    <td className="text-right font-mono text-xs">
                                        <ValueDisplay value={lot.qty_original} />
                                    </td>
                                    <td className="text-right font-mono text-xs">
                                        <span className={isExhausted ? 'text-gray-400' : undefined}>
                                            <ValueDisplay value={lot.qty_remaining} />
                                        </span>
                                    </td>
                                    <td className="text-right text-xs">
                                        {lot.is_zero_cost ? (
                                            <Badge colorScheme="red" className="text-[10px]" title="Zero cost — likely missing price">Zero</Badge>
                                        ) : lot.cost_source === 'provisional' ? (
                                            <Tooltip
                                                content={
                                                    <div className="text-xs">
                                                        <div className="font-semibold">Provisional Cost</div>
                                                        <div>FMV-based estimate for negative lot.</div>
                                                        {lot.cost_fmv_price != null && <div>FMV: {Number(lot.cost_fmv_price).toFixed(6)} {baseCurrency}</div>}
                                                        {lot.cost_fmv_source && <div>Source: {lot.cost_fmv_source}</div>}
                                                        <div className="mt-1 text-orange-300">Will be settled when acquisition arrives.</div>
                                                    </div>
                                                }
                                                openDelay={200}
                                            >
                                                <Badge colorScheme="orange" className="cursor-help text-[10px]">
                                                    <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                                </Badge>
                                            </Tooltip>
                                        ) : lot.cost_source === 'fmv' && lot.cost_fmv_stale ? (
                                            <Tooltip
                                                content={
                                                    <div className="text-xs">
                                                        <div className="font-semibold">Stale FMV Price</div>
                                                        {lot.cost_fmv_price != null && <div>Price: {Number(lot.cost_fmv_price).toFixed(6)} {baseCurrency}</div>}
                                                        {lot.cost_fmv_source && <div>Source: {lot.cost_fmv_source}</div>}
                                                        {lot.cost_fmv_timestamp && <div>Snapped: {new Date(lot.cost_fmv_timestamp).toLocaleString()}</div>}
                                                        <div className="mt-1 text-orange-300">⚠ Price exceeds staleness window</div>
                                                    </div>
                                                }
                                                openDelay={200}
                                            >
                                                <Badge colorScheme="yellow" className="cursor-help text-[10px]">
                                                    <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                                </Badge>
                                            </Tooltip>
                                        ) : (
                                            <span className={isNegative ? 'text-red-600' : undefined}>
                                                <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                            </span>
                                        )}
                                    </td>
                                    <td className="text-right text-xs">
                                        {lot.is_zero_cost ? (
                                            <Badge colorScheme="red" className="text-[10px]" title="Zero cost — likely missing price">Zero</Badge>
                                        ) : (
                                            <span className={isNegative ? 'text-red-600' : undefined}>
                                                <ValueDisplay value={lot.total_cost_in_base} currency={baseCurrency} />
                                            </span>
                                        )}
                                    </td>
                                    <td className="text-xs">
                                        {lot.cost_source ? (
                                            (lot.cost_fmv_price || lot.cost_fmv_source || lot.cost_fmv_timestamp) ? (
                                                <Tooltip
                                                    content={
                                                        <div className="text-xs leading-relaxed">
                                                            <div className="mb-1 font-semibold">FMV Details</div>
                                                            {lot.cost_fmv_price != null && (
                                                                <div>Price: {Number(lot.cost_fmv_price).toFixed(6)} {baseCurrency}</div>
                                                            )}
                                                            {lot.cost_fmv_source && (
                                                                <div>Source: {lot.cost_fmv_source}</div>
                                                            )}
                                                            {lot.cost_fmv_timestamp && (
                                                                <div>Snapped: {new Date(lot.cost_fmv_timestamp).toLocaleString()}</div>
                                                            )}
                                                            {lot.cost_fmv_stale && (
                                                                <div className="text-orange-300">⚠ Stale price</div>
                                                            )}
                                                        </div>
                                                    }
                                                    openDelay={200}
                                                    closeDelay={100}
                                                >
                                                    <Badge className="cursor-help text-[10px]" colorScheme={
                                                        lot.cost_source === 'base_currency' ? 'gray' :
                                                            lot.cost_source === 'proceeds' ? 'green' :
                                                                lot.cost_source === 'inherited' ? 'blue' :
                                                                    lot.cost_source === 'fmv' ? 'yellow' :
                                                                        lot.cost_source === 'provisional' ? 'orange' :
                                                                            'gray'
                                                    }>
                                                        {lot.cost_source}
                                                    </Badge>
                                                </Tooltip>
                                            ) : (
                                                <Badge className="text-[10px]" colorScheme={
                                                    lot.cost_source === 'base_currency' ? 'gray' :
                                                        lot.cost_source === 'proceeds' ? 'green' :
                                                            lot.cost_source === 'inherited' ? 'blue' :
                                                                lot.cost_source === 'fmv' ? 'yellow' :
                                                                    lot.cost_source === 'provisional' ? 'orange' :
                                                                        'gray'
                                                }>
                                                    {lot.cost_source}
                                                </Badge>
                                            )
                                        ) : '-'}
                                    </td>
                                    <td className="text-xs">{lot.account_name || '-'}</td>
                                    <td>
                                        {lot.origin_transaction_id ? (
                                            <TransactionCell
                                                txId={lot.origin_transaction_id}
                                                baseCurrency={baseCurrency}
                                                onTransactionClick={onTransactionClick}
                                                prefix=""
                                                size="xs"
                                            />
                                        ) : (
                                            <span className="text-xs text-gray-400">-</span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {sorted.length > 300 && (
                <div className="mt-2 text-center text-sm text-gray-500">
                    Showing first 300 of {sorted.length} lots
                </div>
            )}
        </div>
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
        <div>
            {/* Filters */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="flex max-w-[300px] flex-1 items-center gap-1 rounded-md bg-gray-50 px-2">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search asset..."
                        className="h-8 border-none text-sm focus:shadow-none"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <div className="flex gap-1">
                    <Button
                        className="h-6 px-2 text-xs"
                        variant={taxableFilter === 'all' ? 'solid' : 'outline'}
                        onClick={() => setTaxableFilter('all')}
                    >
                        All ({entries.length})
                    </Button>
                    <Button
                        className="h-6 px-2 text-xs"
                        variant={taxableFilter === 'taxable' ? 'solid' : 'outline'}
                        colorScheme="red"
                        onClick={() => setTaxableFilter('taxable')}
                    >
                        Taxable ({stats.taxableCount})
                    </Button>
                    <Button
                        className="h-6 px-2 text-xs"
                        variant={taxableFilter === 'non-taxable' ? 'solid' : 'outline'}
                        colorScheme="green"
                        onClick={() => setTaxableFilter('non-taxable')}
                    >
                        Non-taxable ({stats.nonTaxableCount})
                    </Button>
                </div>
                <div className="ml-auto flex gap-4">
                    <span className="text-sm text-gray-500">
                        Total P&L: <strong style={{ color: stats.totalPnL >= 0 ? 'green' : 'red' }}>
                            <ValueDisplay value={stats.totalPnL} currency={baseCurrency} />
                        </strong>
                    </span>
                    <span className="text-sm text-gray-500">
                        Taxable: <strong style={{ color: stats.taxablePnL >= 0 ? 'green' : 'red' }}>
                            <ValueDisplay value={stats.taxablePnL} currency={baseCurrency} />
                        </strong>
                    </span>
                </div>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr>
                            <th className="text-left">Date</th>
                            <th className="text-left">Asset</th>
                            <th className="text-right">Qty</th>
                            <th className="text-right">FMV Price</th>
                            <th className="text-right">Proceeds</th>
                            <th className="text-right">Cost Basis</th>
                            <th className="text-right">P&L</th>
                            <th className="text-left">Taxable</th>
                            <th className="text-left">Origin TX</th>
                            <th className="text-left">⚠</th>
                        </tr>
                    </thead>
                    <tbody>
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

                            const sourceColor: BadgeColorScheme = entry.proceeds_source === 'fmv_lookup'
                                ? 'blue'
                                : entry.proceeds_source === 'base_currency'
                                    ? 'green'
                                    : 'gray';

                            return (
                                <tr
                                    key={entry.id}
                                    className={entry.warnings && entry.warnings.length > 0 ? 'bg-orange-50' : undefined}
                                >
                                    <td className="text-sm">{formatDateLocale(entry.realized_at)}</td>
                                    <td>
                                        <Badge>{entry.asset.symbol}</Badge>
                                    </td>
                                    <td className="text-right font-mono text-sm">
                                        {formatQty(entry.qty)}
                                    </td>
                                    {/* Combined FMV Price & Source column */}
                                    <td className="text-right text-sm">
                                        <div className="flex flex-col items-end gap-0">
                                            <span>
                                                {fmvPrice != null ? <ValueDisplay value={fmvPrice} currency={baseCurrency} /> : '-'}
                                            </span>
                                            {sourceLabel && (
                                                <Badge className="text-[10px]" colorScheme={sourceColor}>
                                                    {sourceLabel}
                                                </Badge>
                                            )}
                                        </div>
                                    </td>
                                    <td className="text-right text-sm">
                                        <ValueDisplay value={entry.proceeds_in_base} currency={baseCurrency} />
                                    </td>
                                    <td className="text-right text-sm">
                                        <ValueDisplay value={entry.cost_basis_in_base} currency={baseCurrency} />
                                    </td>
                                    <td
                                        className={`text-right font-bold ${entry.pnl_in_base >= 0 ? 'text-green-600' : 'text-red-600'}`}
                                    >
                                        <ValueDisplay value={entry.pnl_in_base} currency={baseCurrency} />
                                    </td>
                                    <td>
                                        <Badge colorScheme={entry.disposal_taxable ? 'red' : 'green'}>
                                            {entry.disposal_taxable ? 'Yes' : 'No'}
                                        </Badge>
                                    </td>
                                    <td>
                                        {entry.transaction_id ? (
                                            <div className="flex flex-col gap-0">
                                                <TransactionCell
                                                    txId={entry.transaction_id}
                                                    baseCurrency={baseCurrency}
                                                    onTransactionClick={onTransactionClick}
                                                />
                                                {(entry.origin_tx_type || entry.origin_tx_source) && (
                                                    <span className="pl-1 text-xs text-gray-500">
                                                        {entry.origin_tx_type}{entry.origin_tx_source ? ` • ${entry.origin_tx_source}` : ''}
                                                    </span>
                                                )}
                                            </div>
                                        ) : (
                                            <span className="text-xs text-gray-400">-</span>
                                        )}
                                    </td>
                                    <td>
                                        {entry.warnings && entry.warnings.length > 0 && (
                                            <Badge colorScheme="orange" title={entry.warnings.map(w => w.message).join(', ')}>
                                                {entry.warnings.length}
                                            </Badge>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {sorted.length > 200 && (
                <div className="mt-2 text-center text-sm text-gray-500">
                    Showing first 200 of {sorted.length} entries
                </div>
            )}
        </div>
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
            <div className="py-8 text-center">
                <div className="font-bold text-gray-500">No fees recorded</div>
                <div className="text-sm text-gray-400">Fee entries will appear here after calculation</div>
            </div>
        );
    }

    return (
        <div>
            {/* Summary */}
            <div className="mb-4 flex flex-wrap gap-4">
                <div className="min-w-[150px] flex-1 border border-gray-200 bg-white">
                    <div className="px-3 py-2">
                        <div className="text-xs text-gray-500">Total Fees</div>
                        <div className="text-lg font-bold">
                            <ValueDisplay value={totalFees} currency={baseCurrency} />
                        </div>
                    </div>
                </div>
                <div className="min-w-[150px] flex-1 border border-gray-200 bg-white">
                    <div className="px-3 py-2">
                        <div className="text-xs text-gray-500">Fee Entries</div>
                        <div className="text-lg font-bold">{fees.length}</div>
                    </div>
                </div>
            </div>

            {/* Filters */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="relative max-w-[200px] flex-1">
                    <Input
                        placeholder="Search asset..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="h-8 pl-8"
                    />
                    <div className="absolute left-2 top-1/2 -translate-y-1/2">
                        <FiSearch size={14} color="gray" />
                    </div>
                </div>
                <Button
                    className={sourceFilter === 'all' ? 'h-6 bg-purple-600 px-2 text-xs text-white hover:bg-purple-700' : 'h-6 border-purple-300 px-2 text-xs text-purple-700 hover:bg-purple-50'}
                    variant={sourceFilter === 'all' ? 'solid' : 'outline'}
                    colorScheme="gray"
                    onClick={() => setSourceFilter('all')}
                >
                    All ({fees.length})
                </Button>
                {sources.map(src => (
                    <Button
                        key={src}
                        className={sourceFilter === src ? 'h-6 bg-purple-600 px-2 text-xs text-white hover:bg-purple-700' : 'h-6 border-purple-300 px-2 text-xs text-purple-700 hover:bg-purple-50'}
                        variant={sourceFilter === src ? 'solid' : 'outline'}
                        colorScheme="gray"
                        onClick={() => setSourceFilter(src)}
                    >
                        {src} ({sourceCounts[src]})
                    </Button>
                ))}
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr>
                            <th className="w-[100px] text-left">Date</th>
                            <th className="w-[80px] text-left">Source</th>
                            <th className="w-[70px] text-left">Asset</th>
                            <th className="text-right">Fee Qty</th>
                            <th className="text-right">Fee Value</th>
                            <th className="text-right">Cost Basis</th>
                            <th className="text-right">Realized P&L</th>
                            <th className="text-left">Transaction</th>
                            <th className="w-[60px] text-left">Unit</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((fee) => (
                            <tr key={fee.id}>
                                <td>
                                    <span className="text-[10px] text-gray-600">
                                        {fee.date ? formatDateLocale(fee.date) : '-'}
                                    </span>
                                </td>
                                <td>
                                    <Badge className="text-[10px]">{fee.source}</Badge>
                                </td>
                                <td>
                                    <Badge className="text-[10px]">{fee.asset_symbol}</Badge>
                                </td>
                                <td className="text-right">
                                    <span className="font-mono text-xs">
                                        {formatQty(fee.fee_amount)}
                                    </span>
                                </td>
                                <td className="text-right">
                                    <span className="text-xs">
                                        <ValueDisplay value={fee.fee_in_base} currency={baseCurrency} />
                                    </span>
                                </td>
                                <td className="text-right">
                                    <span className="text-xs text-gray-600">
                                        {fee.cost_basis_consumed != null
                                            ? <ValueDisplay value={fee.cost_basis_consumed} currency={baseCurrency} />
                                            : '-'}
                                    </span>
                                </td>
                                <td className="text-right">
                                    {fee.realized_pnl != null ? (
                                        <span
                                            className={`text-xs ${fee.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}
                                        >
                                            <ValueDisplay value={fee.realized_pnl} currency={baseCurrency} />
                                        </span>
                                    ) : (
                                        <span className="text-xs text-gray-400">-</span>
                                    )}
                                </td>
                                <td>
                                    {fee.transaction_id ? (
                                        <TransactionCell
                                            txId={fee.transaction_id}
                                            baseCurrency={baseCurrency}
                                            onTransactionClick={onTransactionClick}
                                            prefix=""
                                            size="xs"
                                        />
                                    ) : (
                                        <span className="text-xs text-gray-400">-</span>
                                    )}
                                </td>
                                <td>
                                    {fee.unit_id ? (
                                        <span
                                            className="cursor-pointer text-xs text-blue-600 hover:underline"
                                            onClick={() => onUnitClick?.(fee.unit_id!)}
                                        >
                                            #{fee.unit_id}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-gray-400">-</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {filtered.length > 200 && (
                <div className="mt-2 text-center text-xs text-gray-500">
                    Showing first 200 of {filtered.length} entries
                </div>
            )}
        </div>
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
            <div className="py-8 text-center">
                <div className="font-bold text-green-600">✓ No warnings</div>
                <div className="text-sm text-gray-500">All calculations completed without issues</div>
            </div>
        );
    }

    return (
        <div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button
                    className={typeFilter === 'all' ? 'h-6 bg-orange-600 px-2 text-xs text-white hover:bg-orange-700' : 'h-6 border-orange-300 px-2 text-xs text-orange-700 hover:bg-orange-50'}
                    variant={typeFilter === 'all' ? 'solid' : 'outline'}
                    onClick={() => setTypeFilter('all')}
                >
                    All ({warnings.length})
                </Button>
                {types.map(type => (
                    <Button
                        key={type}
                        className={typeFilter === type ? 'h-6 bg-orange-600 px-2 text-xs text-white hover:bg-orange-700' : 'h-6 border-orange-300 px-2 text-xs text-orange-700 hover:bg-orange-50'}
                        variant={typeFilter === type ? 'solid' : 'outline'}
                        onClick={() => setTypeFilter(type)}
                    >
                        {type} ({typeCounts[type]})
                    </Button>
                ))}
            </div>

            <div className="overflow-x-auto" style={{ fontSize: '8px' }}>
                <table className="w-full text-sm">
                    <thead>
                        <tr>
                            <th className="w-[100px] text-left">Date</th>
                            <th className="w-[90px] text-left">Type</th>
                            <th className="text-left">Message</th>
                            <th className="w-[180px] text-left">Transaction</th>
                            {quoteAssetId && <th className="w-[80px] text-left">Action</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((warning, i) => {
                            const typeConfig = getWarningTypeConfig(warning.warning_type);
                            return (
                                <tr key={i} className={WARNING_BG[typeConfig.colorPalette] ?? 'bg-gray-50'}>
                                    <td>
                                        <span className="text-[10px] text-gray-600">
                                            {warning.timestamp
                                                ? formatDateTimeLocale(warning.timestamp)
                                                : '-'
                                            }
                                        </span>
                                    </td>
                                    <td>
                                        <Badge colorScheme={toBadgeColor(typeConfig.colorPalette)} className="text-[10px]">
                                            {typeConfig.icon} {warning.warning_type}
                                        </Badge>
                                    </td>
                                    <td>
                                        <span className="text-xs">{warning.message}</span>
                                    </td>
                                    <td>
                                        {warning.transaction_id ? (
                                            <TransactionCell
                                                txId={warning.transaction_id}
                                                baseCurrency={baseCurrency}
                                                onTransactionClick={onTransactionClick}
                                            />
                                        ) : (
                                            <span className="text-xs text-gray-400">-</span>
                                        )}
                                    </td>
                                    {quoteAssetId && (
                                        <td>
                                            {isPriceWarning(warning) && (
                                                <Button
                                                    className="h-6 px-2 text-xs"
                                                    colorScheme="green"
                                                    onClick={() => handleAddPriceClick(warning)}
                                                >
                                                    <FiPlus size={10} />
                                                </Button>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Manual Price Dialog */}
            {selectedWarning && selectedWarning.asset_id && quoteAssetId && (
                <PriceSetterDialog
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
        </div>
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
            <div className="py-8 text-center">
                <div className="font-bold text-gray-600">No settlements</div>
                <div className="text-sm text-gray-500">No negative lots have been settled yet</div>
            </div>
        );
    }

    return (
        <div>
            {/* Search */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="flex max-w-[300px] flex-1 items-center gap-1 rounded-md bg-gray-50 px-2">
                    <FiSearch color="gray" />
                    <Input
                        placeholder="Search lot UUID, asset..."
                        className="h-8 border-none text-sm focus:shadow-none"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            {/* Stats */}
            <div className="mb-3 flex flex-wrap gap-4 text-sm text-gray-600">
                <span>
                    <Badge colorScheme="blue" className="mr-1">{settlements.length}</Badge>
                    Settlements
                </span>
                <span>
                    <Badge colorScheme="red" className="mr-1">{stats.uniqueNegativeLots}</Badge>
                    Negative lots settled
                </span>
                <span>
                    <Badge colorScheme="green" className="mr-1">{stats.uniqueSettlingLots}</Badge>
                    Settling lots used
                </span>
                {stats.totalCostApplied > 0 && (
                    <span>
                        <Badge colorScheme="purple" className="mr-1">
                            <ValueDisplay value={stats.totalCostApplied} currency={baseCurrency} />
                        </Badge>
                        Cost basis applied
                    </span>
                )}
            </div>

            <div className="overflow-x-auto" style={{ fontSize: '8px' }}>
                <table className="w-full text-sm">
                    <thead>
                        <tr>
                            <th className="text-left">Date</th>
                            <th className="text-left">Negative Lot</th>
                            <th className="text-left">→</th>
                            <th className="text-left">Settling Lot</th>
                            <th className="text-right">Qty Settled</th>
                            <th className="text-right">Cost Basis</th>
                            <th className="text-left">Transaction</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((settlement) => {
                            const negativeLot = lotMap.get(settlement.negative_lot_id);
                            const settlingLot = lotMap.get(settlement.settling_lot_id);
                            return (
                                <tr key={settlement.settlement_id}>
                                    <td className="text-xs">
                                        {formatDateLocale(settlement.settled_at)}
                                    </td>
                                    <td>
                                        <div className="flex flex-col gap-0">
                                            <div className="flex items-center gap-1">
                                                <Badge colorScheme="red" className="text-[10px]">⚠</Badge>
                                                {negativeLot && (
                                                    <Badge className="text-[10px]">{negativeLot.asset_symbol}</Badge>
                                                )}
                                            </div>
                                            <span className="font-mono text-[10px] text-gray-500">
                                                #{settlement.negative_lot_id}
                                            </span>
                                            {negativeLot && (
                                                <div className="flex flex-col gap-0 text-[10px] text-gray-600">
                                                    <span>Orig: {formatQty(Math.abs(negativeLot.qty_original))}</span>
                                                    {negativeLot.origin_transaction_id && (
                                                        <TransactionTooltip txId={negativeLot.origin_transaction_id} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                                            <Button
                                                                variant="ghost"
                                                                className="h-auto min-w-0 p-0 text-[10px] font-normal text-blue-600"
                                                                onClick={(e) => { e.stopPropagation(); onTransactionClick?.(negativeLot.origin_transaction_id!); }}
                                                            >
                                                                TX #{negativeLot.origin_transaction_id}
                                                            </Button>
                                                        </TransactionTooltip>
                                                    )}
                                                    {negativeLot.is_fully_settled ? (
                                                        <Badge colorScheme="green" className="text-[10px]">✓ Settled</Badge>
                                                    ) : (
                                                        <Badge colorScheme="orange" className="text-[10px]">⏳ Pending</Badge>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                    <td>
                                        <FiLink size={12} color="gray" />
                                    </td>
                                    <td>
                                        <div className="flex flex-col gap-0">
                                            <div className="flex items-center gap-1">
                                                <Badge colorScheme="green" className="text-[10px]">+</Badge>
                                                {settlingLot && (
                                                    <Badge className="text-[10px]">{settlingLot.asset_symbol}</Badge>
                                                )}
                                            </div>
                                            <span className="font-mono text-[10px] text-gray-500">
                                                #{settlement.settling_lot_id}
                                            </span>
                                            {settlingLot && settlingLot.origin_transaction_id && (
                                                <TransactionTooltip txId={settlingLot.origin_transaction_id} baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                                    <Button
                                                        variant="ghost"
                                                        className="h-auto min-w-0 p-0 text-[10px] font-normal text-blue-600"
                                                        onClick={(e) => { e.stopPropagation(); onTransactionClick?.(settlingLot.origin_transaction_id!); }}
                                                    >
                                                        TX #{settlingLot.origin_transaction_id}
                                                    </Button>
                                                </TransactionTooltip>
                                            )}
                                        </div>
                                    </td>
                                    <td className="text-right font-mono text-xs">
                                        {formatQty(settlement.qty_settled)}
                                    </td>
                                    <td className="text-right text-xs">
                                        {settlement.cost_basis_applied != null ? (
                                            <ValueDisplay value={settlement.cost_basis_applied} currency={baseCurrency} />
                                        ) : (
                                            <span className="text-xs text-gray-400">-</span>
                                        )}
                                    </td>
                                    <td>
                                        {settlement.settling_transaction_id ? (
                                            <TransactionCell
                                                txId={settlement.settling_transaction_id}
                                                baseCurrency={baseCurrency}
                                                onTransactionClick={onTransactionClick}
                                                prefix=""
                                            />
                                        ) : (
                                            <span className="text-xs text-gray-400">-</span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {sorted.length > 200 && (
                <div className="mt-2 text-center text-sm text-gray-500">
                    Showing first 200 of {sorted.length} settlements
                </div>
            )}
        </div>
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
        attributedAssetIds: [],
        categoryIds: [],
        transactionTypes: [],
        directions: [],
        connectorRunIds: [],
        tagKeys: [],
        networks: [],
        dateFrom: '',
        dateTo: '',
        nonOwned: false,
        priceQuoteAssetIds: [],
        feeQuoteAssetIds: [],
        bundlePatterns: [],
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
        attributedAssetIds: [],
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
        priceQuoteAssetIds: [],
        feeQuoteAssetIds: [],
        bundlePatterns: [],
    }), [versionId, view]);

    return (
        <div>
            {/* Toggle between included/excluded */}
            <div className="mb-4 flex justify-center gap-2">
                <Button
                    size="sm"
                    variant={view === 'included' ? 'solid' : 'outline'}
                    colorScheme={view === 'included' ? 'blue' : 'gray'}
                    onClick={() => setView('included')}
                >
                    Included {includedCount !== null && `(${includedCount})`}
                </Button>
                <Button
                    size="sm"
                    variant={view === 'excluded' ? 'solid' : 'outline'}
                    colorScheme={view === 'excluded' ? 'blue' : 'gray'}
                    onClick={() => setView('excluded')}
                >
                    Excluded {excludedCount !== null && `(${excludedCount})`}
                </Button>
            </div>

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
        </div>
    );
};
