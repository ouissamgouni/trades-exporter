/**
 * AssetPnLCard — Card-based display for a single asset P&L row.
 *
 * Replaces the table row in "By Asset" view with a compact card layout
 * that stacks data vertically and uses space more efficiently.
 *
 * Zones:
 * 1. Header — symbol badge, account dots, live balance + warning badges, nav chevron
 * 2. Metrics — qty + delta bar, cost + value in a 2×2 grid
 * 3. P&L — unrealized + realized side by side, fees inline
 * 4. Expandable — per-account balance breakdown
 */

import React, { useContext } from 'react';
import {
    Badge,
    Box,
    Card,
    Collapsible,
    Flex,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { FiChevronRight, FiChevronDown, FiAlertCircle } from 'react-icons/fi';
import { LuInfo } from 'react-icons/lu';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { AssetPnLRow, AccountBalanceBreakdown } from './types';
import { Account } from '../../types';
import type { AssetPeriodDelta } from '../../hooks/useChartData';
import { Tooltip } from '../ui/tooltip';
import { formatDateTimeLocale } from '../../utils/dateUtils';
import { ValueDisplay } from '../ValueDisplay';
import { getAccountColor } from '../../utils/accountColors';
import { DeltaBar } from './DeltaBar';
import { PnLBreakdownBar } from './PnLBreakdownBar';
import { computeDelta, formatPct, type DeltaInfo } from './deltaUtils';

// ------------------------------------------------------------------
// Helpers (same logic as table version)
// ------------------------------------------------------------------

const isPriceStale = (fetchedAt?: string): boolean => {
    if (!fetchedAt) return false;
    const isoString = fetchedAt.endsWith('Z') ? fetchedAt : fetchedAt + 'Z';
    const fetchedTime = new Date(isoString).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return fetchedTime < oneHourAgo;
};

// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

export interface AssetPnLCardProps {
    row: AssetPnLRow;
    baseCurrency: string;
    onAssetClick: (assetId: number | undefined | null) => void;
    onAccountClick?: (assetId: number, accountId: number) => void;
    isExpanded: boolean;
    onToggleExpand: (assetId: number, e: React.MouseEvent) => void;
    accountBalances?: AccountBalanceBreakdown[];
    accounts: Account[];
    /** Aggregated live qty for this asset's symbol */
    liveQty?: number;
    /** Pre-computed delta info */
    deltaInfo: DeltaInfo | null;
    liveBalanceLoading: boolean;
    /** Per-account live balances for this asset's symbol */
    liveAccountBalanceMap?: Map<number, number>;
    /** Account IDs with live balance fetch errors */
    liveAccountErrors?: Map<number, string[]>;
    /** Error account IDs relevant to this asset */
    assetErrorAccounts: number[];
    hasLiveErrors: boolean;
    /** Min/max unrealized PnL across all visible cards (for heatmap coloring) */
    unrealizedPnlRange?: { min: number; max: number };
    /** Period delta data for this asset (e.g. 1W change) */
    periodDelta?: AssetPeriodDelta;
    /** Period label to display (e.g. "1W") */
    periodLabel?: string;
    /** PnL version ID to pass when opening asset detail panel */
    pnlVersionId?: number;
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

/** Tiny label + value block reused across the card */
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

/** Heatmap background: green for best, red for worst, white in the middle */
function unrealizedHeatmapBg(val: number, range: { min: number; max: number }): string {
    const span = Math.max(Math.abs(range.min), Math.abs(range.max), 1);
    const t = Math.max(-1, Math.min(1, val / span)); // -1..1
    if (t >= 0) {
        const a = Math.min(t, 1) * 0.18;
        return `rgba(56, 161, 105, ${a.toFixed(3)})`; // green
    }
    const a = Math.min(Math.abs(t), 1) * 0.18;
    return `rgba(229, 62, 62, ${a.toFixed(3)})`; // red
}

/* CostPnlBar replaced by the reusable PnLBreakdownBar component */

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export const AssetPnLCard: React.FC<AssetPnLCardProps> = ({
    row,
    baseCurrency,
    onAssetClick,
    onAccountClick,
    isExpanded,
    onToggleExpand,
    accountBalances,
    accounts,
    liveQty,
    deltaInfo,
    liveBalanceLoading,
    liveAccountBalanceMap,
    liveAccountErrors,
    assetErrorAccounts,
    hasLiveErrors,
    unrealizedPnlRange,
    periodDelta,
    periodLabel,
    pnlVersionId,
}) => {
    const assetPanelCtx = useContext(AssetDetailPanelContext);
    const assetId = row.asset.id;
    const isNoPnl = !row.has_lots;
    const isUnmapped = !!row.is_unmapped;
    const isExpandable = !isNoPnl && row.account_ids != null && row.account_ids.length >= 1;

    const stale = isPriceStale(row.price_fetched_at);
    const hasPrice = row.unit_value != null;
    const hasError = !!row.price_error;

    /** Compact formatting for card display */
    const compact = { compact: true } as const;

    return (
        <Card.Root
            cursor={isNoPnl ? 'default' : 'pointer'}
            onClick={isNoPnl ? undefined : () => onAssetClick(assetId)}
            _hover={isNoPnl ? { shadow: 'sm' } : { shadow: 'md', borderColor: 'blue.200' }}
            transition="all 0.15s"
            borderColor={isExpanded ? 'blue.300' : undefined}
            borderStyle={isUnmapped ? 'dashed' : undefined}
            opacity={isUnmapped ? 0.7 : undefined}
            bg={isNoPnl ? 'gray.50' : undefined}
            size="sm"
        >
            <Card.Body py={1.5} px={3}>
                {/* ── Zone 1: Header ── */}
                <Flex align="center" justify="space-between" mb={1}>
                    <Flex align="center" gap={1.5} minW={0} flex={1}>
                        {/* Expand chevron */}
                        {isExpandable ? (
                            <Box
                                as="button"
                                onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    if (assetId != null) onToggleExpand(assetId, e);
                                }}
                                p={0.5}
                                borderRadius="sm"
                                _hover={{ bg: 'gray.200' }}
                                flexShrink={0}
                            >
                                {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                            </Box>
                        ) : (
                            <Box w="18px" flexShrink={0} />
                        )}

                        {/* Symbol badge */}
                        <Tooltip content={row.asset.label || row.asset.symbol || ''} openDelay={300} disabled={!row.asset.label}>
                            <Badge
                                size="sm"
                                colorPalette={isUnmapped ? 'gray' : 'blue'}
                                variant={isUnmapped ? 'outline' : 'solid'}
                                fontWeight="bold"
                                maxW="100px"
                                truncate
                            >
                                {row.asset.label
                                    ? row.asset.label.length > 10
                                        ? row.asset.label.slice(0, 10) + '…'
                                        : row.asset.label
                                    : row.asset.symbol}
                            </Badge>
                        </Tooltip>
                        {assetId != null && assetPanelCtx && (
                            <Box
                                as="button"
                                onClick={(e: React.MouseEvent) => { e.stopPropagation(); assetPanelCtx.openAssetPanel(assetId, { pnlVersionId }); }}
                                p={0.5}
                                borderRadius="sm"
                                color="gray.400"
                                _hover={{ color: 'blue.500', bg: 'blue.50' }}
                                title="Asset details"
                            >
                                <LuInfo size={12} />
                            </Box>
                        )}

                        {isUnmapped && (
                            <Tooltip content="This asset is not mapped in the database" openDelay={200}>
                                <Text color="orange.500" fontSize="xs" cursor="help">⚠</Text>
                            </Tooltip>
                        )}

                        {/* Account color dots */}
                        {accountBalances && accountBalances.length > 1 && (
                            <Flex gap={0.5} ml={1}>
                                {accountBalances.slice(0, 3).map((bal) => (
                                    <Box
                                        key={bal.account_id}
                                        w="6px"
                                        h="6px"
                                        borderRadius="full"
                                        bg={getAccountColor(bal.account_id)}
                                        title={bal.account_name}
                                    />
                                ))}
                                {accountBalances.length > 3 && (
                                    <Text fontSize="2xs" color="gray.500">+{accountBalances.length - 3}</Text>
                                )}
                            </Flex>
                        )}
                    </Flex>

                    {/* Right side: badges */}
                    <Flex align="center" gap={1.5} flexShrink={0}>
                        {isNoPnl ? (
                            isUnmapped
                                ? <Badge size="xs" colorPalette="orange" variant="subtle">Unmapped</Badge>
                                : <Badge size="xs" colorPalette="yellow" variant="subtle">No P&L</Badge>
                        ) : (
                            <>
                                {row.warning_count > 0 && (
                                    <Badge size="xs" colorPalette="orange">{row.warning_count} ⚠</Badge>
                                )}
                            </>
                        )}
                    </Flex>
                </Flex>

                {/* ── Zone 2: Metrics grid ── */}
                {!isNoPnl && (
                    <Flex gap={3} mb={1}>
                        {/* Qty */}
                        <Metric label="Qty" flex="1">
                            <Text fontSize="xs"><ValueDisplay value={row.quantity} options={compact} /></Text>
                        </Metric>

                        {/* Cost */}
                        <Metric label="Cost" flex="1">
                            <Tooltip
                                content={
                                    <Box p={1} fontSize="xs">
                                        <Flex justify="space-between" gap={3}>
                                            <Text color="gray.400">Unit cost</Text>
                                            <Text fontWeight="medium">
                                                {row.unit_cost != null
                                                    ? <ValueDisplay value={row.unit_cost} currency={baseCurrency} />
                                                    : '—'}
                                            </Text>
                                        </Flex>
                                    </Box>
                                }
                                openDelay={200}
                            >
                                <Box cursor="help">
                                    <Text fontSize="xs">
                                        <ValueDisplay value={row.cost_basis} currency={baseCurrency} options={compact} />
                                    </Text>
                                    {row.total_invested != null && Math.abs(row.total_invested - row.cost_basis) > 0.01 && (
                                        <Text fontSize="2xs" color="gray.400" lineHeight="1">
                                            invested <ValueDisplay value={row.total_invested} currency={baseCurrency} options={compact} />
                                        </Text>
                                    )}
                                </Box>
                            </Tooltip>
                        </Metric>

                        {/* Value */}
                        <Metric label="Value" flex="1">
                            {row.price_loading ? (
                                <Spinner size="xs" color="gray.400" />
                            ) : (
                                <Tooltip
                                    content={
                                        <Box p={2} fontSize="xs">
                                            <Flex justify="space-between" gap={4} mb={1}>
                                                <Text color="gray.400">Unit price</Text>
                                                <Text fontWeight="medium">
                                                    {hasPrice ? <ValueDisplay value={row.unit_value!} currency={baseCurrency} /> : '—'}
                                                </Text>
                                            </Flex>
                                            <Flex justify="space-between" gap={4} mb={1}>
                                                <Text color="gray.400">Source</Text>
                                                <Text fontWeight="medium">{row.price_source || 'N/A'}</Text>
                                            </Flex>
                                            <Flex justify="space-between" gap={4} mb={1}>
                                                <Text color="gray.400">Updated</Text>
                                                <Text fontWeight="medium">{formatDateTimeLocale(row.price_fetched_at)}</Text>
                                            </Flex>
                                            {hasError && (
                                                <Flex justify="space-between" gap={4}>
                                                    <Text color="red.400">Error</Text>
                                                    <Text color="red.300" maxW="200px" wordBreak="break-word">{row.price_error}</Text>
                                                </Flex>
                                            )}
                                            {stale && <Text color="orange.400" mt={1}>⚠ Price is stale (over 1 hour old)</Text>}
                                        </Box>
                                    }
                                    openDelay={200}
                                    closeDelay={100}
                                >
                                    <Flex align="center" gap={1} cursor="help">
                                        <Text
                                            fontSize="xs"
                                            fontWeight="medium"
                                            color={stale ? 'orange.500' : undefined}
                                            textDecoration={hasPrice ? 'underline dotted' : undefined}
                                        >
                                            {hasPrice ? <ValueDisplay value={row.market_value} currency={baseCurrency} options={compact} /> : '—'}
                                        </Text>
                                        {(stale || hasError) && (
                                            <FiAlertCircle size={10} color={hasError ? '#E53E3E' : '#DD6B20'} />
                                        )}
                                    </Flex>
                                </Tooltip>
                            )}
                        </Metric>
                    </Flex>
                )}

                {/* ── Cost vs PnL bar ── */}
                {!isNoPnl && row.cost_basis > 0 && (
                    <Box mb={1}>
                        <PnLBreakdownBar
                            costBasis={row.cost_basis}
                            unrealizedPnl={row.unrealized_pnl}
                            realizedPnl={row.realized_pnl}
                            fees={row.total_fees}
                            height={6}
                        />
                    </Box>
                )}

                {/* ── Zone 3: P&L row ── */}
                {!isNoPnl && (
                    <Flex gap={3} align="flex-start">
                        <Box
                            flex="1"
                            minW={0}
                            bg={hasPrice && unrealizedPnlRange ? unrealizedHeatmapBg(row.unrealized_pnl, unrealizedPnlRange) : undefined}
                            borderRadius="md"
                            px={1}
                            py={0.5}
                        >
                            <Text fontSize="2xs" color="gray.500" mb={0.5} lineClamp={1}>Unrealized</Text>
                            {hasPrice ? (
                                <>
                                    <Text fontSize="xs" fontWeight="medium" color={row.unrealized_pnl >= 0 ? 'green.600' : 'red.600'}>
                                        <ValueDisplay value={row.unrealized_pnl} currency={baseCurrency} options={compact} />
                                    </Text>
                                    <Text fontSize="2xs" color="gray.500">{`${row.unrealized_pnl_pct >= 0 ? '+' : ''}${Math.round(row.unrealized_pnl_pct * 100)}%`}</Text>
                                    {periodDelta && periodLabel && (
                                        <Text fontSize="2xs" color={periodDelta.unrealized_change >= 0 ? 'green.500' : 'red.500'}>
                                            {periodLabel}: <ValueDisplay value={periodDelta.unrealized_change} currency={baseCurrency} options={compact} />
                                        </Text>
                                    )}
                                </>
                            ) : (
                                <Flex align="center" gap={1}>
                                    <Text fontSize="xs" color="gray.400">—</Text>
                                    {hasError && <FiAlertCircle size={10} color="#E53E3E" />}
                                </Flex>
                            )}
                        </Box>

                        <Metric label="Realized" flex="1">
                            <Text fontSize="xs" fontWeight="medium" color={row.realized_pnl >= 0 ? 'green.600' : 'red.600'}>
                                <ValueDisplay value={row.realized_pnl} currency={baseCurrency} options={compact} />
                            </Text>
                            {row.taxable_realized_pnl !== 0 && (
                                <Text fontSize="2xs" color="gray.500">
                                    Tax: <ValueDisplay value={row.taxable_realized_pnl} currency={baseCurrency} options={compact} />
                                </Text>
                            )}
                            {periodDelta && periodLabel && (
                                <Text fontSize="2xs" color={periodDelta.realized_in_period >= 0 ? 'green.500' : 'red.500'}>
                                    {periodLabel}: <ValueDisplay value={periodDelta.realized_in_period} currency={baseCurrency} options={compact} />
                                </Text>
                            )}
                        </Metric>

                        <Metric label="Fees" flex="1">
                            <Text fontSize="2xs" color="gray.600">
                                <ValueDisplay value={Math.round(row.total_fees)} currency={baseCurrency} options={compact} />
                            </Text>
                        </Metric>
                    </Flex>
                )}

                {/* Live balance indicator — bottom right */}
                {!isNoPnl && (
                    <Flex justify="flex-end" mt={0.5}>
                        {liveBalanceLoading ? (
                            <Spinner size="xs" color="gray.400" />
                        ) : (
                            <Flex align="center" gap={0.5}>
                                <DeltaBar delta={deltaInfo} liveQty={liveQty} pnlQty={row.quantity} size="xs" />
                                {hasLiveErrors && (
                                    <Tooltip
                                        content={
                                            <Box fontSize="xs">
                                                <Text fontWeight="medium" mb={1}>Some accounts had fetch errors</Text>
                                                {assetErrorAccounts.map(accId => {
                                                    const errs = liveAccountErrors?.get(accId) ?? [];
                                                    const accName = accounts.find(a => a.id === accId)?.name ?? `Account ${accId}`;
                                                    return errs.map((err, i) => (
                                                        <Text key={`${accId}-${i}`} color="red.300">{accName}: {err}</Text>
                                                    ));
                                                })}
                                            </Box>
                                        }
                                        openDelay={200}
                                    >
                                        <Text fontSize="xs" color="orange.500" cursor="help" flexShrink={0}>⚠</Text>
                                    </Tooltip>
                                )}
                            </Flex>
                        )}
                    </Flex>
                )}

                {/* ── Zone 4: Expandable account breakdown ── */}
                {isExpandable && (
                    <Collapsible.Root open={isExpanded}>
                        <Collapsible.Content>
                            <Box mt={2} pt={2} borderTop="1px solid" borderColor="gray.100">
                                {accountBalances && accountBalances.length > 0 ? (
                                    <Flex direction="column" gap={1}>
                                        {accountBalances.map((balance) => {
                                            const accountColor = getAccountColor(balance.account_id);
                                            const unitPrice = row.unit_value;
                                            const marketValue = unitPrice != null ? balance.qty * unitPrice : 0;
                                            const unrealizedPnl = marketValue - balance.cost_basis_in_base;
                                            const unrealizedPnlPct = balance.cost_basis_in_base > 0
                                                ? unrealizedPnl / balance.cost_basis_in_base
                                                : 0;

                                            const acctLiveQty = liveAccountBalanceMap?.get(balance.account_id);
                                            const acctDelta = computeDelta(balance.qty, acctLiveQty);
                                            const acctErrors = liveAccountErrors?.get(balance.account_id);
                                            const acctHasError = acctErrors && acctErrors.length > 0 && acctLiveQty == null;

                                            return (
                                                <Box
                                                    key={balance.account_id}
                                                    bg="gray.50"
                                                    borderRadius="sm"
                                                    px={2}
                                                    py={1.5}
                                                    borderLeft="3px solid"
                                                    borderLeftColor={accountColor}
                                                >
                                                    {/* Account name */}
                                                    <Flex align="center" gap={1} mb={1}>
                                                        <Box w="6px" h="6px" borderRadius="full" bg={accountColor} flexShrink={0} />
                                                        <Text
                                                            fontSize="xs"
                                                            fontWeight="medium"
                                                            color="gray.700"
                                                            cursor={onAccountClick ? 'pointer' : undefined}
                                                            _hover={onAccountClick ? { textDecoration: 'underline', color: 'blue.600' } : undefined}
                                                            onClick={(e) => {
                                                                if (onAccountClick && assetId != null) {
                                                                    e.stopPropagation();
                                                                    onAccountClick(assetId, balance.account_id);
                                                                }
                                                            }}
                                                        >
                                                            {balance.account_name}
                                                        </Text>
                                                    </Flex>

                                                    {/* Account-level metrics */}
                                                    <Flex gap={3} fontSize="xs">
                                                        <Box flex="1">
                                                            <Text fontSize="2xs" color="gray.400">Qty</Text>
                                                            <Flex align="center" gap={1}>
                                                                <Text color="gray.600"><ValueDisplay value={balance.qty} options={compact} /></Text>
                                                                {acctHasError ? (
                                                                    <Tooltip
                                                                        content={
                                                                            <Box fontSize="xs">
                                                                                <Text fontWeight="medium" mb={1}>Fetch error:</Text>
                                                                                {acctErrors!.map((err, i) => <Text key={i} color="red.300">{err}</Text>)}
                                                                            </Box>
                                                                        }
                                                                        openDelay={200}
                                                                    >
                                                                        <Text fontSize="xs" color="red.500" cursor="help">⚠</Text>
                                                                    </Tooltip>
                                                                ) : (
                                                                    <DeltaBar delta={acctDelta} liveQty={acctLiveQty} pnlQty={balance.qty} size="xs" />
                                                                )}
                                                            </Flex>
                                                        </Box>
                                                        <Box flex="1">
                                                            <Text fontSize="2xs" color="gray.400">Value</Text>
                                                            <Text color="gray.600">
                                                                {unitPrice != null
                                                                    ? <ValueDisplay value={marketValue} currency={baseCurrency} options={compact} />
                                                                    : '—'}
                                                            </Text>
                                                        </Box>
                                                        <Box flex="1">
                                                            <Text fontSize="2xs" color="gray.400">Unrealized</Text>
                                                            {unitPrice != null ? (
                                                                <>
                                                                    <Text color={unrealizedPnl >= 0 ? 'green.600' : 'red.600'}>
                                                                        <ValueDisplay value={unrealizedPnl} currency={baseCurrency} options={compact} />
                                                                    </Text>
                                                                    <Text fontSize="2xs" color="gray.500">{formatPct(unrealizedPnlPct)}</Text>
                                                                </>
                                                            ) : (
                                                                <Text color="gray.500">—</Text>
                                                            )}
                                                        </Box>
                                                    </Flex>
                                                </Box>
                                            );
                                        })}
                                    </Flex>
                                ) : (
                                    <Text fontSize="xs" color="gray.400" textAlign="center" py={2}>
                                        Loading account breakdown...
                                    </Text>
                                )}
                            </Box>
                        </Collapsible.Content>
                    </Collapsible.Root>
                )}
            </Card.Body>
        </Card.Root>
    );
};

export default AssetPnLCard;
