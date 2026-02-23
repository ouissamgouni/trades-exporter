/**
 * BalanceDrawer - Slide-in drawer showing live balances from connector APIs.
 *
 * Primary view: token-aggregated list (e.g. "BTC  1.234")
 * Drill-down: expand a token row to see per-account breakdown.
 *
 * Supports three modes:
 * - Global: all accounts / connectors
 * - Account: single account (all its connectors)
 * - Connector: single connector
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
    Box,
    Flex,
    Text,
    Spinner,
    Badge,
    Button,
} from '@chakra-ui/react';
import { FiX, FiDollarSign, FiRefreshCw, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { useBalance } from '../hooks/useBalance';
import { AssetBadge } from './AssetBadge';
import { API_URL } from '../types';
import type { ConnectorBalance, AccountBalance, AssetRef } from '../types';

// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

export interface BalanceDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    mode: 'global' | 'account' | 'connector';
    accountId?: number;
    connectorId?: number;
    title?: string;
    width?: string;
}

// ------------------------------------------------------------------
// Aggregation types & helpers
// ------------------------------------------------------------------

interface AccountHolding {
    accountName: string;
    accountType: string;
    group: string | null;
    connectorType: string;
    chain: string | null;
    amount: number;
}

interface AggregatedToken {
    symbol: string;
    totalAmount: number;
    accounts: AccountHolding[];
}

interface AccountEntry {
    symbol: string;
    amount: number;
    connectorType: string;
    chain: string | null;
}

interface AggregatedAccount {
    accountName: string;
    accountType: string;
    group: string | null;
    connectors: string[];
    totalTokens: number;
    entries: AccountEntry[];
}

type ViewMode = 'byAsset' | 'byAccount';

function formatBalance(value: number): string {
    if (value === 0) return '0';
    if (Math.abs(value) < 0.000001) return value.toExponential(4);
    return value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 8,
    });
}

/** Aggregate ConnectorBalance entries into a flat AccountHolding array */
function flattenConnectorBalance(cb: ConnectorBalance): AccountHolding[] {
    return cb.entries.map((entry) => ({
        accountName: cb.account_name,
        accountType: '',
        group: null,
        connectorType: cb.connector_type,
        chain: entry.chain ?? cb.chain,
        amount: parseFloat(entry.total) || 0,
        symbol: entry.asset_symbol,
    }));
}

/** Build the token-aggregated list from AccountBalance[] */
function aggregateFromAccounts(abs: AccountBalance[]): AggregatedToken[] {
    const map = new Map<string, AggregatedToken>();

    for (const ab of abs) {
        for (const cb of ab.connector_balances) {
            for (const entry of cb.entries) {
                const sym = entry.asset_symbol;
                const amount = parseFloat(entry.total) || 0;
                if (!map.has(sym)) {
                    map.set(sym, { symbol: sym, totalAmount: 0, accounts: [] });
                }
                const agg = map.get(sym)!;
                agg.totalAmount += amount;
                agg.accounts.push({
                    accountName: ab.account_name,
                    accountType: ab.account_type,
                    group: ab.group,
                    connectorType: cb.connector_type,
                    chain: entry.chain ?? cb.chain,
                    amount,
                });
            }
        }
    }

    return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
}

/** Build the token-aggregated list from a single ConnectorBalance */
function aggregateFromConnector(cb: ConnectorBalance): AggregatedToken[] {
    const map = new Map<string, AggregatedToken>();

    for (const entry of cb.entries) {
        const sym = entry.asset_symbol;
        const amount = parseFloat(entry.total) || 0;
        if (!map.has(sym)) {
            map.set(sym, { symbol: sym, totalAmount: 0, accounts: [] });
        }
        const agg = map.get(sym)!;
        agg.totalAmount += amount;
        agg.accounts.push({
            accountName: cb.account_name,
            accountType: '',
            group: null,
            connectorType: cb.connector_type,
            chain: entry.chain ?? cb.chain,
            amount,
        });
    }

    return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
}

