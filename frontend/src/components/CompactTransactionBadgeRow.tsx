/**
 * CompactTransactionBadgeRow - Single-line transaction display for P&L tables
 * 
 * Two usage modes:
 * 1. Full data mode: Pass full transaction data for immediate display
 * 2. ID-only mode: Pass just txId, shows TX badge with tooltip for details
 * 
 * Layout when full data available:
 * [TX#1234] 01/08 [Binance] [trade] [BTC] 0.5 → $48K [USD] | Fee $2.40 [USDT]
 * 
 * Layout when ID-only:
 * [TX#1234] (hover for details via TransactionTooltip)
 * 
 * - Clicking anywhere opens TransactionDetailDrawer
 * - Wrapped in TransactionTooltip for hover details
 * - Reuses AccountBadge and AssetBadge components
 */

import React from 'react';
import { Badge, Flex, Text } from '@chakra-ui/react';
import { AccountBadge } from './AccountBadge';
import { AssetBadge } from './AssetBadge';
import { TransactionTooltip } from './TransactionTooltip';
import { AssetRef } from '../types';

// ============================================================================
// Types
// ============================================================================

export interface CompactTransactionData {
    transaction_id: number;
    date_time?: string;
    account_id?: number;
    account_name?: string;
    source?: string;
    transaction_type?: string;
    source_transaction_type?: string;
    direction?: string;
    // Asset info
    linked_asset?: AssetRef | null;
    asset_symbol?: string;
    source_asset_symbol?: string;
    quantity?: number;
    // Price info
    price?: number;
    total?: number;
    price_quote_asset?: AssetRef | null;
    price_quote_asset_symbol?: string;
    // Fee info
    fee?: number;
    fee_quote_asset?: AssetRef | null;
    fee_quote_asset_symbol?: string;
    // Transfer fields (optional)
    from_account_name?: string;
    to_account_name?: string;
}

export interface CompactTransactionBadgeRowProps {
    /** Transaction ID (required) */
    txId: number;
    /** Full transaction data (optional - if not provided, shows compact badge with tooltip) */
    transaction?: CompactTransactionData;
    /** Base currency for formatting */
    baseCurrency?: string;
    /** Callback when transaction is clicked */
    onTransactionClick?: (txId: number) => void;
    /** Whether to show the tooltip on hover (default: true) */
    showTooltip?: boolean;
}

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
    if (value == null) return '-';
    if (Math.abs(value) >= 1000000) {
        return `$${(value / 1000000).toFixed(1)}M`;
    }
    if (Math.abs(value) >= 1000) {
        return `$${(value / 1000).toFixed(1)}K`;
    }
    return `$${value.toFixed(2)}`;
};

const formatFee = (value: number | undefined | null): string => {
    if (value == null || value === 0) return '';
    if (Math.abs(value) < 0.01) return value.toFixed(6);
    return value.toFixed(2);
};

const getTypeColor = (type: string | undefined): string => {
    if (!type) return 'gray';
    const t = type.toLowerCase();
    if (t.includes('buy') || t.includes('deposit') || t.includes('receive')) return 'green';
    if (t.includes('sell') || t.includes('withdraw') || t.includes('send')) return 'red';
    if (t.includes('swap') || t.includes('trade') || t.includes('exchange')) return 'blue';
    if (t.includes('transfer')) return 'purple';
    if (t.includes('fee') || t.includes('commission')) return 'orange';
    if (t.includes('reward') || t.includes('staking') || t.includes('airdrop')) return 'teal';
    return 'gray';
};

const formatDateShort = (dateStr: string | undefined): string => {
    if (!dateStr) return '-';
    try {
        const date = new Date(dateStr);
        // Format as MM/DD HH:mm
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const mins = String(date.getMinutes()).padStart(2, '0');
        return `${month}/${day} ${hours}:${mins}`;
    } catch {
        return '-';
    }
};

// ============================================================================
// Component
// ============================================================================

