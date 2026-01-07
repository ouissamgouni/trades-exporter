/**
 * TransactionTooltip - Shared hover tooltip for transaction details
 * 
 * Displays transaction details on hover with lazy loading.
 * Reusable across BundleTable, DataExplorerPanel, etc.
 */

import React, { useState } from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { FiLoader } from 'react-icons/fi';
import { Tooltip } from './ui/tooltip';
import { API_URL } from '../types';
import { formatDateTimeLocale } from '../utils/dateUtils';

// ============================================================================
// Types
// ============================================================================

interface TransactionDetail {
    transaction_id: number;
    date_time?: string;
    account_id?: number;
    account_name?: string;
    source?: string;
    source_transaction_type?: string;
    transaction_type?: string;
    direction?: string;
    from_account_id?: number;
    from_account_name?: string;
    to_account_id?: number;
    to_account_name?: string;
    source_from_account?: string;
    source_to_account?: string;
    asset_id?: number;
    asset_symbol?: string;
    quantity?: number;
    price?: number;
    price_quote_asset_id?: number;
    price_quote_asset_symbol?: string;
    total?: number;
    fee?: number;
    fee_quote_asset_id?: number;
    fee_quote_asset_symbol?: string;
}

export interface TransactionTooltipProps {
    txId: number;
    children: React.ReactNode;
    baseCurrency?: string;
    onTransactionClick?: (txId: number) => void;
}

// ============================================================================
// Helpers
// ============================================================================

const formatQty = (value: number): string => {
    if (value === 0) return '0';
    return value.toFixed(8).replace(/\.?0+$/, '');
};

const formatCurrency = (value: number, currency: string): string => {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
};

// ============================================================================
// Component
// ============================================================================

export const TransactionTooltip: React.FC<TransactionTooltipProps> = ({
    txId,
    children,
    baseCurrency = 'USD',
    onTransactionClick,
}) => {
    const [txData, setTxData] = useState<TransactionDetail | null>(null);
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
                account_name: data.account_name || '-',
                source: data.source,
                source_transaction_type: data.source_transaction_type,
                transaction_type: data.transaction_type,
                direction: data.direction,
                from_account_id: data.from_account_id,
                from_account_name: data.from_account_name,
                to_account_id: data.to_account_id,
                to_account_name: data.to_account_name,
                source_from_account: data.source_from_account,
                source_to_account: data.source_to_account,
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
                        <Text color="white">{formatDateTimeLocale(txData.date_time)}</Text>
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
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Asset</Text>
                        <Badge size="xs">{txData.asset_symbol || '-'}</Badge>
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
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Quote Asset</Text>
                        <Text color="white">{txData.price_quote_asset_symbol || '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Fee</Text>
                        <Text color="white">{txData.fee ? formatQty(txData.fee) : '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">Fee Quote</Text>
                        <Text color="white">{txData.fee_quote_asset_symbol || '-'}</Text>
                    </Flex>
                    <Flex justify="space-between" mb={1}>
                        <Text color="gray.400">From/To Account</Text>
                        <Text color="white">
                            {txData.direction === 'inflow'
                                ? (txData.from_account_name || txData.source_from_account || '-')
                                : (txData.to_account_name || txData.source_to_account || '-')}
                        </Text>
                    </Flex>
                    {/* View full details link */}
                    {onTransactionClick && (
                        <Box
                            mt={2}
                            pt={2}
                            borderTop="1px solid"
                            borderColor="gray.600"
                            textAlign="center"
                        >
                            <Text
                                fontSize="xs"
                                color="blue.300"
                                cursor="pointer"
                                _hover={{ color: 'blue.200', textDecoration: 'underline' }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onTransactionClick(txId);
                                }}
                            >
                                View full details →
                            </Text>
                        </Box>
                    )}
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

export default TransactionTooltip;
