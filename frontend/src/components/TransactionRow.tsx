/**
 * ExpandableTransactionRow - Collapsible transaction row with leg details
 * 
 * Redesigned compact badge format:
 * - Collapsed: [▶] [TX#1234] [01/08 10:30] [Account:Source] [tx_type:source_tx_type] [BTC] 0.5 → 24K [USD] | 💸0.001 [BTC]
 * - Expanded:  [▼] [TX#1234] [01/08 10:30] [Account:Source] [tx_type:source_tx_type] [BTC] 0.5 → 24K [USD] | 💸0.001 [BTC]
 *                   ↑ 10 ETH  →  ↓ 0.8 BTC  |  💸 0.01 ETH
 * 
 * Badge colors:
 * - TX badge: gray
 * - DateTime badge: cyan (highlighted)
 * - Account:Source badge: purple
 * - Type badge: semantic colors
 * - Asset badge: teal
 * - Total: direction-based (green for inflow, red for outflow)
 * - Fee: orange
 * 
 * Arrow semantics:
 * - ↑ red = outflow (leaving wallet)
 * - ↓ green = inflow (entering wallet)
 * - 💸 orange = fee
 */

import React, { useState } from 'react';
import { Badge, type BadgeColorScheme } from './ui/primitives';
import { FiChevronRight, FiChevronDown } from 'react-icons/fi';
import { AssetBadge } from './AssetBadge';
import { TransactionTooltip } from './TransactionTooltip';
import {
    PnLTransaction,
    LegDetail,
} from './pnl/types';
import { TransactionSummary } from '@/types';


// ============================================================================
// Helpers
// ============================================================================

