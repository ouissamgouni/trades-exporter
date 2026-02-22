/**
 * BundleTransactionList - Expandable transaction list for bundles and suggestions
 * 
 * Shows transactions within a bundle/suggestion with:
 * - Compact inline display with truncation (max 5 transactions)
 * - "Show all X" expansion for more transactions
 * - Direction indicators (↓ inflow, ↑ outflow)
 * - Enhanced info: id, account, price, total
 */

import React, { useState } from 'react';
import { Box, Flex, Text, Table, Button, Badge } from '@chakra-ui/react';
import { FiInfo } from 'react-icons/fi';
import { TransactionSummary } from '../types';
import { Direction } from '../enums';
import { TransactionTooltip } from './TransactionTooltip';
import { AssetBadge } from './AssetBadge';
import { formatDateShort, formatTimeShort } from '../utils/dateUtils';
import { formatQuantity } from '../utils/numberUtils';
import { ValueDisplay } from './ValueDisplay';

interface BundleTransactionListProps {
    transactions: TransactionSummary[];
    maxVisible?: number;
    colorScheme?: 'teal' | 'purple' | 'blue' | 'gray';
    onTransactionClick?: (txId: number) => void;
}

const directionIcon = (direction: string): string => {
    switch (direction) {
        case Direction.INFLOW: return '↓';
        case Direction.OUTFLOW: return '↑';
        case 'internal': return '↔';
        default: return '•';
    }
};

const directionColor = (direction: string): string => {
    switch (direction) {
        case Direction.INFLOW: return 'green.600';
        case Direction.OUTFLOW: return 'red.600';
        case 'internal': return 'gray.600';
        default: return 'gray.500';
    }
};

export const BundleTransactionList: React.FC<BundleTransactionListProps> = ({
    transactions,
    maxVisible = 5,
    colorScheme = 'gray',
    onTransactionClick,
}) => {
    const [expanded, setExpanded] = useState(false);

    if (!transactions || transactions.length === 0) {
        return (
            <Text fontSize="xs" color="gray.500" fontStyle="italic">
                No transactions
            </Text>
        );
    }

    const visibleTransactions = expanded
        ? transactions
        : transactions.slice(0, maxVisible);

    const hasMore = transactions.length > maxVisible;
    const hiddenCount = transactions.length - maxVisible;

    return (
        <Box overflow="hidden">
            <Table.Root size="sm" width="100%">
                <Table.Body>
                    {visibleTransactions.map((tx) => (
                        <Table.Row
                            key={tx.id}
                            css={{ fontSize: '9px' }}
                            _hover={{ bg: 'gray.50' }}
                            cursor={onTransactionClick ? 'pointer' : 'default'}
                            onClick={() => onTransactionClick?.(tx.id)}
                        >
                            {/* Date/Time */}
                            <Table.Cell px={0.5} py={0.5} width="60px">
                                <Text fontSize="8px" color="gray.600" whiteSpace="nowrap">
                                    {formatDateShort(tx.date_time)}
                                </Text>
                                <Text fontSize="7px" color="gray.400" whiteSpace="nowrap">
                                    {formatTimeShort(tx.date_time)}
                                </Text>
                            </Table.Cell>
                            {/* Direction */}
                            <Table.Cell px={0.5} py={0.5} width="20px">
                                <Text
                                    fontSize="xs"
                                    fontWeight="bold"
                                    color={directionColor(tx.direction)}
                                    title={tx.direction}
                                >
                                    {directionIcon(tx.direction)}
                                </Text>
                            </Table.Cell>
                            {/* Account */}
                            <Table.Cell px={0.5} py={0.5} width="45px">
                                <Text fontSize="8px" color="purple.600" truncate title={tx.account_name} maxW="40px">
                                    {tx.account_name || '-'}
                                </Text>
                            </Table.Cell>
                            {/* Quantity + Asset */}
                            <Table.Cell px={0.5} py={0.5}>
                                <Flex align="center" gap={0.5} flexWrap="nowrap">
                                    <Text
                                        fontSize="9px"
                                        fontWeight="medium"
                                        fontFamily="mono"
                                        whiteSpace="nowrap"
                                    >
                                        <ValueDisplay value={tx.quantity} />
                                    </Text>
                                    <AssetBadge
                                        asset={tx.asset}
                                        sourceSymbol={tx.asset?.source_symbol}
                                        size="xs"
                                        colorPalette={colorScheme}
                                        maxLength={15}
                                    />
                                </Flex>
                            </Table.Cell>
                            {/* Total */}
                            <Table.Cell px={0.5} py={0.5} width="45px" textAlign="right">
                                <Text fontSize="8px" color="gray.600" fontFamily="mono" whiteSpace="nowrap">
                                    <ValueDisplay value={tx.total} />
                                </Text>
                            </Table.Cell>
                            {/* Info icon with TransactionTooltip */}
                            <Table.Cell px={0.5} py={0.5} width="18px">
                                <TransactionTooltip
                                    txId={tx.id}
                                    onTransactionClick={onTransactionClick}
                                >
                                    <Box
                                        as="span"
                                        color="gray.400"
                                        _hover={{ color: 'blue.500' }}
                                        cursor="pointer"
                                    >
                                        <FiInfo size={10} />
                                    </Box>
                                </TransactionTooltip>
                            </Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table.Root>

            {hasMore && (
                <Button
                    size="xs"
                    variant="ghost"
                    colorPalette={colorScheme}
                    onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                    mt={1}
                    width="100%"
                    fontSize="10px"
                >
                    {expanded
                        ? '▲ Show less'
                        : `▼ Show ${hiddenCount} more transaction${hiddenCount > 1 ? 's' : ''}`
                    }
                </Button>
            )}
        </Box>
    );
};

export default BundleTransactionList;