export const CompactTransactionBadgeRow: React.FC<CompactTransactionBadgeRowProps> = ({
    txId,
    transaction,
    baseCurrency = 'USD',
    onTransactionClick,
    showTooltip = true,
}) => {
    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        onTransactionClick?.(txId);
    };

    // ID-only mode: show compact badge with tooltip
    if (!transaction) {
        const badge = (
            <Badge
                size="xs"
                colorPalette="gray"
                variant="subtle"
                cursor={onTransactionClick ? 'pointer' : 'default'}
                onClick={handleClick}
                _hover={onTransactionClick ? { bg: 'gray.200' } : undefined}
            >
                TX#{txId}
            </Badge>
        );

        if (showTooltip) {
            return (
                <TransactionTooltip
                    txId={txId}
                    baseCurrency={baseCurrency}
                    onTransactionClick={onTransactionClick}
                >
                    {badge}
                </TransactionTooltip>
            );
        }

        return badge;
    }

    // Full data mode: show detailed row
    const {
        date_time,
        account_id,
        account_name,
        transaction_type,
        source_transaction_type,
        linked_asset,
        asset_symbol,
        source_asset_symbol,
        quantity,
        total,
        price_quote_asset,
        price_quote_asset_symbol,
        fee,
        fee_quote_asset,
        fee_quote_asset_symbol,
    } = transaction;

    const displayType = transaction_type || source_transaction_type || 'unknown';
    const hasFee = fee != null && fee > 0;

    // Resolve asset display
    const assetRef: AssetRef | null = linked_asset || (asset_symbol ? { symbol: asset_symbol } : null);
    const sourceSymbol = source_asset_symbol || asset_symbol;

    // Resolve price quote asset
    const priceQuoteRef: AssetRef | null = price_quote_asset || (price_quote_asset_symbol ? { symbol: price_quote_asset_symbol } : null);

    // Resolve fee quote asset
    const feeQuoteRef: AssetRef | null = fee_quote_asset || (fee_quote_asset_symbol ? { symbol: fee_quote_asset_symbol } : null);

    const rowContent = (
        <Flex
            align="center"
            gap={1}
            py={0.5}
            px={1}
            borderRadius="md"
            cursor={onTransactionClick ? 'pointer' : 'default'}
            _hover={onTransactionClick ? { bg: 'gray.100' } : undefined}
            onClick={handleClick}
            flexWrap="nowrap"
            overflow="hidden"
        >
            {/* TX ID Badge */}
            <Badge size="xs" colorPalette="gray" variant="subtle" flexShrink={0}>
                TX#{txId}
            </Badge>

            {/* Date */}
            <Text fontSize="2xs" color="gray.500" flexShrink={0} fontFamily="mono">
                {formatDateShort(date_time)}
            </Text>

            {/* Account Badge */}
            <AccountBadge
                accountId={account_id}
                accountName={account_name}
                size="xs"
                colorPalette="purple"
                maxLength={12}
                showWarning={false}
            />

            {/* Type Badge */}
            <Badge size="xs" colorPalette={getTypeColor(displayType)} variant="subtle" flexShrink={0}>
                {displayType.slice(0, 10)}
            </Badge>

            {/* Asset Badge + Quantity */}
            <AssetBadge
                asset={assetRef}
                sourceSymbol={sourceSymbol}
                size="xs"
                colorPalette="blue"
                maxLength={8}
                showWarning={false}
            />
            <Text fontSize="2xs" color="gray.700" fontFamily="mono" flexShrink={0}>
                {formatQuantity(quantity)}
            </Text>

            {/* Arrow + Total + Quote Asset */}
            {total != null && (
                <>
                    <Text fontSize="2xs" color="gray.400" flexShrink={0}>→</Text>
                    <Text fontSize="2xs" color="gray.700" fontFamily="mono" flexShrink={0}>
                        {formatTotal(total)}
                    </Text>
                    {priceQuoteRef && (
                        <AssetBadge
                            asset={priceQuoteRef}
                            size="xs"
                            colorPalette="green"
                            maxLength={6}
                            showWarning={false}
                        />
                    )}
                </>
            )}

            {/* Fee Section */}
            {hasFee && (
                <>
                    <Text fontSize="2xs" color="gray.300" flexShrink={0}>|</Text>
                    <Text fontSize="2xs" color="orange.600" flexShrink={0}>
                        Fee {formatFee(fee)}
                    </Text>
                    {feeQuoteRef && (
                        <AssetBadge
                            asset={feeQuoteRef}
                            size="xs"
                            colorPalette="orange"
                            maxLength={6}
                            showWarning={false}
                        />
                    )}
                </>
            )}
        </Flex>
    );

    // Wrap in tooltip if enabled
    if (showTooltip) {
        return (
            <TransactionTooltip
                txId={txId}
                baseCurrency={baseCurrency}
                onTransactionClick={onTransactionClick}
            >
                {rowContent}
            </TransactionTooltip>
        );
    }

    return rowContent;
};

export default CompactTransactionBadgeRow;