const formatQuantity = (qty: number | undefined | null): string => {
    if (qty == null || qty === 0) return '0';
    if (Math.abs(qty) < 0.0001) return qty.toExponential(2);
    if (Math.abs(qty) < 1) return qty.toFixed(6);
    if (Math.abs(qty) < 1000) return qty.toFixed(4);
    return qty.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

const formatTotal = (value: number | undefined | null): string => {
    if (value == null) return '';
    if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}K`;
    return value.toFixed(2);
};

const formatFee = (value: number | undefined | null): string => {
    if (value == null || value === 0) return '';
    if (Math.abs(value) < 0.01) return value.toFixed(6);
    return value.toFixed(4);
};

const formatDateShort = (dateStr: string | undefined): string => {
    if (!dateStr) return '-';
    try {
        const date = new Date(dateStr);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const mins = String(date.getMinutes()).padStart(2, '0');
        return `${month}/${day} ${hours}:${mins}`;
    } catch {
        return '-';
    }
};

const getTypeColor = (type: string | undefined): BadgeColorScheme => {
    if (!type) return 'gray';
    const t = type.toLowerCase();
    if (t.includes('buy') || t.includes('deposit') || t.includes('receive')) return 'green';
    if (t.includes('sell') || t.includes('withdraw') || t.includes('send')) return 'red';
    if (t.includes('swap') || t.includes('trade') || t.includes('exchange')) return 'blue';
    if (t.includes('transfer')) return 'purple';
    if (t.includes('fee') || t.includes('commission')) return 'orange';
    if (t.includes('reward') || t.includes('staking') || t.includes('airdrop')) return 'green';
    return 'gray';
};

const getTotalColor = (direction: string | undefined): string => {
    if (!direction) return 'text-slate-600';
    if (direction === 'inflow') return 'text-red-600';
    if (direction === 'outflow') return 'text-green-600';
    return 'text-slate-600';
};

/**
 * Build compact source label: "Account:Source"
 */
const buildSourceLabel = (accountName?: string, source?: string): string => {
    const parts = [];
    if (accountName) parts.push(accountName);
    if (source) parts.push(source);
    return parts.join(':') || '';
};

/**
 * Build compact type label: "tx_type:source_tx_type" or just the available one
 */
const buildTypeLabel = (txType?: string, sourceTxType?: string): string => {
    if (txType && sourceTxType && txType !== sourceTxType) {
        return `${txType}:${sourceTxType}`;
    }
    return sourceTxType || txType || 'unknown';
};


// ============================================================================
// Leg Detail Components
// ============================================================================

interface LegDetailItemProps {
    leg: LegDetail;
}

const LegDetailItem: React.FC<LegDetailItemProps> = ({ leg }) => {
    const config = {
        outflow: { arrow: '↑', color: 'text-red-500' },
        inflow: { arrow: '↓', color: 'text-green-500' },
        fee: { arrow: '💸', color: 'text-orange-500' },
    }[leg.leg_type] || { arrow: '?', color: 'text-slate-500' };

    const assetSymbol = leg.asset?.symbol || '?';

    return (
        <div className="flex items-center gap-1">
            <span className={`text-xs font-bold ${config.color}`}>
                {config.arrow}
            </span>
            <span className={`text-xs ${config.color}`}>
                {formatQuantity(leg.qty)}
            </span>
            {leg.asset?.id ? (
                <AssetBadge
                    asset={{ id: leg.asset.id, symbol: assetSymbol }}
                    size="xs"
                />
            ) : (
                <span className={`text-xs ${config.color}`}>{assetSymbol}</span>
            )}
        </div>
    );
};


// ============================================================================
// Main Component
// ============================================================================

export const TransactionRow: React.FC<{
    transaction: TransactionSummary;
    baseCurrency?: string;
    onTransactionClick?: (transactionId: number) => void;
}> = ({
    transaction,
    baseCurrency = 'EUR',
    onTransactionClick,
}) => {

        const {
            id,
            date_time,
            account_name,
            source,
            transaction_type,
            source_transaction_type,
            direction,
            // New format: asset from origin transaction
            asset,
            quantity,
            price,
            total,
            price_quote_asset,
            fee,
            fee_quote_asset,
        } = transaction;

        // Build compact labels
        const sourceLabel = buildSourceLabel(account_name, source);
        const typeLabel = buildTypeLabel(transaction_type, source_transaction_type);

        const hasFee = fee != null && fee > 0;


        const handleTxClick = (e: React.MouseEvent) => {
            e.stopPropagation();
            onTransactionClick?.(id);
        };



        return (
            <div>
                {/* Transaction Header Row */}
                <div className="flex items-center gap-1 py-0.5">


                    {/* TX Badge - Gray */}
                    <TransactionTooltip
                        txId={id}
                        baseCurrency={baseCurrency}
                        onTransactionClick={onTransactionClick}
                    >
                        <Badge
                            colorScheme="gray"
                            className="cursor-pointer hover:bg-slate-200"
                            onClick={handleTxClick}
                        >
                            TX#{id}
                        </Badge>
                    </TransactionTooltip>

                    {/* DateTime Badge - Blue (highlighted) */}
                    <Badge colorScheme="blue">
                        {formatDateShort(date_time)}
                    </Badge>

                    {/* Account:Source Badge - Purple */}
                    {sourceLabel && (
                        <Badge colorScheme="purple" className="max-w-[120px] truncate" title={sourceLabel}>
                            {sourceLabel}
                        </Badge>
                    )}

                    {/* Type Badge - Semantic color */}
                    <Badge
                        colorScheme={getTypeColor(typeLabel)}
                        className="max-w-[100px] truncate"
                        title={typeLabel}
                    >
                        {typeLabel}
                    </Badge>

                    {/* Primary Asset + Qty → Total */}
                    {asset && (
                        <div className="flex items-center gap-1">
                            <AssetBadge
                                asset={{ id: asset.id, symbol: asset.symbol, label: asset.label }}
                                sourceSymbol={asset.symbol}
                                size="xs"
                            />
                            <span className="text-[10px] text-slate-600">
                                {formatQuantity(quantity)}
                            </span>
                            {total != null && total > 0 && (
                                <>
                                    <span className="text-[10px] text-slate-400">→</span>
                                    <span className={`text-[10px] font-medium ${getTotalColor(direction)}`}>
                                        {formatTotal(total)}
                                    </span>
                                    {price_quote_asset && (
                                        <AssetBadge
                                            asset={{ id: price_quote_asset.id, symbol: price_quote_asset.symbol, label: price_quote_asset.label }}
                                            sourceSymbol={price_quote_asset.symbol}
                                            size="xs"
                                        />
                                    )}
                                </>
                            )}
                        </div>
                    )}

                    {/* Fee - Orange */}
                    {hasFee && (
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-slate-400">|</span>
                            <span className="text-[10px] font-bold text-orange-500">💸</span>
                            <span className="text-[10px] text-orange-600">
                                {formatFee(fee)}
                            </span>
                            {fee_quote_asset && (
                                <AssetBadge
                                    asset={{ id: fee_quote_asset.id, symbol: fee_quote_asset.symbol, label: fee_quote_asset.label }}

                                    size="xs"
                                />
                            )}
                        </div>
                    )}
                </div>


            </div>
        );
    };

export default TransactionRow;
