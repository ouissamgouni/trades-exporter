/**
 * Fees Panel
 * 
 * Shows all fees with traceability to source transactions.
 * Uses SlidePanel for backdrop click-to-close functionality.
 */

import React, { useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Input,
    Table,
    Text,
} from '@chakra-ui/react';
import { FiExternalLink, FiSearch, FiDownload } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { FeeEntry, FeeSummary } from './types';

interface FeesPanelProps {
    fees: FeeEntry[];
    summary: FeeSummary;
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

export const FeesPanel: React.FC<FeesPanelProps> = ({
    fees,
    summary,
    baseCurrency,
    onClose,
    onTransactionClick,
    onUnitClick,
}) => {
    const [search, setSearch] = useState('');
    const [sourceFilter, setSourceFilter] = useState<string>('');

    const uniqueSources = [...new Set(fees.map(f => f.source))];

    const filtered = fees.filter((fee) => {
        if (search && !fee.asset_symbol.toLowerCase().includes(search.toLowerCase())) {
            return false;
        }
        if (sourceFilter && fee.source !== sourceFilter) {
            return false;
        }
        return true;
    });

    return (
        <SlidePanel
            isOpen={true}
            onClose={onClose}
            title="💰 Fees Breakdown"
            width="700px"
        >
            {/* Summary Cards */}
            <Flex gap={4} mb={4} wrap="wrap">
                <Card.Root flex="1" minW="150px">
                    <Card.Body py={3}>
                        <Text fontSize="xs" color="gray.500">Total Fees</Text>
                        <Text fontSize="xl" fontWeight="bold">
                            {formatCurrency(summary.total_fees_in_base, baseCurrency)}
                        </Text>
                    </Card.Body>
                </Card.Root>
                <Card.Root flex="1" minW="150px">
                    <Card.Body py={3}>
                        <Text fontSize="xs" color="gray.500">Taxable Fee Events</Text>
                        <Text fontSize="xl" fontWeight="bold" color="orange.600">
                            {summary.disposal_taxable_fee_count}
                        </Text>
                    </Card.Body>
                </Card.Root>
                <Card.Root flex="1" minW="150px">
                    <Card.Body py={3}>
                        <Text fontSize="xs" color="gray.500">Fee Entries</Text>
                        <Text fontSize="xl" fontWeight="bold">
                            {fees.length}
                        </Text>
                    </Card.Body>
                </Card.Root>
            </Flex>

            {/* Fees by Asset */}
            <Card.Root mb={4}>
                <Card.Header>
                    <Text fontWeight="bold" fontSize="sm">Fees by Asset</Text>
                </Card.Header>
                <Card.Body py={2}>
                    <Flex gap={2} wrap="wrap">
                        {Object.entries(summary.fees_by_asset)
                            .sort(([, a], [, b]) => b - a)
                            .slice(0, 10)
                            .map(([asset, amount]) => (
                                <Badge key={asset} colorPalette="purple" px={2} py={1}>
                                    {asset}: {formatCurrency(amount, baseCurrency)}
                                </Badge>
                            ))}
                    </Flex>
                </Card.Body>
            </Card.Root>

            {/* Filters */}
            <Flex gap={2} mb={4} align="center">
                <Box position="relative" flex="1">
                    <Input
                        placeholder="Search by asset..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        size="sm"
                        pl={8}
                    />
                    <Box position="absolute" left={2} top="50%" transform="translateY(-50%)">
                        <FiSearch size={14} color="gray" />
                    </Box>
                </Box>
                <select
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value)}
                    style={{
                        padding: '6px 10px',
                        borderRadius: '6px',
                        border: '1px solid #e2e8f0',
                        fontSize: '14px',
                    }}
                >
                    <option value="">All Sources</option>
                    {uniqueSources.map((src) => (
                        <option key={src} value={src}>{src}</option>
                    ))}
                </select>
                <Button size="sm" variant="outline">
                    <FiDownload /> Export
                </Button>
            </Flex>

            {/* Fees Table */}
            <Card.Root>
                <Card.Body p={0}>
                    <Box overflowX="auto">
                        <Table.Root size="sm">
                            <Table.Header>
                                <Table.Row>
                                    <Table.ColumnHeader>Date</Table.ColumnHeader>
                                    <Table.ColumnHeader>Source</Table.ColumnHeader>
                                    <Table.ColumnHeader>Asset</Table.ColumnHeader>
                                    <Table.ColumnHeader>Fee Amount</Table.ColumnHeader>
                                    <Table.ColumnHeader>In Base</Table.ColumnHeader>
                                    <Table.ColumnHeader>Realized P&L</Table.ColumnHeader>
                                    <Table.ColumnHeader>Origin</Table.ColumnHeader>
                                </Table.Row>
                            </Table.Header>
                            <Table.Body>
                                {filtered.length === 0 ? (
                                    <Table.Row>
                                        <Table.Cell colSpan={7}>
                                            <Text textAlign="center" py={4} color="gray.500">
                                                No fees match your criteria
                                            </Text>
                                        </Table.Cell>
                                    </Table.Row>
                                ) : (
                                    filtered.map((fee) => (
                                        <Table.Row key={fee.id}>
                                            <Table.Cell>
                                                <Text fontSize="sm">{formatDate(fee.date)}</Text>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Badge size="sm" variant="subtle">
                                                    {fee.source}
                                                </Badge>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Badge>{fee.asset_symbol}</Badge>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Text fontFamily="mono" fontSize="sm">
                                                    {formatQty(fee.fee_amount)}
                                                </Text>
                                            </Table.Cell>
                                            <Table.Cell>
                                                {formatCurrency(fee.fee_in_base, baseCurrency)}
                                            </Table.Cell>
                                            <Table.Cell>
                                                {fee.realized_pnl !== undefined ? (
                                                    <Text
                                                        fontSize="sm"
                                                        color={fee.realized_pnl >= 0 ? 'green.600' : 'red.600'}
                                                    >
                                                        {formatCurrency(fee.realized_pnl, baseCurrency)}
                                                    </Text>
                                                ) : (
                                                    <Text fontSize="sm" color="gray.400">—</Text>
                                                )}
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Flex gap={1}>
                                                    {fee.transaction_id && onTransactionClick && (
                                                        <Button
                                                            size="xs"
                                                            variant="ghost"
                                                            onClick={() => onTransactionClick(fee.transaction_id!)}
                                                        >
                                                            TX
                                                            <FiExternalLink size={12} />
                                                        </Button>
                                                    )}
                                                    {fee.unit_id && onUnitClick && (
                                                        <Button
                                                            size="xs"
                                                            variant="ghost"
                                                            onClick={() => onUnitClick(fee.unit_id!)}
                                                        >
                                                            Unit
                                                            <FiExternalLink size={12} />
                                                        </Button>
                                                    )}
                                                </Flex>
                                            </Table.Cell>
                                        </Table.Row>
                                    ))
                                )}
                            </Table.Body>
                        </Table.Root>
                    </Box>
                </Card.Body>
            </Card.Root>
        </SlidePanel>
    );
};

export default FeesPanel;