/** Build the account-aggregated list from AccountBalance[] */
function aggregateByAccount(abs: AccountBalance[]): AggregatedAccount[] {
    const map = new Map<string, AggregatedAccount>();

    for (const ab of abs) {
        if (!map.has(ab.account_name)) {
            map.set(ab.account_name, {
                accountName: ab.account_name,
                accountType: ab.account_type,
                group: ab.group,
                connectors: [],
                totalTokens: 0,
                entries: [],
            });
        }
        const agg = map.get(ab.account_name)!;
        for (const cb of ab.connector_balances) {
            if (!agg.connectors.includes(cb.connector_type)) {
                agg.connectors.push(cb.connector_type);
            }
            for (const entry of cb.entries) {
                const amount = parseFloat(entry.total) || 0;
                agg.entries.push({
                    symbol: entry.asset_symbol,
                    amount,
                    connectorType: cb.connector_type,
                    chain: entry.chain ?? cb.chain,
                });
            }
        }
        agg.totalTokens = agg.entries.length;
    }

    return Array.from(map.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Build the account-aggregated list from a single ConnectorBalance */
function aggregateByAccountFromConnector(cb: ConnectorBalance): AggregatedAccount[] {
    const entries: AccountEntry[] = cb.entries.map((entry) => ({
        symbol: entry.asset_symbol,
        amount: parseFloat(entry.total) || 0,
        connectorType: cb.connector_type,
        chain: entry.chain ?? cb.chain,
    }));

    return [{
        accountName: cb.account_name,
        accountType: '',
        group: null,
        connectors: [cb.connector_type],
        totalTokens: entries.length,
        entries: entries.sort((a, b) => b.amount - a.amount),
    }];
}

/** Collect errors from connector balances */
function collectErrors(abs: AccountBalance[], cb: ConnectorBalance | null): string[] {
    const errs: string[] = [];
    if (cb?.error) errs.push(`${cb.connector_type}: ${cb.error}`);
    for (const ab of abs) {
        for (const c of ab.connector_balances) {
            if (c.error) errs.push(`${ab.account_name} › ${c.connector_type}: ${c.error}`);
        }
    }
    return errs;
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

const TokenRow: React.FC<{
    token: AggregatedToken;
    showDrillDown: boolean;
    assetMap: Map<string, AssetRef>;
}> = ({ token, showDrillDown, assetMap }) => {
    const [expanded, setExpanded] = useState(false);

    return (
        <Box>
            <Flex
                justify="space-between"
                align="center"
                py={1.5}
                px={2}
                _hover={{ bg: 'gray.50' }}
                borderRadius="sm"
                cursor={showDrillDown ? 'pointer' : 'default'}
                onClick={() => showDrillDown && setExpanded(!expanded)}
            >
                <Flex align="center" gap={1.5}>
                    {showDrillDown && (
                        <Box color="gray.400" fontSize="xs">
                            {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        </Box>
                    )}
                    <AssetBadge
                        asset={assetMap.get(token.symbol.toUpperCase())}
                        sourceSymbol={token.symbol}
                        size="xs"
                        showWarning={false}
                    />
                    {showDrillDown && (
                        <Badge size="xs" variant="subtle" colorPalette="gray" fontSize="2xs">
                            {token.accounts.length} acct{token.accounts.length !== 1 ? 's' : ''}
                        </Badge>
                    )}
                </Flex>
                <Text fontSize="sm" fontFamily="mono" fontWeight="medium">
                    {formatBalance(token.totalAmount)}
                </Text>
            </Flex>

            {/* Drill-down: per-account breakdown */}
            {expanded && showDrillDown && (
                <Box ml={5} mb={1} borderLeft="2px solid" borderColor="gray.100" pl={2}>
                    {token.accounts.map((h, i) => (
                        <Flex
                            key={`${h.accountName}-${h.connectorType}-${i}`}
                            justify="space-between"
                            align="center"
                            py={0.5}
                            px={1}
                        >
                            <Flex align="center" gap={1} flexWrap="wrap">
                                <Text fontSize="xs" color="gray.700">
                                    {h.accountName}
                                </Text>
                                <Badge size="xs" variant="outline" colorPalette="blue" fontSize="2xs">
                                    {h.connectorType}
                                </Badge>
                                {h.chain && (
                                    <Badge size="xs" variant="subtle" colorPalette="gray" fontSize="2xs">
                                        {h.chain}
                                    </Badge>
                                )}
                            </Flex>
                            <Text fontSize="xs" fontFamily="mono" color="gray.600">
                                {formatBalance(h.amount)}
                            </Text>
                        </Flex>
                    ))}
                </Box>
            )}
        </Box>
    );
};

const AccountRow: React.FC<{ account: AggregatedAccount; assetMap: Map<string, AssetRef> }> = ({ account, assetMap }) => {
    const [expanded, setExpanded] = useState(false);

    return (
        <Box>
            <Flex
                justify="space-between"
                align="center"
                py={1.5}
                px={2}
                _hover={{ bg: 'gray.50' }}
                borderRadius="sm"
                cursor="pointer"
                onClick={() => setExpanded(!expanded)}
            >
                <Flex align="center" gap={1.5}>
                    <Box color="gray.400" fontSize="xs">
                        {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                    </Box>
                    <Text fontSize="sm" fontWeight="medium">
                        {account.accountName}
                    </Text>
                    {account.accountType && (
                        <Badge size="xs" variant="subtle" colorPalette="purple" fontSize="2xs">
                            {account.accountType}
                        </Badge>
                    )}
                    {account.group && (
                        <Badge size="xs" variant="outline" colorPalette="teal" fontSize="2xs">
                            {account.group}
                        </Badge>
                    )}
                    <Badge size="xs" variant="subtle" colorPalette="gray" fontSize="2xs">
                        {account.totalTokens} token{account.totalTokens !== 1 ? 's' : ''}
                    </Badge>
                </Flex>
                <Flex gap={1} flexWrap="wrap">
                    {account.connectors.map((ct) => (
                        <Badge key={ct} size="xs" variant="outline" colorPalette="blue" fontSize="2xs">
                            {ct}
                        </Badge>
                    ))}
                </Flex>
            </Flex>

            {expanded && (
                <Box ml={5} mb={1} borderLeft="2px solid" borderColor="gray.100" pl={2}>
                    {account.entries.map((e, i) => (
                        <Flex
                            key={`${e.symbol}-${e.connectorType}-${i}`}
                            justify="space-between"
                            align="center"
                            py={0.5}
                            px={1}
                        >
                            <Flex align="center" gap={1} flexWrap="wrap">
                                <AssetBadge
                                    asset={assetMap.get(e.symbol.toUpperCase())}
                                    sourceSymbol={e.symbol}
                                    size="xs"
                                    showWarning={false}
                                />
                                <Badge size="xs" variant="outline" colorPalette="blue" fontSize="2xs">
                                    {e.connectorType}
                                </Badge>
                                {e.chain && (
                                    <Badge size="xs" variant="subtle" colorPalette="gray" fontSize="2xs">
                                        {e.chain}
                                    </Badge>
                                )}
                            </Flex>
                            <Text fontSize="xs" fontFamily="mono" color="gray.600">
                                {formatBalance(e.amount)}
                            </Text>
                        </Flex>
                    ))}
                </Box>
            )}
        </Box>
    );
};

const ErrorSection: React.FC<{ errors: string[] }> = ({ errors }) => {
    if (errors.length === 0) return null;
    return (
        <Box mt={3} p={2} bg="red.50" borderRadius="md">
            <Text fontSize="xs" fontWeight="semibold" color="red.600" mb={1}>
                Connector errors ({errors.length})
            </Text>
            {errors.map((err, i) => (
                <Text key={i} fontSize="xs" color="red.500">
                    {err}
                </Text>
            ))}
        </Box>
    );
};

// ------------------------------------------------------------------
// Main Component
// ------------------------------------------------------------------

export const BalanceDrawer: React.FC<BalanceDrawerProps> = ({
    isOpen,
    onClose,
    mode,
    accountId,
    connectorId,
    title,
    width = '440px',
}) => {
    const {
        accountBalances,
        connectorBalance,
        isLoading,
        error,
        pendingCount,
        fetchConnectorBalance,
        fetchAccountBalance,
        fetchGlobalBalance,
        clear,
    } = useBalance();

    // Asset map for symbol → label lookups
    const [assetMap, setAssetMap] = useState<Map<string, AssetRef>>(new Map());

    useEffect(() => {
        if (!isOpen) return;
        fetch(`${API_URL}/assets?limit=10000`)
            .then((res) => (res.ok ? res.json() : []))
            .then((assets: Array<{ asset_id?: number; symbol?: string; label?: string }>) => {
                const map = new Map<string, AssetRef>();
                for (const a of assets) {
                    if (a.symbol) {
                        map.set(a.symbol.toUpperCase(), {
                            id: a.asset_id ?? null,
                            symbol: a.symbol,
                            label: a.label ?? null,
                        });
                    }
                }
                setAssetMap(map);
            })
            .catch(() => { });
    }, [isOpen]);

    // Trigger fetch when drawer opens
    useEffect(() => {
        if (!isOpen) {
            clear();
            return;
        }
        if (mode === 'global') fetchGlobalBalance();
        else if (mode === 'account' && accountId) fetchAccountBalance(accountId);
        else if (mode === 'connector' && connectorId) fetchConnectorBalance(connectorId);
    }, [isOpen, mode, accountId, connectorId]);

    const handleRefresh = () => {
        if (mode === 'global') fetchGlobalBalance();
        else if (mode === 'account' && accountId) fetchAccountBalance(accountId);
        else if (mode === 'connector' && connectorId) fetchConnectorBalance(connectorId);
    };

    // View mode toggle
    const [viewMode, setViewMode] = useState<ViewMode>('byAsset');

    // Aggregate tokens (by asset view)
    const tokens = useMemo<AggregatedToken[]>(() => {
        if (mode === 'connector' && connectorBalance) {
            return aggregateFromConnector(connectorBalance);
        }
        if ((mode === 'account' || mode === 'global') && accountBalances.length > 0) {
            return aggregateFromAccounts(accountBalances);
        }
        return [];
    }, [mode, connectorBalance, accountBalances]);

    // Aggregate by account view
    const accountAggs = useMemo<AggregatedAccount[]>(() => {
        if (mode === 'connector' && connectorBalance) {
            return aggregateByAccountFromConnector(connectorBalance);
        }
        if ((mode === 'account' || mode === 'global') && accountBalances.length > 0) {
            return aggregateByAccount(accountBalances);
        }
        return [];
    }, [mode, connectorBalance, accountBalances]);

    // Show drill-down only when multiple accounts could contribute
    const showDrillDown = mode === 'global' || (mode === 'account' && accountBalances.length > 0);

    const itemCount = viewMode === 'byAsset' ? tokens.length : accountAggs.length;
    const itemLabel = viewMode === 'byAsset' ? 'token' : 'account';

    // Errors
    const errors = useMemo(
        () => collectErrors(accountBalances, connectorBalance),
        [accountBalances, connectorBalance],
    );

    if (!isOpen) return null;

    const headerTitle =
        title ||
        (mode === 'global'
            ? 'Global Balance'
            : mode === 'account'
                ? 'Account Balance'
                : 'Connector Balance');

    return (
        <>
            {/* Backdrop */}
            <Box
                position="fixed"
                inset={0}
                bg="blackAlpha.400"
                zIndex={2000}
                onClick={onClose}
                cursor="pointer"
            />

            {/* Panel */}
            <Box
                position="fixed"
                right={0}
                top={0}
                bottom={0}
                width={width}
                maxW="90vw"
                bg="white"
                boxShadow="xl"
                zIndex={2001}
                overflowY="auto"
                borderLeft="1px solid"
                borderColor="gray.200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Sticky header */}
                <Flex
                    justify="space-between"
                    align="center"
                    px={3}
                    py={2}
                    borderBottom="1px solid"
                    borderColor="gray.200"
                    bg="gray.50"
                    position="sticky"
                    top={0}
                    zIndex={1}
                >
                    <Flex align="center" gap={1.5}>
                        <FiDollarSign size={16} />
                        <Text fontWeight="semibold" fontSize="sm">
                            {headerTitle}
                        </Text>
                        {!isLoading && (
                            <Badge size="xs" variant="subtle" colorPalette="gray">
                                {itemCount} {itemLabel}{itemCount !== 1 ? 's' : ''}
                            </Badge>
                        )}
                    </Flex>
                    <Flex gap={1}>
                        {mode !== 'connector' && (
                            <Flex bg="gray.200" borderRadius="md" p="1px" gap={0}>
                                <Button
                                    size="xs"
                                    variant={viewMode === 'byAsset' ? 'solid' : 'ghost'}
                                    onClick={() => setViewMode('byAsset')}
                                    px={2}
                                    borderRadius="md"
                                    fontWeight={viewMode === 'byAsset' ? 'semibold' : 'normal'}
                                >
                                    By Asset
                                </Button>
                                <Button
                                    size="xs"
                                    variant={viewMode === 'byAccount' ? 'solid' : 'ghost'}
                                    onClick={() => setViewMode('byAccount')}
                                    px={2}
                                    borderRadius="md"
                                    fontWeight={viewMode === 'byAccount' ? 'semibold' : 'normal'}
                                >
                                    By Account
                                </Button>
                            </Flex>
                        )}
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={handleRefresh}
                            p={1}
                            disabled={isLoading}
                        >
                            <FiRefreshCw size={14} />
                        </Button>
                        <Button variant="ghost" size="xs" onClick={onClose} p={1}>
                            <FiX size={16} />
                        </Button>
                    </Flex>
                </Flex>

                {/* Content */}
                <Box p={2}>
                    {isLoading && accountBalances.length === 0 && (
                        <Flex justify="center" align="center" direction="column" py={8} gap={2}>
                            <Flex align="center">
                                <Spinner size="lg" />
                                <Text ml={3} color="gray.500" fontSize="sm">
                                    Fetching live balances…
                                </Text>
                            </Flex>
                            {pendingCount > 0 && (
                                <Text fontSize="xs" color="gray.400">
                                    {pendingCount} account{pendingCount !== 1 ? 's' : ''} remaining
                                </Text>
                            )}
                        </Flex>
                    )}

                    {isLoading && accountBalances.length > 0 && pendingCount > 0 && (
                        <Flex align="center" gap={2} px={2} py={1} mb={1} bg="blue.50" borderRadius="md">
                            <Spinner size="xs" />
                            <Text fontSize="xs" color="blue.600">
                                {pendingCount} account{pendingCount !== 1 ? 's' : ''} remaining…
                            </Text>
                        </Flex>
                    )}

                    {error && !isLoading && (
                        <Box p={3} bg="red.50" borderRadius="md" color="red.600">
                            <Text fontWeight="bold" fontSize="sm">
                                Error
                            </Text>
                            <Text fontSize="xs">{error}</Text>
                        </Box>
                    )}

                    {/* By Asset view */}
                    {!error && viewMode === 'byAsset' && tokens.length > 0 && (
                        <Box>
                            {tokens.map((token) => (
                                <TokenRow
                                    key={token.symbol}
                                    token={token}
                                    showDrillDown={showDrillDown}
                                    assetMap={assetMap}
                                />
                            ))}
                        </Box>
                    )}

                    {/* By Account view */}
                    {!error && viewMode === 'byAccount' && accountAggs.length > 0 && (
                        <Box>
                            {accountAggs.map((acc) => (
                                <AccountRow
                                    key={acc.accountName}
                                    account={acc}
                                    assetMap={assetMap}
                                />
                            ))}
                        </Box>
                    )}

                    {/* Empty state */}
                    {!isLoading && !error && pendingCount === 0 && itemCount === 0 && (
                        <Text
                            color="gray.400"
                            textAlign="center"
                            py={8}
                            fontSize="sm"
                        >
                            No balance data available
                        </Text>
                    )}

                    {/* Connector errors */}
                    {!isLoading && <ErrorSection errors={errors} />}
                </Box>
            </Box>
        </>
    );
};

export default BalanceDrawer;
