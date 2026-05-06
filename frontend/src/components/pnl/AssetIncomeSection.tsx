/**
 * AssetIncomeSection — Income events for a single asset within the Asset Detail panel.
 *
 * Shows a table of dividend/interest income events for a specific asset,
 * with gross, withholding, and net amounts.
 */

import React from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { LuBanknote } from 'react-icons/lu';
import { useIncomeEvents, type IncomeEventItem } from '../../hooks/useChartData';
import { ValueDisplay } from '../ValueDisplay';

interface AssetIncomeSectionProps {
    assetId: number;
    versionId: number;
    baseCurrency?: string;
}

const fmtDate = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const AssetIncomeSection: React.FC<AssetIncomeSectionProps> = ({
    assetId, versionId, baseCurrency = 'EUR',
}) => {
    const { data, isLoading } = useIncomeEvents(versionId, { assetId, limit: 200 });

    if (isLoading) {
        return <Text fontSize="xs" color="gray.400" p={2}>Loading income events...</Text>;
    }

    const events = data?.items ?? [];
    if (events.length === 0) {
        return null; // Don't render section if no income events
    }

    // Totals
    let totalGross = 0, totalWht = 0, totalNet = 0;
    for (const e of events) {
        totalGross += e.gross_amount_in_base;
        totalWht += e.withholding_amount_in_base;
        totalNet += e.net_amount_in_base;
    }

    return (
        <Box>
            {/* Summary */}
            <Flex gap={4} mb={2} p={2} bg="teal.50" borderRadius="sm" wrap="wrap">
                <Box>
                    <Text fontSize="2xs" color="gray.500">Gross</Text>
                    <Text fontSize="xs" fontWeight="bold" color="teal.700">
                        <ValueDisplay value={totalGross} currency={baseCurrency} />
                    </Text>
                </Box>
                <Box>
                    <Text fontSize="2xs" color="gray.500">Withholding</Text>
                    <Text fontSize="xs" fontWeight="bold" color="red.500">
                        <ValueDisplay value={-totalWht} currency={baseCurrency} />
                    </Text>
                </Box>
                <Box>
                    <Text fontSize="2xs" color="gray.500">Net</Text>
                    <Text fontSize="xs" fontWeight="bold" color="teal.700">
                        <ValueDisplay value={totalNet} currency={baseCurrency} />
                    </Text>
                </Box>
                <Box>
                    <Text fontSize="2xs" color="gray.500">Events</Text>
                    <Text fontSize="xs" fontWeight="bold" color="gray.600">{events.length}</Text>
                </Box>
            </Flex>

            {/* Table */}
            <Box overflowX="auto">
                <Box as="table" width="100%" fontSize="xs">
                    <Box as="thead">
                        <Box as="tr" bg="gray.50">
                            <Box as="th" px={2} py={1} textAlign="left">Date</Box>
                            <Box as="th" px={2} py={1} textAlign="left">Type</Box>
                            <Box as="th" px={2} py={1} textAlign="left">Account</Box>
                            <Box as="th" px={2} py={1} textAlign="right">Gross</Box>
                            <Box as="th" px={2} py={1} textAlign="right">WHT</Box>
                            <Box as="th" px={2} py={1} textAlign="right">Net</Box>
                            <Box as="th" px={2} py={1} textAlign="left">Country</Box>
                        </Box>
                    </Box>
                    <Box as="tbody">
                        {events.map(e => (
                            <Box as="tr" key={e.id} _hover={{ bg: 'gray.50' }} borderBottom="1px solid" borderColor="gray.100">
                                <Box as="td" px={2} py={1} whiteSpace="nowrap">{fmtDate(e.income_at)}</Box>
                                <Box as="td" px={2} py={1}>
                                    <Badge size="xs" colorPalette="teal" variant="subtle">{e.income_type}</Badge>
                                </Box>
                                <Box as="td" px={2} py={1} color="gray.600">{e.account_name || '—'}</Box>
                                <Box as="td" px={2} py={1} textAlign="right" color="teal.700">
                                    <ValueDisplay value={e.gross_amount_in_base} currency={baseCurrency} />
                                </Box>
                                <Box as="td" px={2} py={1} textAlign="right" color="red.500">
                                    {e.withholding_amount_in_base > 0 ? (
                                        <>-<ValueDisplay value={e.withholding_amount_in_base} currency={baseCurrency} /></>
                                    ) : '—'}
                                </Box>
                                <Box as="td" px={2} py={1} textAlign="right" fontWeight="semibold" color="teal.600">
                                    <ValueDisplay value={e.net_amount_in_base} currency={baseCurrency} />
                                </Box>
                                <Box as="td" px={2} py={1} color="gray.500" fontSize="2xs">
                                    {e.withholding_jurisdiction || '—'}
                                </Box>
                            </Box>
                        ))}
                    </Box>
                </Box>
            </Box>
        </Box>
    );
};
