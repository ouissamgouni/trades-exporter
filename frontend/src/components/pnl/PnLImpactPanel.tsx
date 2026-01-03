/**
 * P&L Impact Panel
 * 
 * Shows detailed breakdown of a single economic event:
 * - Event type, date, taxable status
 * - Which lots were consumed
 * - Related transactions/bundle
 * - Why taxable or not
 * 
 * Principle 3: Everything must be traceable
 * Uses SlidePanel for backdrop click-to-close functionality.
 */

import React from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Table,
    Text,
} from '@chakra-ui/react';
import { FiExternalLink, FiInfo, FiArrowRight } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { PnLImpactEvent, ConsumedLotDetail, EventTransaction } from './types';

interface PnLImpactPanelProps {
    event: PnLImpactEvent;
    baseCurrency: string;
    onClose: () => void;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
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
    return value.toFixed(8).replace(/\.?0+$/, '');
};

const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString();
};

const formatDateTime = (dateStr: string): string => {
    return new Date(dateStr).toLocaleString();
};

export const PnLImpactPanel: React.FC<PnLImpactPanelProps> = ({
    event,
    baseCurrency,
    onClose,
    onTransactionClick,
    onUnitClick,
}) => {
    return (
        <SlidePanel
            isOpen={true}
            onClose={onClose}
            title="P&L Impact Details"
            width="600px"
        >
            {/* Event Summary */}
            <Card.Root mb={4}>
                <Card.Body>
                    <Flex justify="space-between" align="flex-start" mb={4}>
                        <Box>
                            <Flex align="center" gap={2} mb={1}>
                                <Badge
                                    colorPalette={
                                        event.event_type === 'disposal' ? 'red' :
                                            event.event_type === 'fee' ? 'purple' :
                                                event.event_type === 'swap' ? 'orange' : 'gray'
                                    }
                                    size="lg"
                                >
                                    {event.event_type.toUpperCase()}
                                </Badge>
                                {event.disposal_taxable ? (
                                    <Badge colorPalette="red">Taxable Event</Badge>
                                ) : (
                                    <Badge colorPalette="green">Non-Taxable</Badge>
                                )}
                            </Flex>
                            <Text fontSize="sm" color="gray.600">
                                {formatDateTime(event.event_date)}
                            </Text>
                        </Box>
                        <Box textAlign="right">
                            <Text fontSize="sm" color="gray.500">Total P&L</Text>
                            <Text
                                fontSize="2xl"
                                fontWeight="bold"
                                color={event.total_pnl >= 0 ? 'green.600' : 'red.600'}
                            >
                                {formatCurrency(event.total_pnl, baseCurrency)}
                            </Text>
                        </Box>
                    </Flex>

                    {/* P&L Breakdown */}
                    <Box bg="gray.50" p={3} borderRadius="md">
                        <Flex justify="space-between" mb={2}>
                            <Text fontSize="sm">Proceeds</Text>
                            <Text fontSize="sm" fontWeight="medium">
                                {formatCurrency(event.total_proceeds, baseCurrency)}
                            </Text>
                        </Flex>
                        <Flex justify="space-between" mb={2}>
                            <Text fontSize="sm">Cost Basis</Text>
                            <Text fontSize="sm" fontWeight="medium">
                                - {formatCurrency(event.total_cost_basis, baseCurrency)}
                            </Text>
                        </Flex>
                        {event.total_fees > 0 && (
                            <Flex justify="space-between" mb={2}>
                                <Text fontSize="sm">Fees</Text>
                                <Text fontSize="sm" fontWeight="medium">
                                    - {formatCurrency(event.total_fees, baseCurrency)}
                                </Text>
                            </Flex>
                        )}
                        <Box borderTop="1px solid" borderColor="gray.300" pt={2} mt={2}>
                            <Flex justify="space-between">
                                <Text fontWeight="bold">Net P&L</Text>
                                <Text
                                    fontWeight="bold"
                                    color={event.total_pnl >= 0 ? 'green.600' : 'red.600'}
                                >
                                    {formatCurrency(event.total_pnl, baseCurrency)}
                                </Text>
                            </Flex>
                        </Box>
                    </Box>

                    {/* Unit info */}
                    {event.unit_id && (
                        <Flex align="center" gap={2} mt={4}>
                            <FiInfo color="gray" />
                            <Text fontSize="sm" color="gray.600">
                                Calculation Unit:
                            </Text>
                            <Button
                                size="xs"
                                variant="ghost"
                                colorPalette="blue"
                                onClick={() => onUnitClick?.(event.unit_id!)}
                            >
                                {event.unit_label || `#${event.unit_id}`}
                                <FiExternalLink size={12} />
                            </Button>
                            {event.unit_pattern && (
                                <Badge size="sm">{event.unit_pattern}</Badge>
                            )}
                        </Flex>
                    )}
                </Card.Body>
            </Card.Root>

            {/* Consumed Lots */}
            <Card.Root mb={4}>
                <Card.Header>
                    <Text fontWeight="bold">Lots Consumed ({event.consumed_lots.length})</Text>
                </Card.Header>
                <Card.Body p={0}>
                    <Box overflowX="auto">
                        <Table.Root size="sm">
                            <Table.Header>
                                <Table.Row>
                                    <Table.ColumnHeader>Acquired</Table.ColumnHeader>
                                    <Table.ColumnHeader>Qty</Table.ColumnHeader>
                                    <Table.ColumnHeader>Unit Cost</Table.ColumnHeader>
                                    <Table.ColumnHeader>Cost Basis</Table.ColumnHeader>
                                    <Table.ColumnHeader>Holding</Table.ColumnHeader>
                                </Table.Row>
                            </Table.Header>
                            <Table.Body>
                                {event.consumed_lots.map((lot, idx) => (
                                    <Table.Row key={idx}>
                                        <Table.Cell>
                                            <Flex direction="column">
                                                <Text fontSize="sm">{formatDate(lot.acquired_at)}</Text>
                                                {lot.origin_transaction_id && onTransactionClick && (
                                                    <Button
                                                        size="xs"
                                                        variant="ghost"
                                                        onClick={() => onTransactionClick(lot.origin_transaction_id!)}
                                                    >
                                                        TX #{lot.origin_transaction_id}
                                                    </Button>
                                                )}
                                            </Flex>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Text fontFamily="mono" fontSize="sm">
                                                {formatQty(lot.qty_consumed)}
                                            </Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {formatCurrency(lot.unit_cost, baseCurrency)}
                                        </Table.Cell>
                                        <Table.Cell>
                                            {formatCurrency(lot.cost_basis, baseCurrency)}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Flex align="center" gap={1}>
                                                <Text fontSize="sm">{lot.holding_days}d</Text>
                                                {lot.holding_days >= 365 && (
                                                    <Badge size="sm" colorPalette="green">LT</Badge>
                                                )}
                                            </Flex>
                                        </Table.Cell>
                                    </Table.Row>
                                ))}
                            </Table.Body>
                        </Table.Root>
                    </Box>
                </Card.Body>
            </Card.Root>

            {/* Related Transactions */}
            <Card.Root>
                <Card.Header>
                    <Text fontWeight="bold">Related Transactions ({event.transactions.length})</Text>
                </Card.Header>
                <Card.Body p={0}>
                    <Box overflowX="auto">
                        <Table.Root size="sm">
                            <Table.Header>
                                <Table.Row>
                                    <Table.ColumnHeader>Date</Table.ColumnHeader>
                                    <Table.ColumnHeader>Source</Table.ColumnHeader>
                                    <Table.ColumnHeader>Type</Table.ColumnHeader>
                                    <Table.ColumnHeader>Asset</Table.ColumnHeader>
                                    <Table.ColumnHeader>Qty</Table.ColumnHeader>
                                    <Table.ColumnHeader>Total</Table.ColumnHeader>
                                    <Table.ColumnHeader></Table.ColumnHeader>
                                </Table.Row>
                            </Table.Header>
                            <Table.Body>
                                {event.transactions.map((tx) => (
                                    <Table.Row key={tx.transaction_id}>
                                        <Table.Cell>
                                            <Text fontSize="sm">{formatDateTime(tx.date_time)}</Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge size="sm" variant="subtle">{tx.source}</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Flex align="center" gap={1}>
                                                <Badge
                                                    colorPalette={tx.direction === 'inflow' ? 'green' : 'red'}
                                                    size="sm"
                                                >
                                                    {tx.direction}
                                                </Badge>
                                                <Text fontSize="xs" color="gray.500">
                                                    {tx.transaction_type}
                                                </Text>
                                            </Flex>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge>{tx.asset_symbol}</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Text fontFamily="mono" fontSize="sm">
                                                {formatQty(tx.quantity)}
                                            </Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {tx.total ? formatCurrency(tx.total, baseCurrency) : '—'}
                                        </Table.Cell>
                                        <Table.Cell>
                                            {onTransactionClick && (
                                                <Button
                                                    size="xs"
                                                    variant="ghost"
                                                    onClick={() => onTransactionClick(tx.transaction_id)}
                                                >
                                                    <FiExternalLink />
                                                </Button>
                                            )}
                                        </Table.Cell>
                                    </Table.Row>
                                ))}
                            </Table.Body>
                        </Table.Root>
                    </Box>
                </Card.Body>
            </Card.Root>

            {/* Actions */}
            <Flex gap={2} mt={4}>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        // Navigate to first transaction
                        if (event.transactions[0] && onTransactionClick) {
                            onTransactionClick(event.transactions[0].transaction_id);
                        }
                    }}
                >
                    <FiArrowRight /> Go to Transaction
                </Button>
                {event.unit_id && onUnitClick && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onUnitClick(event.unit_id!)}
                    >
                        <FiArrowRight /> Go to Calculation Unit
                    </Button>
                )}
            </Flex>
        </SlidePanel>
    );
};

export default PnLImpactPanel;
