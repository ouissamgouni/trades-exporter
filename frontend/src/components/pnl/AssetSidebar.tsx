/**
 * AssetSidebar – Extracted sidebar from AssetDetailView.
 *
 * Displays a compact, sticky summary card for a single asset including:
 *   - Balance / qty with optional live comparison + delta bars
 *   - Per-account breakdown rows
 *   - Market value & cost basis metrics
 *   - P&L summary (unrealized, realized, fees)
 *   - Activity counts (lots, realized events, warnings)
 *
 * Designed to be embedded in a Grid or Flex layout alongside a main content area.
 */

import React from 'react';
import {
    Badge,
    Box,
    Card,
    Flex,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { FiTrendingUp, FiTrendingDown } from 'react-icons/fi';
import { AssetPnLRow, AccountBalanceBreakdown } from './types';
import { Tooltip } from '../ui/tooltip';
import { getAccountColor } from '../../utils/accountColors';
import { DeltaBar } from './DeltaBar';
import { computeDelta } from './deltaUtils';
import { ValueDisplay } from '../ValueDisplay';
import { formatQuantityWithCurrency } from '../../utils/numberUtils';

// ─── MetricCard ─────────────────────────────────────────────────────────────

const MetricCard: React.FC<{
    label: string;
    value: string;
    subValue?: string;
    color?: string;
    icon?: React.ReactNode;
}> = ({ label, value, subValue, color, icon }) => (
    <Box
        p={3}
        bg="gray.50"
        borderRadius="md"
        borderLeft="3px solid"
        borderLeftColor={color || 'gray.300'}
    >
        <Text fontSize="xs" color="gray.500" textTransform="uppercase" letterSpacing="wide">
            {label}
        </Text>
        <Flex align="center" gap={2}>
            {icon}
            <Text fontSize="lg" fontWeight="bold" color={color} fontFamily="mono">
                {value}
            </Text>
        </Flex>
        {subValue && (
            <Text fontSize="xs" color="gray.500">{subValue}</Text>
        )}
    </Box>
);

// ─── Props ──────────────────────────────────────────────────────────────────

export interface AssetSidebarProps {
    /** Asset row from the portfolio / balances endpoint. */
    asset: AssetPnLRow;
    baseCurrency: string;

    /** Per-account P&L balance breakdown for this asset. */
    accountBreakdown?: AccountBalanceBreakdown[];
    /** Aggregated live qty for this asset. */
    liveBalance?: number;
    /** Per-account live qty: accountId → qty. */
    liveAccountBalances?: Map<number, number>;
    /** True while live balances are being fetched. */
    liveBalanceLoading?: boolean;
    /** Account IDs whose live-balance fetch completed. */
    liveFetchedAccountIds?: Set<number>;
    /** Account IDs that had connector-level errors: accountId → error messages. */
    liveAccountErrors?: Map<number, string[]>;

    /** Called when user clicks an account row (e.g. to filter by that account). */
    onAccountClick?: (accountId: number) => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const AssetSidebar: React.FC<AssetSidebarProps> = ({
    asset: assetPnlRow,
    baseCurrency,
    accountBreakdown,
    liveBalance,
    liveAccountBalances,
    liveBalanceLoading = false,
    liveFetchedAccountIds,
    liveAccountErrors,
    onAccountClick,
}) => {
    const unrealizedColor = assetPnlRow.unrealized_pnl >= 0 ? 'green.600' : 'red.600';
    const realizedColor = assetPnlRow.realized_pnl >= 0 ? 'green.600' : 'red.600';
    const unrealizedPct = `${assetPnlRow.unrealized_pnl_pct >= 0 ? '+' : ''}${(assetPnlRow.unrealized_pnl_pct * 100).toFixed(2)}%`;

    return (
        <Card.Root position="sticky" top="80px">
            <Card.Body p={3}>
                {/* ── Balances ── */}
                <Flex align="center" gap={2} mb={3}>
                    <Text fontSize="sm" fontWeight="bold" color="gray.600">
                        Balances
                    </Text>
                    {liveBalanceLoading && <Spinner size="xs" color="gray.400" />}
                </Flex>

                {/* Total row: P&L qty vs Live qty + delta */}
                {(() => {
                    const fetchDone = !liveBalanceLoading && liveFetchedAccountIds && liveFetchedAccountIds.size > 0;
                    const effectiveLive = liveBalance ?? (fetchDone ? 0 : undefined);

                    if (effectiveLive != null) {
                        const deltaInfo = computeDelta(assetPnlRow.quantity, effectiveLive);
                        const hasErrors = liveAccountErrors && liveAccountErrors.size > 0;
                        return (
                            <Box p={2} bg="blue.50" borderRadius="md" mb={2}>
                                <Flex justify="space-between" align="center" mb={1}>
                                    <Flex align="center" gap={1}>
                                        <Text fontSize="xs" color="gray.500" fontWeight="medium">Total</Text>
                                        {hasErrors && (
                                            <Tooltip content={`${liveAccountErrors!.size} account(s) had fetch errors — live total may be incomplete`} openDelay={200}>
                                                <Text fontSize="xs" color="orange.500" cursor="help">⚠</Text>
                                            </Tooltip>
                                        )}
                                    </Flex>
                                    <DeltaBar delta={deltaInfo} liveQty={effectiveLive} pnlQty={assetPnlRow.quantity} size="sm" />
                                </Flex>
                                <Flex justify="space-between" align="center">
                                    <Text fontSize="sm" fontFamily="mono" fontWeight="bold">
                                        <ValueDisplay value={assetPnlRow.quantity} options={{ maxDecimals: 4 }} />
                                    </Text>
                                </Flex>
                            </Box>
                        );
                    }

                    return (
                        <Box p={3} bg="gray.50" borderRadius="md" mb={2}>
                            <Text fontSize="xs" color="gray.500" mb={1}>Quantity</Text>
                            <Text fontSize="sm" fontFamily="mono" fontWeight="bold" color="blue.600">
                                <ValueDisplay value={assetPnlRow.quantity} options={{ maxDecimals: 4 }} />
                            </Text>
                        </Box>
                    );
                })()}

                {/* Per-account rows */}
                {accountBreakdown && accountBreakdown.length > 0 ? (
                    <Flex direction="column" gap={1} mb={2}>
                        {[...accountBreakdown]
                            .sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty))
                            .map((acct) => {
                                const acctLiveQtyRaw = liveAccountBalances?.get(acct.account_id);
                                const acctFetched = liveFetchedAccountIds?.has(acct.account_id) ?? false;
                                const acctErrors = liveAccountErrors?.get(acct.account_id);
                                const acctLiveQty = acctLiveQtyRaw ?? (acctFetched ? 0 : undefined);
                                const acctColor = getAccountColor(acct.account_id);
                                const acctDelta = computeDelta(acct.qty, acctLiveQty);
                                let deltaNode: React.ReactNode = <DeltaBar delta={null} size="xs" />;

                                if (acctErrors && acctErrors.length > 0 && acctLiveQtyRaw == null) {
                                    deltaNode = (
                                        <Tooltip
                                            content={
                                                <Box fontSize="xs">
                                                    <Text fontWeight="medium" mb={1}>Fetch error:</Text>
                                                    {acctErrors.map((err, i) => <Text key={i}>{err}</Text>)}
                                                </Box>
                                            }
                                            openDelay={200}
                                        >
                                            <Text fontSize="xs" color="red.500" cursor="help">⚠ err</Text>
                                        </Tooltip>
                                    );
                                } else if (acctLiveQty != null) {
                                    deltaNode = (
                                        <DeltaBar delta={acctDelta} liveQty={acctLiveQty} pnlQty={acct.qty} size="xs" />
                                    );
                                }

                                return (
                                    <Box key={acct.account_id} px={1.5} py={1} bg="gray.50" borderRadius="md">
                                        <Flex align="center" gap={1} mb={0.5}>
                                            <Box w="6px" h="6px" borderRadius="full" bg={acctColor} flexShrink={0} />
                                            <Text
                                                fontSize="2xs"
                                                fontWeight="medium"
                                                truncate
                                                maxW="120px"
                                                title={acct.account_name}
                                                cursor="pointer"
                                                _hover={{ textDecoration: 'underline', color: 'blue.600' }}
                                                onClick={() => onAccountClick?.(acct.account_id)}
                                            >
                                                {acct.account_name}
                                            </Text>
                                        </Flex>
                                        <Flex justify="space-between" align="center">
                                            <Text fontSize="xs" fontFamily="mono"><ValueDisplay value={acct.qty} options={{ maxDecimals: 4 }} /></Text>
                                            {deltaNode}
                                        </Flex>
                                    </Box>
                                );
                            })}
                    </Flex>
                ) : (
                    <Text fontSize="xs" color="gray.400" textAlign="center" py={2}>
                        {liveBalanceLoading ? 'Loading...' : 'No account breakdown available'}
                    </Text>
                )}

                {/* Divider */}
                <Box borderTop="1px solid" borderColor="gray.200" my={2} />

                <Flex direction="column" gap={2}>
                    <MetricCard
                        label="Market Value"
                        value={formatQuantityWithCurrency(assetPnlRow.market_value, baseCurrency)}
                        subValue={assetPnlRow.unit_value != null ? `@ ${formatQuantityWithCurrency(assetPnlRow.unit_value, baseCurrency)}/unit` : undefined}
                        color="blue.600"
                    />
                    <MetricCard
                        label="Cost Basis"
                        value={formatQuantityWithCurrency(assetPnlRow.cost_basis, baseCurrency)}
                        subValue={assetPnlRow.unit_cost != null && assetPnlRow.unit_cost > 0 ? `@ ${formatQuantityWithCurrency(assetPnlRow.unit_cost, baseCurrency)}/unit` : undefined}
                    />
                </Flex>

                <Text fontSize="sm" fontWeight="bold" color="gray.600" mt={4} mb={3}>
                    P&L Summary
                </Text>
                <Flex direction="column" gap={2}>
                    <MetricCard
                        label="Unrealized P&L"
                        value={formatQuantityWithCurrency(assetPnlRow.unrealized_pnl, baseCurrency)}
                        subValue={unrealizedPct}
                        color={unrealizedColor}
                        icon={assetPnlRow.unrealized_pnl >= 0 ?
                            <FiTrendingUp color="green" size={14} /> :
                            <FiTrendingDown color="red" size={14} />
                        }
                    />
                    <MetricCard
                        label="Realized P&L"
                        value={formatQuantityWithCurrency(assetPnlRow.realized_pnl, baseCurrency)}
                        color={realizedColor}
                        icon={assetPnlRow.realized_pnl >= 0 ?
                            <FiTrendingUp color="green" size={14} /> :
                            <FiTrendingDown color="red" size={14} />
                        }
                    />
                    <MetricCard
                        label="Total Fees"
                        value={formatQuantityWithCurrency(assetPnlRow.total_fees, baseCurrency)}
                        color="orange.600"
                    />
                </Flex>

                <Text fontSize="sm" fontWeight="bold" color="gray.600" mt={4} mb={3}>
                    Activity
                </Text>
                <Flex direction="column" gap={2}>
                    <Box p={3} bg="gray.50" borderRadius="md">
                        <Flex justify="space-between" align="center">
                            <Text fontSize="xs" color="gray.500">Cost Lots</Text>
                            <Badge size="sm" colorPalette="blue">{assetPnlRow.lot_count}</Badge>
                        </Flex>
                    </Box>
                    <Box p={3} bg="gray.50" borderRadius="md">
                        <Flex justify="space-between" align="center">
                            <Text fontSize="xs" color="gray.500">Realized Events</Text>
                            <Badge size="sm" colorPalette="green">{assetPnlRow.realized_event_count}</Badge>
                        </Flex>
                    </Box>
                    {assetPnlRow.warning_count > 0 && (
                        <Box p={3} bg="orange.50" borderRadius="md">
                            <Flex justify="space-between" align="center">
                                <Text fontSize="xs" color="orange.600">Warnings</Text>
                                <Badge size="sm" colorPalette="orange">{assetPnlRow.warning_count}</Badge>
                            </Flex>
                        </Box>
                    )}
                </Flex>
            </Card.Body>
        </Card.Root>
    );
};
