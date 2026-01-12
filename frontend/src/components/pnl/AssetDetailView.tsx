/**
 * Asset Detail View - Split-View Analytics Layout with Lazy-Loaded Tabs
 * 
 * Design: Option C - Split-View Analytics with Tabs
 * - Left sidebar (30%): Asset summary with all key metrics stacked vertically
 * - Right main area (70%): Tabs for "Calculation Units" and "Cost Lot Events"
 * 
 * Principle 1: Results first, details on demand
 * Principle 3: Everything must be traceable
 * 
 * Tabs are lazy-loaded: Content is only fetched when user clicks "Load" button.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Grid,
    Heading,
    Spinner,
    Tabs,
    Text,
} from '@chakra-ui/react';
import { FiArrowLeft, FiTrendingUp, FiTrendingDown } from 'react-icons/fi';
import { AssetPnLRow, CostLot, CalculationUnit, CostLotEventEntry, mapProcessedUnitToCalculationUnit } from './types';
import { UnitsTab, CostLotEventsTab } from './DataExplorerPanel';
import { BalanceTimelineChart } from './BalanceTimelineChart';
import { API_URL } from '../../types';

interface AssetDetailViewProps {
    asset: AssetPnLRow;
    versionId: number;
    baseCurrency: string;
    onBack: () => void;
    onTransactionClick?: (txId: number) => void;
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
    if (Math.abs(value) < 0.00001) return '0';
    return value.toFixed(8).replace(/\.?0+$/, '');
};

/** Metric Card for sidebar */
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

/** Loading placeholder when data is being fetched */
const LoadingPlaceholder: React.FC<{ label: string }> = ({ label }) => (
    <Flex
        direction="column"
        align="center"
        justify="center"
        py={12}
        px={4}
        bg="gray.50"
        borderRadius="md"
        minH="200px"
    >
        <Spinner size="lg" color="blue.500" mb={4} />
        <Text fontSize="lg" fontWeight="medium" color="gray.600">
            Loading {label}...
        </Text>
    </Flex>
);

