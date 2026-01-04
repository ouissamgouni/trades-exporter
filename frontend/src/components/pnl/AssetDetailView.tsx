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

import React, { useState, useCallback, useEffect } from 'react';
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
import { AssetPnLRow, CostLot, CalculationUnit, CostLotEventEntry } from './types';
import { UnitsTab, CostLotEventsTab } from './DataExplorerPanel';
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
    asset,
    versionId,
    baseCurrency,
    onBack,
    onTransactionClick,
}: AssetDetailViewProps) {
    // Tab state
    const [activeTab, setActiveTab] = useState<'units' | 'events'>('units');

    // Lazy loading state for Units tab
    const [unitsLoaded, setUnitsLoaded] = useState(false);
    const [isLoadingUnits, setIsLoadingUnits] = useState(false);
    const [calculationUnits, setCalculationUnits] = useState<CalculationUnit[]>([]);
    const [costLots, setCostLots] = useState<CostLot[]>([]);

    // Lazy loading state for Events tab
    const [eventsLoaded, setEventsLoaded] = useState(false);
    const [isLoadingEvents, setIsLoadingEvents] = useState(false);
    const [lotEvents, setLotEvents] = useState<CostLotEventEntry[]>([]);

    // Load units for this asset
    const loadUnits = useCallback(async () => {
        setIsLoadingUnits(true);
        try {
            // Fetch units filtered by asset_id
            const response = await fetch(`${API_URL}/pnl/versions/${versionId}/units?asset_id=${asset.asset_id}`);
            if (!response.ok) throw new Error('Failed to load units');
            const units = await response.json();

            // Map to CalculationUnit type
            const mappedUnits: CalculationUnit[] = units.map((u: any, idx: number) => {
                const primaryAsset = u.outflows?.[0]?.asset || u.inflows?.[0]?.asset || { id: 0, name: '?' };
                const transactionIds = new Set<number>();
                [...(u.outflows || []), ...(u.inflows || []), ...(u.fees || [])].forEach((leg: any) => {
                    transactionIds.add(leg.transaction_id);
                });

                return {
                    unit_id: u.unit_id ?? idx,
                    unit_label: u.unit_label || '',
                    pattern: u.pattern || 'unknown',
                    date: u.timestamp,
                    asset_id: primaryAsset.id,
                    asset_symbol: primaryAsset.name,
                    transaction_ids: Array.from(transactionIds),
                    outflow_asset_ids: u.outflows?.map((leg: any) => leg.asset.id) || [],
                    inflow_asset_ids: u.inflows?.map((leg: any) => leg.asset.id) || [],
                    fee_asset_ids: u.fees?.map((leg: any) => leg.asset.id) || [],
                    outflow_asset_symbols: u.outflows?.map((leg: any) => leg.asset.name) || [],
                    inflow_asset_symbols: u.inflows?.map((leg: any) => leg.asset.name) || [],
                    fee_asset_symbols: u.fees?.map((leg: any) => leg.asset.name) || [],
                    lots_created_uuids: u.cost_basis?.lots?.map((lot: any) => lot.cost_lot_id) || [],
                    lots_consumed_uuids: u.cost_basis?.consumed?.map((slice: any) => slice.cost_lot_id) || [],
                    consumed_slices: u.cost_basis?.consumed || [],
                    settlements: u.cost_basis?.settlements || [],
                    realized_entries: u.realized_entries || [],
                    warnings: u.warnings || [],
                    realized_pnl_in_base: u.realized_pnl_in_base || 0,
                    is_disposal_taxable: u.is_disposal_taxable || false,
                    member_count: (u.outflows?.length || 0) + (u.inflows?.length || 0) + (u.fees?.length || 0),
                    lots_created_count: u.cost_basis?.lots?.length || 0,
                    lots_consumed_count: u.cost_basis?.consumed?.length || 0,
                    realized_entry_count: u.realized_entries?.length || 0,
                    warning_count: u.warnings?.length || 0,
                };
            });

            setCalculationUnits(mappedUnits);

            // Build cost lots array from units' nested data (no separate API call needed)
            const allLots: CostLot[] = [];
            for (const unit of mappedUnits) {
                if (unit.cost_basis?.lots) {
                    for (const lot of unit.cost_basis.lots) {
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
            setCostLots(allLots);

            setUnitsLoaded(true);
        } catch (err) {
            console.error('Failed to load units:', err);
        } finally {
            setIsLoadingUnits(false);
        }
    }, [versionId, asset.asset_id]);

    // Load cost lot events for this asset
    const loadEvents = useCallback(async () => {
        setIsLoadingEvents(true);
        try {
            // Increase limit to get more events
            const response = await fetch(`${API_URL}/pnl/versions/${versionId}/lot-events?asset_id=${asset.asset_id}&limit=1000`);
            if (!response.ok) throw new Error('Failed to load lot events');
            const events = await response.json();
            setLotEvents(events);
            setEventsLoaded(true);
        } catch (err) {
            console.error('Failed to load events:', err);
        } finally {
            setIsLoadingEvents(false);
        }
    }, [versionId, asset.asset_id]);

    // Auto-load units tab data on mount (default tab)
    useEffect(() => {
        if (!unitsLoaded && !isLoadingUnits) {
            loadUnits();
        }
    }, [unitsLoaded, isLoadingUnits, loadUnits]);

    // Auto-load events when switching to events tab
    useEffect(() => {
        if (activeTab === 'events' && !eventsLoaded && !isLoadingEvents) {
            loadEvents();
        }
    }, [activeTab, eventsLoaded, isLoadingEvents, loadEvents]);

    const unrealizedColor = asset.unrealized_pnl >= 0 ? 'green.600' : 'red.600';
    const realizedColor = asset.realized_pnl >= 0 ? 'green.600' : 'red.600';
    const unrealizedPct = `${asset.unrealized_pnl_pct >= 0 ? '+' : ''}${(asset.unrealized_pnl_pct * 100).toFixed(2)}%`;

    return (
        <Box>
            {/* Header with back button */}
            <Flex align="center" gap={3} mb={4}>
                <Button variant="ghost" size="sm" onClick={onBack}>
                    <FiArrowLeft />
                </Button>
                <Heading size="lg">
                    <Badge colorPalette="blue" fontSize="xl" mr={2}>
                        {asset.asset_symbol}
                    </Badge>
                    <Text as="span" fontSize="md" color="gray.500" fontWeight="normal">
                        {asset.asset_label}
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
                                    value={formatQty(asset.quantity)}
                                    color="blue.600"
                                />
                                <MetricCard
                                    label="Market Value"
                                    value={formatCurrency(asset.market_value, baseCurrency)}
                                    color="blue.600"
                                />
                                <MetricCard
                                    label="Cost Basis"
                                    value={formatCurrency(asset.cost_basis, baseCurrency)}
                                />
                            </Flex>

                            <Text fontSize="sm" fontWeight="bold" color="gray.600" mt={4} mb={3}>
                                P&L Summary
                            </Text>
                            <Flex direction="column" gap={2}>
                                <MetricCard
                                    label="Unrealized P&L"
                                    value={formatCurrency(asset.unrealized_pnl, baseCurrency)}
                                    subValue={unrealizedPct}
                                    color={unrealizedColor}
                                    icon={asset.unrealized_pnl >= 0 ?
                                        <FiTrendingUp color="green" size={14} /> :
                                        <FiTrendingDown color="red" size={14} />
                                    }
                                />
                                <MetricCard
                                    label="Realized P&L"
                                    value={formatCurrency(asset.realized_pnl, baseCurrency)}
                                    color={realizedColor}
                                    icon={asset.realized_pnl >= 0 ?
                                        <FiTrendingUp color="green" size={14} /> :
                                        <FiTrendingDown color="red" size={14} />
                                    }
                                />
                                <MetricCard
                                    label="Total Fees"
                                    value={formatCurrency(asset.total_fees, baseCurrency)}
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
                                        <Badge size="sm" colorPalette="blue">{asset.lot_count}</Badge>
                                    </Flex>
                                </Box>
                                <Box p={3} bg="gray.50" borderRadius="md">
                                    <Flex justify="space-between" align="center">
                                        <Text fontSize="xs" color="gray.500">Realized Events</Text>
                                        <Badge size="sm" colorPalette="green">{asset.realized_event_count}</Badge>
                                    </Flex>
                                </Box>
                                {asset.warning_count > 0 && (
                                    <Box p={3} bg="orange.50" borderRadius="md">
                                        <Flex justify="space-between" align="center">
                                            <Text fontSize="xs" color="orange.600">Warnings</Text>
                                            <Badge size="sm" colorPalette="orange">{asset.warning_count}</Badge>
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
                                onValueChange={(e) => setActiveTab(e.value as 'units' | 'events')}
                            >
                                <Tabs.List px={4} pt={2}>
                                    <Tabs.Trigger value="units">
                                        Calculation Units
                                        {unitsLoaded && (
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
                                </Tabs.List>

                                <Tabs.Content value="units" p={0}>
                                    {!unitsLoaded ? (
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
                                    {!eventsLoaded ? (
                                        <LoadingPlaceholder label="Cost Lot Events" />
                                    ) : (
                                        <CostLotEventsTab
                                            events={lotEvents}
                                            baseCurrency={baseCurrency}
                                            onTransactionClick={onTransactionClick}
                                        />
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
