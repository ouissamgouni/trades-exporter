/**
 * useBalance hook
 *
 * Fetches live balance data from connector APIs.
 * Supports connector-level, account-level, and global queries.
 * Global mode fetches per-account in parallel for progressive rendering.
 */

import { useState, useCallback, useRef } from 'react';
import {
    API_URL,
    type ConnectorBalance,
    type AccountBalance,
    type Account,
} from '../types';

export interface UseBalanceReturn {
    /** Account-level results (global or single account) */
    accountBalances: AccountBalance[];
    /** Single connector result (when fetching by connector) */
    connectorBalance: ConnectorBalance | null;
    /** Loading state */
    isLoading: boolean;
    /** Error message, if any */
    error: string | null;
    /** Number of accounts still loading (global mode) */
    pendingCount: number;
    /** Fetch balance for a single connector */
    fetchConnectorBalance: (connectorId: number) => Promise<void>;
    /** Fetch balance for a single account */
    fetchAccountBalance: (accountId: number) => Promise<void>;
    /** Fetch balance for all accounts (progressive) */
    fetchGlobalBalance: () => Promise<void>;
    /** Clear all results */
    clear: () => void;
}

export function useBalance(): UseBalanceReturn {
    const [accountBalances, setAccountBalances] = useState<AccountBalance[]>([]);
    const [connectorBalance, setConnectorBalance] = useState<ConnectorBalance | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingCount, setPendingCount] = useState(0);
    const abortRef = useRef<AbortController | null>(null);

    const fetchConnectorBalance = useCallback(async (connectorId: number) => {
        setIsLoading(true);
        setError(null);
        setConnectorBalance(null);
        try {
            const res = await fetch(`${API_URL}/balance/connector/${connectorId}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.detail || `HTTP ${res.status}`);
            }
            const data: ConnectorBalance = await res.json();
            setConnectorBalance(data);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setIsLoading(false);
        }
    }, []);

    const fetchAccountBalance = useCallback(async (accountId: number) => {
        setIsLoading(true);
        setError(null);
        setAccountBalances([]);
        try {
            const res = await fetch(`${API_URL}/balance/account/${accountId}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.detail || `HTTP ${res.status}`);
            }
            const data: AccountBalance = await res.json();
            setAccountBalances([data]);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setIsLoading(false);
        }
    }, []);

    const fetchGlobalBalance = useCallback(async () => {
        // Cancel any in-flight global fetch
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        setIsLoading(true);
        setError(null);
        setAccountBalances([]);
        setPendingCount(0);

        try {
            // 1. Fetch the account list
            const accountsRes = await fetch(`${API_URL}/accounts/`, {
                signal: controller.signal,
            });
            if (!accountsRes.ok) throw new Error('Failed to fetch accounts');
            const accounts: Account[] = await accountsRes.json();

            const enabled = accounts.filter((a) => a.enabled !== false);
            if (enabled.length === 0) {
                setIsLoading(false);
                return;
            }

            setPendingCount(enabled.length);

            // 2. Fetch per-account balance in parallel, append as each resolves
            const promises = enabled.map(async (account) => {
                try {
                    const res = await fetch(
                        `${API_URL}/balance/account/${account.id}`,
                        { signal: controller.signal },
                    );
                    if (!res.ok) return null;
                    const data: AccountBalance = await res.json();
                    // Only include accounts with actual balance data
                    if (data.connector_balances && data.connector_balances.length > 0) {
                        setAccountBalances((prev) => [...prev, data]);
                    }
                    return data;
                } catch {
                    return null;
                } finally {
                    setPendingCount((prev) => Math.max(0, prev - 1));
                }
            });

            await Promise.allSettled(promises);
        } catch (e: unknown) {
            if ((e as Error).name !== 'AbortError') {
                setError(e instanceof Error ? e.message : String(e));
            }
        } finally {
            if (!controller.signal.aborted) {
                setIsLoading(false);
                setPendingCount(0);
            }
        }
    }, []);

    const clear = useCallback(() => {
        abortRef.current?.abort();
        setAccountBalances([]);
        setConnectorBalance(null);
        setError(null);
        setPendingCount(0);
    }, []);

    return {
        accountBalances,
        connectorBalance,
        isLoading,
        error,
        pendingCount,
        fetchConnectorBalance,
        fetchAccountBalance,
        fetchGlobalBalance,
        clear,
    };
}
