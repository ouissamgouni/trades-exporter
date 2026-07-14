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
import { Badge, Button, Spinner, Text } from './ui/primitives';
import { FiX, FiPieChart, FiRefreshCw, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { useBalance } from '../hooks/useBalance';
import { useAssets } from '../hooks/useAssets';
import { AssetBadge } from './AssetBadge';
import { AccountBadge } from './AccountBadge';
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
function aggregateFromAccounts(abs: AccountBalance[], txCounts?: Map<string, number>): AggregatedToken[] {
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

    return Array.from(map.values()).sort((a, b) =>
        (txCounts?.get(b.symbol.toUpperCase()) ?? 0) - (txCounts?.get(a.symbol.toUpperCase()) ?? 0)
    );
}

/** Build the token-aggregated list from a single ConnectorBalance */
function aggregateFromConnector(cb: ConnectorBalance, txCounts?: Map<string, number>): AggregatedToken[] {
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

    return Array.from(map.values()).sort((a, b) =>
        (txCounts?.get(b.symbol.toUpperCase()) ?? 0) - (txCounts?.get(a.symbol.toUpperCase()) ?? 0)
    );
}

/** Build the account-aggregated list from AccountBalance[] */
function aggregateByAccount(abs: AccountBalance[], txCounts?: Map<string, number>): AggregatedAccount[] {
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

    const accountTxScore = (acc: AggregatedAccount) =>
        acc.entries.reduce((sum, e) => sum + (txCounts?.get(e.symbol.toUpperCase()) ?? 0), 0);

    return Array.from(map.values()).sort((a, b) => accountTxScore(b) - accountTxScore(a));
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
        <div>
            <div
                className={`flex items-center justify-between px-2 py-1.5 hover:bg-gray-50 ${showDrillDown ? 'cursor-pointer' : 'cursor-default'}`}
                onClick={() => showDrillDown && setExpanded(!expanded)}
            >
                <div className="flex items-center gap-1.5">
                    {showDrillDown && (
                        <div className="text-xs text-gray-400">
                            {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        </div>
                    )}
                    <AssetBadge
                        asset={assetMap.get(token.symbol.toUpperCase())}
                        sourceSymbol={token.symbol}
                        size="xs"
                        showWarning={false}
                    />
                    {showDrillDown && (
                        <div className="flex max-w-[180px] flex-wrap gap-0.5">
                            {token.accounts.slice(0, 3).map((h, i) => (
                                <AccountBadge key={`${h.accountName}-${i}`} accountName={h.accountName} size="xs" />
                            ))}
                            {token.accounts.length > 3 && (
                                <Badge colorScheme="gray" className="text-[10px]">
                                    +{token.accounts.length - 3}
                                </Badge>
                            )}
                        </div>
                    )}
                </div>
                <Text className="font-mono text-sm font-medium">
                    {formatBalance(token.totalAmount)}
                </Text>
            </div>

            {/* Drill-down: per-account breakdown */}
            {expanded && showDrillDown && (
                <div className="mb-1 ml-5 border-l-2 border-gray-100 pl-2">
                    {token.accounts.map((h, i) => (
                        <div
                            key={`${h.accountName}-${h.connectorType}-${i}`}
                            className="flex items-center justify-between px-1 py-0.5"
                        >
                            <div className="flex flex-wrap items-center gap-1">
                                <AccountBadge accountName={h.accountName} size="xs" />
                                <Badge colorScheme="blue" className="text-[10px]">
                                    {h.connectorType}
                                </Badge>
                                {h.chain && (
                                    <Badge colorScheme="gray" className="text-[10px]">
                                        {h.chain}
                                    </Badge>
                                )}
                            </div>
                            <Text className="font-mono text-xs text-gray-600">
                                {formatBalance(h.amount)}
                            </Text>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};


const AccountRow: React.FC<{ account: AggregatedAccount; assetMap: Map<string, AssetRef> }> = ({ account, assetMap }) => {
    const [expanded, setExpanded] = useState(false);

    return (
        <div>
            <div
                className="flex cursor-pointer items-center justify-between px-2 py-1.5 hover:bg-gray-50"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-center gap-1.5">
                    <div className="text-xs text-gray-400">
                        {expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                    </div>
                    <Text className="text-sm font-medium">
                        {account.accountName}
                    </Text>
                    <Badge colorScheme="gray" className="text-[10px]">
                        {account.totalTokens} token{account.totalTokens !== 1 ? 's' : ''}
                    </Badge>
                </div>
                <div className="flex flex-wrap gap-1">
                    {account.connectors.map((ct) => (
                        <Badge key={ct} colorScheme="blue" className="text-[10px]">
                            {ct}
                        </Badge>
                    ))}
                </div>
            </div>

            {expanded && (
                <div className="mb-1 ml-5 border-l-2 border-gray-100 pl-2">
                    {account.entries.map((e, i) => (
                        <div
                            key={`${e.symbol}-${e.connectorType}-${i}`}
                            className="flex items-center justify-between px-1 py-0.5"
                        >
                            <div className="flex flex-wrap items-center gap-1">
                                <AssetBadge
                                    asset={assetMap.get(e.symbol.toUpperCase())}
                                    sourceSymbol={e.symbol}
                                    size="xs"
                                    showWarning={false}
                                />
                                <Badge colorScheme="blue" className="text-[10px]">
                                    {e.connectorType}
                                </Badge>
                                {e.chain && (
                                    <Badge colorScheme="gray" className="text-[10px]">
                                        {e.chain}
                                    </Badge>
                                )}
                            </div>
                            <Text className="font-mono text-xs text-gray-600">
                                {formatBalance(e.amount)}
                            </Text>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

const ErrorSection: React.FC<{ errors: string[] }> = ({ errors }) => {
    if (errors.length === 0) return null;
    return (
        <div className="mt-3 bg-red-50 p-2">
            <Text className="mb-1 block text-xs font-semibold text-red-600">
                Connector errors ({errors.length})
            </Text>
            {errors.map((err, i) => (
                <Text key={i} className="block text-xs text-red-500">
                    {err}
                </Text>
            ))}
        </div>
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

    // Asset map for symbol → label lookups (derived from shared cache)
    const { assets: allAssets } = useAssets(isOpen);
    const assetMap = useMemo(() => {
        const map = new Map<string, AssetRef>();
        for (const a of allAssets) {
            if (a.symbol) {
                map.set(a.symbol.toUpperCase(), {
                    id: a.asset_id ?? null,
                    symbol: a.symbol,
                    label: a.label ?? null,
                });
            }
        }
        return map;
    }, [allAssets]);

    // Fetch transaction counts for sorting
    const [txCounts, setTxCounts] = useState<Map<string, number>>(new Map());
    useEffect(() => {
        if (!isOpen) return;
        fetch(`${API_URL}/assets/transaction-counts`)
            .then((r) => r.json())
            .then((data: Record<string, number>) => {
                const map = new Map<string, number>();
                for (const [sym, cnt] of Object.entries(data)) {
                    map.set(sym.toUpperCase(), cnt);
                }
                setTxCounts(map);
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
            return aggregateFromConnector(connectorBalance, txCounts);
        }
        if ((mode === 'account' || mode === 'global') && accountBalances.length > 0) {
            return aggregateFromAccounts(accountBalances, txCounts);
        }
        return [];
    }, [mode, connectorBalance, accountBalances, txCounts]);

    // Aggregate by account view
    const accountAggs = useMemo<AggregatedAccount[]>(() => {
        if (mode === 'connector' && connectorBalance) {
            return aggregateByAccountFromConnector(connectorBalance);
        }
        if ((mode === 'account' || mode === 'global') && accountBalances.length > 0) {
            return aggregateByAccount(accountBalances, txCounts);
        }
        return [];
    }, [mode, connectorBalance, accountBalances, txCounts]);

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
            <div
                className="fixed inset-0 z-[2000] cursor-pointer bg-black/40"
                onClick={onClose}
            />

            {/* Panel */}
            <div
                className="fixed bottom-0 right-0 top-0 z-[2001] max-w-[90vw] overflow-y-auto border-l border-gray-200 bg-white shadow-xl"
                style={{ width }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Sticky header */}
                <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-gray-200 bg-gray-50 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                        <FiPieChart size={16} />
                        <Text className="text-sm font-semibold">
                            {headerTitle}
                        </Text>
                        {!isLoading && (
                            <Badge colorScheme="gray">
                                {itemCount} {itemLabel}{itemCount !== 1 ? 's' : ''}
                            </Badge>
                        )}
                    </div>
                    <div className="flex gap-1">
                        {mode !== 'connector' && (
                            <div className="flex gap-0 bg-gray-200 p-px">
                                <Button
                                    size="sm"
                                    variant={viewMode === 'byAsset' ? 'solid' : 'ghost'}
                                    onClick={() => setViewMode('byAsset')}
                                    className={`px-2 ${viewMode === 'byAsset' ? 'font-semibold' : 'font-normal'}`}
                                >
                                    By Asset
                                </Button>
                                <Button
                                    size="sm"
                                    variant={viewMode === 'byAccount' ? 'solid' : 'ghost'}
                                    onClick={() => setViewMode('byAccount')}
                                    className={`px-2 ${viewMode === 'byAccount' ? 'font-semibold' : 'font-normal'}`}
                                >
                                    By Account
                                </Button>
                            </div>
                        )}
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleRefresh}
                            className="min-w-0 p-1"
                            disabled={isLoading}
                        >
                            <FiRefreshCw size={14} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={onClose} className="min-w-0 p-1">
                            <FiX size={16} />
                        </Button>
                    </div>
                </div>

                {/* Content */}
                <div className="p-2">
                    {isLoading && accountBalances.length === 0 && (
                        <div className="flex flex-col items-center justify-center gap-2 py-8">
                            <div className="flex items-center">
                                <Spinner size="lg" />
                                <Text className="ml-3 text-sm text-gray-500">
                                    Fetching live balances…
                                </Text>
                            </div>
                            {pendingCount > 0 && (
                                <Text className="text-xs text-gray-400">
                                    {pendingCount} account{pendingCount !== 1 ? 's' : ''} remaining
                                </Text>
                            )}
                        </div>
                    )}

                    {isLoading && accountBalances.length > 0 && pendingCount > 0 && (
                        <div className="mb-1 flex items-center gap-2 bg-blue-50 px-2 py-1">
                            <Spinner size="xs" />
                            <Text className="text-xs text-blue-600">
                                {pendingCount} account{pendingCount !== 1 ? 's' : ''} remaining…
                            </Text>
                        </div>
                    )}

                    {error && !isLoading && (
                        <div className="bg-red-50 p-3 text-red-600">
                            <Text className="block text-sm font-bold">
                                Error
                            </Text>
                            <Text className="block text-xs">{error}</Text>
                        </div>
                    )}

                    {/* By Asset view */}
                    {!error && viewMode === 'byAsset' && tokens.length > 0 && (
                        <div>
                            {tokens.map((token) => (
                                <TokenRow
                                    key={token.symbol}
                                    token={token}
                                    showDrillDown={showDrillDown}
                                    assetMap={assetMap}
                                />
                            ))}
                        </div>
                    )}

                    {/* By Account view */}
                    {!error && viewMode === 'byAccount' && accountAggs.length > 0 && (
                        <div>
                            {accountAggs.map((acc) => (
                                <AccountRow
                                    key={acc.accountName}
                                    account={acc}
                                    assetMap={assetMap}
                                />
                            ))}
                        </div>
                    )}

                    {/* Empty state */}
                    {!isLoading && !error && pendingCount === 0 && itemCount === 0 && (
                        <Text className="block py-8 text-center text-sm text-gray-400">
                            No balance data available
                        </Text>
                    )}

                    {/* Connector errors */}
                    {!isLoading && <ErrorSection errors={errors} />}
                </div>
            </div>
        </>
    );
};

export default BalanceDrawer;
