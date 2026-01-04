/**
 * BundleTransactionList - Expandable transaction list for bundles and suggestions
 * 
 * Shows transactions within a bundle/suggestion with:
 * - Compact inline display with truncation (max 5 transactions)
 * - "Show all X" expansion for more transactions
 * - Direction indicators (↓ inflow, ↑ outflow)
 */

import React, { useState } from 'react';
import { Box, Flex, Text, Table, Button, Badge } from '@chakra-ui/react';
import { TransactionSummary } from '../types';
import { Direction } from '../enums';

interface BundleTransactionListProps {
    transactions: TransactionSummary[];
    maxVisible?: number;
    colorScheme?: 'teal' | 'purple' | 'blue' | 'gray';
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

const formatQuantity = (qty: number): string => {
    if (qty === 0) return '0';
    if (Math.abs(qty) < 0.0001) return qty.toExponential(2);
    if (Math.abs(qty) < 1) return qty.toFixed(6);
    if (Math.abs(qty) < 1000) return qty.toFixed(4);
    return qty.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

export const BundleTransactionList: React.FC<BundleTransactionListProps> = ({
    transactions,
    maxVisible = 5,
    colorScheme = 'gray',
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
        <Box>
            <Table.Root size="sm">
                <Table.Body>
                    {visibleTransactions.map((tx) => (
                        <Table.Row key={tx.id} css={{ fontSize: '10px' }}>
                            <Table.Cell px={1} py={0.5} width="70px">
                                <Text fontSize="9px" color="gray.500">
                                    {tx.date_time ? tx.date_time.slice(0, 16) : '-'}
                                </Text>
                            </Table.Cell>
                            <Table.Cell px={1} py={0.5} width="24px" textAlign="center">
                                <Text 
                                    fontSize="sm" 
                                    fontWeight="bold" 
                                    color={directionColor(tx.direction)}
                                    title={tx.direction}
                                >
                                    {directionIcon(tx.direction)}
                                </Text>
                            </Table.Cell>
                            <Table.Cell px={1} py={0.5}>
                                <Flex align="center" gap={1}>
                                    <Text 
                                        fontSize="10px" 
                                        fontWeight="medium" 
                                        fontFamily="mono"
                                    >
                                        {formatQuantity(tx.quantity)}
                                    </Text>
                                    <Badge 
                                        size="xs" 
                                        colorPalette={colorScheme}
                                        variant="subtle"
                                    >
                                        {tx.symbol || tx.asset_symbol || '?'}
                                    </Badge>
                                </Flex>
                            </Table.Cell>
                            <Table.Cell px={1} py={0.5} width="60px">
                                <Text fontSize="9px" color="gray.500" truncate>
                                    {tx.source || '-'}
                                </Text>
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
                    onClick={() => setExpanded(!expanded)}
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
