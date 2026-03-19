/**
 * AccountPnLCard — Card-based display for a single aggregated account row.
 *
 * Used in "By Account" card mode. Shows account-level aggregate metrics
 * with expandable per-asset detail drill-down.
 *
 * Zones:
 * 1. Header — color dot, account name, asset count badge
 * 2. Metrics — cost + value + live balance
 * 3. P&L — unrealized P&L with percentage
 * 4. Expandable — per-asset breakdown with clickable asset badges
 */

import React from 'react';
import {
    Badge,
    Box,
    Card,
    Collapsible,
    Flex,
    Text,
} from '@chakra-ui/react';
import { FiChevronRight, FiChevronDown } from 'react-icons/fi';
import { Tooltip } from '../ui/tooltip';
import { ValueDisplay } from '../ValueDisplay';
import { getAccountColor } from '../../utils/accountColors';
import { formatPct } from './deltaUtils';

// ------------------------------------------------------------------
// Types (re-declared locally to avoid circular deps — mirrors AssetPnLTable)
// ------------------------------------------------------------------

/** Aggregated row for "by account" view */
export interface AggregatedAccountRow {
    account_id: number;
    account_name: string;
    asset_count: number;
    total_cost_basis: number;
    total_market_value: number;
    total_unrealized_pnl: number;
    total_lot_count: number;
}

/** Per-asset detail row shown when an account row is expanded */
export interface AccountAssetDetail {
    asset_symbol: string;
    asset_id: number | null;
    qty: number;
    cost_basis: number;
    unit_cost: number;
    market_value: number;
    unrealized_pnl: number;
    lot_count: number;
}

// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