function AssetDetailView({
    asset: assetPnlRow,
    versionId,
    baseCurrency,
    onBack,
    onTransactionClick,
}: AssetDetailViewProps) {
    // Tab state
    const [activeTab, setActiveTab] = useState<'units' | 'events' | 'timeline'>('units');
    const [timelineViewMode, setTimelineViewMode] = useState<'total' | 'by-account'>('total');

    // Units data state
    const [calculationUnits, setCalculationUnits] = useState<CalculationUnit[]>([]);
    const [costLots, setCostLots] = useState<CostLot[]>([]);
    const [unitsLoading, setUnitsLoading] = useState(true);

    // Events data state  
    const [lotEvents, setLotEvents] = useState<CostLotEventEntry[]>([]);
    const [eventsLoading, setEventsLoading] = useState(false);
    const [eventsLoaded, setEventsLoaded] = useState(false);

    // Track current fetch to handle race conditions
    const fetchIdRef = useRef(0);

    // Load units on mount
    useEffect(() => {
        const currentFetchId = ++fetchIdRef.current;
        console.log(`[AssetDetailView] Fetch ${currentFetchId}: Starting units fetch for asset:`, assetPnlRow.asset.id);

        setUnitsLoading(true);
        setCalculationUnits([]);
        setCostLots([]);
        setEventsLoaded(false);
        setLotEvents([]);

        fetch(`${API_URL}/pnl/versions/${versionId}/units?asset_id=${assetPnlRow.asset.id}&limit=1000`)
            .then(response => {
                if (fetchIdRef.current !== currentFetchId) {
                    console.log(`[AssetDetailView] Fetch ${currentFetchId}: Stale response, ignoring`);
                    return null;
                }
                console.log(`[AssetDetailView] Fetch ${currentFetchId}: Response status:`, response.status);
                if (!response.ok) throw new Error('Failed to load units');
                return response.json();
            })
            .then(data => {
                if (!data || fetchIdRef.current !== currentFetchId) return;

                // API returns paginated response: { items, total, page, limit }
                const units = data.items || [];
                console.log(`[AssetDetailView] Fetch ${currentFetchId}: Units received:`, units.length);

                // Build cost lots array from raw units' nested data first (before mapping)
                const allLots: CostLot[] = [];
                for (const u of units) {
                    if (u.cost_basis?.lots) {
                        for (const lot of u.cost_basis.lots) {
                            allLots.push({
                                cost_lot_id: lot.cost_lot_id,
                                asset: lot.asset,
                                asset_id: lot.asset.id,
                                asset_symbol: lot.asset.name,
                                account_id: lot.account_id,
                                account_name: lot.account_name,
                                qty_original: lot.qty_original,
                                qty_remaining: lot.qty_remaining,
                                qty_consumed: lot.qty_consumed,
                                unit_cost_in_base: lot.unit_cost_in_base,
                                total_cost_in_base: lot.total_cost_in_base,
                                remaining_cost_in_base: lot.remaining_cost_in_base,
                                acquired_at: lot.acquired_at,
                                origin_transaction_id: lot.origin_transaction_id,
                                origin_unit_id: lot.origin_unit_id,
                                origin_unit_label: lot.origin_unit_label,
                                is_zero_cost: lot.is_zero_cost,
                                is_negative: lot.is_negative,
                                notes: lot.notes,
                            });
                        }
                    }
                }

                // Map to CalculationUnit type
                const mappedUnits: CalculationUnit[] = units.map(mapProcessedUnitToCalculationUnit);

                console.log(`[AssetDetailView] Fetch ${currentFetchId}: Setting state - units:`, mappedUnits.length, 'lots:', allLots.length);
                setCalculationUnits(mappedUnits);
                setCostLots(allLots);
                setUnitsLoading(false);
                console.log(`[AssetDetailView] Fetch ${currentFetchId}: Done, unitsLoading=false`);
            })
            .catch(err => {
                if (fetchIdRef.current !== currentFetchId) return;
                console.error(`[AssetDetailView] Fetch ${currentFetchId}: Failed to load units:`, err);
                setUnitsLoading(false);
            });
    }, [versionId, assetPnlRow.asset.id]);

    // Load events when events or timeline tab is selected
    useEffect(() => {
        if ((activeTab !== 'events' && activeTab !== 'timeline') || eventsLoaded || eventsLoading) return;

        console.log('[AssetDetailView] Starting events fetch');
        setEventsLoading(true);

        fetch(`${API_URL}/pnl/versions/${versionId}/lot-events?asset_id=${assetPnlRow.asset.id}&limit=1000`)
            .then(response => {
                if (!response.ok) throw new Error('Failed to load lot events');
                return response.json();
            })
            .then(data => {
                // API returns paginated response: { items, total, page, limit }
                const events = data.items || [];
                console.log('[AssetDetailView] Events received:', events.length);
                setLotEvents(events);
                setEventsLoaded(true);
                setEventsLoading(false);
            })
            .catch(err => {
                console.error('[AssetDetailView] Failed to load events:', err);
                setEventsLoading(false);
            });
    }, [activeTab, eventsLoaded, eventsLoading, versionId, assetPnlRow.asset.id]);

    const unrealizedColor = assetPnlRow.unrealized_pnl >= 0 ? 'green.600' : 'red.600';
    const realizedColor = assetPnlRow.realized_pnl >= 0 ? 'green.600' : 'red.600';
    const unrealizedPct = `${assetPnlRow.unrealized_pnl_pct >= 0 ? '+' : ''}${(assetPnlRow.unrealized_pnl_pct * 100).toFixed(2)}%`;

    // Debug logging for render
    console.log('[AssetDetailView] Rendering - unitsLoading:', unitsLoading, 'units:', calculationUnits.length, 'activeTab:', activeTab);

    return (
        <Box>
            {/* Header with back button */}
            <Flex align="center" gap={3} mb={4}>
                <Button variant="ghost" size="sm" onClick={onBack}>
                    <FiArrowLeft />
                </Button>
                <Heading size="lg">
                    <Badge colorPalette="blue" fontSize="xl" mr={2}>
                        {assetPnlRow.asset.symbol}
                    </Badge>
                    <Text as="span" fontSize="md" color="gray.500" fontWeight="normal">
                        {assetPnlRow.asset.label}
                    </Text>
                </Heading>
            </Flex>

            {/* Split-View Layout */}
            <Grid templateColumns={{ base: '1fr', lg: '280px 1fr' }} gap={4}>
                {/* Left Sidebar - Asset Summary */}
                <Box>
                    <Card.Root position="sticky" top="80px">
                        <Card.Body p={3}>
                            <Text fontSize="sm" fontWeight="bold" color="gray.600" mb={3}>
                                Position Summary
                            </Text>
                            <Flex direction="column" gap={2}>
                                <MetricCard
                                    label="Quantity"
                                    value={formatQty(assetPnlRow.quantity)}
                                    color="blue.600"
                                />
                                <MetricCard
                                    label="Market Value"
                                    value={formatCurrency(assetPnlRow.market_value, baseCurrency)}
                                    color="blue.600"
                                />
                                <MetricCard
                                    label="Cost Basis"
                                    value={formatCurrency(assetPnlRow.cost_basis, baseCurrency)}
                                />
                            </Flex>

                            <Text fontSize="sm" fontWeight="bold" color="gray.600" mt={4} mb={3}>
                                P&L Summary
                            </Text>
                            <Flex direction="column" gap={2}>
                                <MetricCard
                                    label="Unrealized P&L"
                                    value={formatCurrency(assetPnlRow.unrealized_pnl, baseCurrency)}
                                    subValue={unrealizedPct}
                                    color={unrealizedColor}
                                    icon={assetPnlRow.unrealized_pnl >= 0 ?
                                        <FiTrendingUp color="green" size={14} /> :
                                        <FiTrendingDown color="red" size={14} />
                                    }
                                />
                                <MetricCard
                                    label="Realized P&L"
                                    value={formatCurrency(assetPnlRow.realized_pnl, baseCurrency)}
                                    color={realizedColor}
                                    icon={assetPnlRow.realized_pnl >= 0 ?
                                        <FiTrendingUp color="green" size={14} /> :
                                        <FiTrendingDown color="red" size={14} />
                                    }
                                />
                                <MetricCard
                                    label="Total Fees"
                                    value={formatCurrency(assetPnlRow.total_fees, baseCurrency)}
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
                </Box>

                {/* Right Main Area - Tabs */}
                <Box>
                    <Card.Root>
                        <Card.Body p={0}>
                            <Tabs.Root
                                value={activeTab}
                                onValueChange={(e) => setActiveTab(e.value as 'units' | 'events' | 'timeline')}
                            >
                                <Tabs.List px={4} pt={2}>
                                    <Tabs.Trigger value="units">
                                        Calculation Units
                                        {!unitsLoading && (
                                            <Badge ml={2} size="sm" colorPalette="purple">
                                                {calculationUnits.length}
                                            </Badge>
                                        )}
                                    </Tabs.Trigger>
                                    <Tabs.Trigger value="events">
                                        Cost Lot Events
                                        {eventsLoaded && (
                                            <Badge ml={2} size="sm" colorPalette="blue">
                                                {lotEvents.length}
                                            </Badge>
                                        )}
                                    </Tabs.Trigger>
                                    <Tabs.Trigger value="timeline">
                                        Balance Timeline
                                    </Tabs.Trigger>
                                </Tabs.List>

                                <Tabs.Content value="units" p={0}>
                                    {unitsLoading ? (
                                        <LoadingPlaceholder label="Calculation Units" />
                                    ) : (
                                        <UnitsTab
                                            units={calculationUnits}
                                            baseCurrency={baseCurrency}
                                            costLots={costLots}
                                            versionId={versionId}
                                            onTransactionClick={onTransactionClick}
                                        />
                                    )}
                                </Tabs.Content>

                                <Tabs.Content value="events" p={0}>
                                    <CostLotEventsTab
                                        versionId={versionId}
                                        baseCurrency={baseCurrency}
                                        onTransactionClick={onTransactionClick}
                                        assetId={assetPnlRow.asset.id ?? undefined}
                                    />
                                </Tabs.Content>

                                <Tabs.Content value="timeline" p={4}>
                                    {!eventsLoaded ? (
                                        <LoadingPlaceholder label="Balance Timeline" />
                                    ) : (
                                        <Box>
                                            <Flex justify="flex-end" mb={4}>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => setTimelineViewMode(timelineViewMode === 'by-account' ? 'total' : 'by-account')}
                                                >
                                                    View: {timelineViewMode === 'by-account' ? 'By Account' : 'Total'}
                                                </Button>
                                            </Flex>
                                            <BalanceTimelineChart
                                                events={lotEvents}
                                                baseCurrency={baseCurrency}
                                                viewMode={timelineViewMode}
                                                assetSymbol={assetPnlRow.asset.symbol || 'Unknown'}
                                            />
                                        </Box>
                                    )}
                                </Tabs.Content>
                            </Tabs.Root>
                        </Card.Body>
                    </Card.Root>
                </Box>
            </Grid>
        </Box>
    );
}

export default AssetDetailView;