export interface AccountPnLCardProps {
    row: AggregatedAccountRow;
    baseCurrency: string;
    isExpanded: boolean;
    onToggleExpand: (accountId: number, e: React.MouseEvent) => void;
    onAssetClick: (assetId: number | undefined | null) => void;
    /** Detailed per-asset rows for this account (when expanded) */
    details: AccountAssetDetail[];
    /** Aggregated live balance value for this account (sum of all asset live values) */
    liveBalanceValue?: number;
    /** True while live balances are being fetched */
    liveBalanceLoading?: boolean;
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

const Metric: React.FC<{
    label: string;
    children: React.ReactNode;
    flex?: string;
}> = ({ label, children, flex }) => (
    <Box flex={flex} minW={0}>
        <Text fontSize="2xs" color="gray.500" mb={0.5} lineClamp={1}>{label}</Text>
        {children}
    </Box>
);

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export const AccountPnLCard: React.FC<AccountPnLCardProps> = ({
    row,
    baseCurrency,
    isExpanded,
    onToggleExpand,
    onAssetClick,
    details,
    liveBalanceValue,
    liveBalanceLoading = false,
}) => {
    const { account_id, account_name, asset_count, total_cost_basis, total_market_value, total_unrealized_pnl, total_lot_count } = row;
    const accountColor = getAccountColor(account_id);
    const unrealizedPct = total_cost_basis > 0 ? total_unrealized_pnl / total_cost_basis : 0;

    /** Compact formatting for card display */
    const compact = { compact: true } as const;

    return (
        <Card.Root
            cursor="pointer"
            onClick={(e) => onToggleExpand(account_id, e)}
            _hover={{ shadow: 'md', borderColor: 'blue.200' }}
            transition="all 0.15s"
            borderColor={isExpanded ? 'blue.300' : undefined}
            borderLeft="3px solid"
            borderLeftColor={accountColor}
            size="sm"
        >
            <Card.Body py={2.5} px={3}>
                {/* ── Zone 1: Header ── */}
                <Flex align="center" justify="space-between" mb={2}>
                    <Flex align="center" gap={1.5} minW={0} flex={1}>
                        {/* Expand chevron */}
                        <Box
                            as="button"
                            onClick={(e: React.MouseEvent) => {
                                e.stopPropagation();
                                onToggleExpand(account_id, e);
                            }}
                            p={0.5}
                            borderRadius="sm"
                            _hover={{ bg: 'gray.200' }}
                            flexShrink={0}
                        >
                            {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        </Box>

                        {/* Account color dot + name */}
                        <Box w="8px" h="8px" borderRadius="full" bg={accountColor} flexShrink={0} />
                        <Text fontSize="sm" fontWeight="medium" truncate maxW="160px" title={account_name}>
                            {account_name}
                        </Text>
                    </Flex>

                    {/* Right: asset count badge */}
                    <Badge size="xs" variant="subtle">{asset_count} assets</Badge>
                </Flex>

                {/* ── Zone 2: Metrics ── */}
                <Flex gap={3} mb={2}>
                    <Metric label="Cost" flex="1">
                        <Text fontSize="xs">
                            <ValueDisplay value={total_cost_basis} currency={baseCurrency} options={compact} />
                        </Text>
                    </Metric>

                    <Metric label="Value" flex="1">
                        <Text fontSize="xs" fontWeight="medium">
                            <ValueDisplay value={total_market_value} currency={baseCurrency} options={compact} />
                        </Text>
                    </Metric>
                </Flex>

                {/* ── Zone 3: P&L ── */}
                <Flex gap={3}>
                    <Metric label="Unrealized P&L" flex="1">
                        <Text fontSize="xs" fontWeight="medium" color={total_unrealized_pnl >= 0 ? 'green.600' : 'red.600'}>
                            <ValueDisplay value={total_unrealized_pnl} currency={baseCurrency} options={compact} />
                        </Text>
                        <Text fontSize="2xs" color="gray.500">{formatPct(unrealizedPct)}</Text>
                    </Metric>
                </Flex>

                {/* ── Zone 4: Expandable asset breakdown ── */}
                <Collapsible.Root open={isExpanded}>
                    <Collapsible.Content>
                        <Box mt={2} pt={2} borderTop="1px solid" borderColor="gray.100">
                            {details.length > 0 ? (
                                <Flex direction="column" gap={1}>
                                    {details.map((d) => {
                                        const dUnrealizedPct = d.cost_basis > 0 ? d.unrealized_pnl / d.cost_basis : 0;
                                        return (
                                            <Box
                                                key={d.asset_symbol}
                                                bg="gray.50"
                                                borderRadius="sm"
                                                px={2}
                                                py={1.5}
                                                cursor="pointer"
                                                _hover={{ bg: 'gray.100' }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onAssetClick(d.asset_id);
                                                }}
                                            >
                                                {/* Asset name + nav chevron */}
                                                <Flex align="center" justify="space-between" mb={1}>
                                                    <Badge size="xs" colorPalette="blue" fontWeight="bold" maxW="80px" truncate>
                                                        {d.asset_symbol}
                                                    </Badge>
                                                    <FiChevronRight size={10} color="gray" />
                                                </Flex>

                                                {/* Asset metrics */}
                                                <Flex gap={3} fontSize="xs">
                                                    <Box flex="1">
                                                        <Text fontSize="2xs" color="gray.400">Qty</Text>
                                                        <Text color="gray.600"><ValueDisplay value={d.qty} options={compact} /></Text>
                                                    </Box>
                                                    <Box flex="1">
                                                        <Text fontSize="2xs" color="gray.400">Cost</Text>
                                                        <Tooltip
                                                            content={
                                                                <Box p={1} fontSize="xs">
                                                                    <Flex justify="space-between" gap={3}>
                                                                        <Text color="gray.400">Unit cost</Text>
                                                                        <Text fontWeight="medium">
                                                                            <ValueDisplay value={d.unit_cost} currency={baseCurrency} />
                                                                        </Text>
                                                                    </Flex>
                                                                </Box>
                                                            }
                                                            openDelay={200}
                                                        >
                                                            <Text color="gray.600" cursor="help">
                                                                <ValueDisplay value={d.cost_basis} currency={baseCurrency} options={compact} />
                                                            </Text>
                                                        </Tooltip>
                                                    </Box>
                                                    <Box flex="1">
                                                        <Text fontSize="2xs" color="gray.400">Value</Text>
                                                        <Text color="gray.600">
                                                            <ValueDisplay value={d.market_value} currency={baseCurrency} options={compact} />
                                                        </Text>
                                                    </Box>
                                                    <Box flex="1">
                                                        <Text fontSize="2xs" color="gray.400">P&L</Text>
                                                        <Text color={d.unrealized_pnl >= 0 ? 'green.600' : 'red.600'}>
                                                            <ValueDisplay value={d.unrealized_pnl} currency={baseCurrency} options={compact} />
                                                        </Text>
                                                        <Text fontSize="2xs" color="gray.500">{formatPct(dUnrealizedPct)}</Text>
                                                    </Box>
                                                </Flex>
                                            </Box>
                                        );
                                    })}
                                </Flex>
                            ) : (
                                <Text fontSize="xs" color="gray.400" textAlign="center" py={2}>
                                    No asset details available
                                </Text>
                            )}
                        </Box>
                    </Collapsible.Content>
                </Collapsible.Root>
            </Card.Body>
        </Card.Root>
    );
};

export default AccountPnLCard;
