/**
 * usePnLCalculationStatus
 * 
 * Polling hook for the P&L calculation service status.
 * Polls GET /pnl/calculation-status at configurable intervals.
 * 
 * - 5s when actively calculating or user is viewing P&L tab
 * - 30s when idle/completed and P&L tab not active
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { API_URL } from '../types';
import { PnLCalcStatus, PnLCalculationStatusResponse } from '../components/pnl/types';

const ACTIVE_POLL_INTERVAL = 5_000;   // 5s when calculating or tab active
const IDLE_POLL_INTERVAL = 30_000;    // 30s otherwise

export interface UsePnLCalculationStatusOptions {
    /** Whether the P&L tab is currently active/visible */
    isActive?: boolean;
    /** Callback when a new version becomes available (version_id changed) */
    onNewVersion?: (versionId: number) => void;
}

export interface UsePnLCalculationStatusReturn {
    status: PnLCalcStatus;
    isStale: boolean;
    isCalculating: boolean;
    staleSince: string | null;
    staleReasons: string[];
    currentVersionId: number | null;
    lastCalculatedAt: string | null;
    error: string | null;
    /** Trigger a manual refresh calculation */
    triggerRefresh: () => Promise<boolean>;
    /** Force re-fetch status now */
    refetchStatus: () => Promise<void>;
}

export function usePnLCalculationStatus(
    options: UsePnLCalculationStatusOptions = {}
): UsePnLCalculationStatusReturn {
    const { isActive = false, onNewVersion } = options;

    const [statusData, setStatusData] = useState<PnLCalculationStatusResponse>({
        status: 'idle',
        stale_since: null,
        stale_reasons: [],
        current_version_id: null,
        last_calculated_at: null,
        error: null,
    });

    const previousVersionIdRef = useRef<number | null>(null);
    const hasInitializedRef = useRef(false);
    const onNewVersionRef = useRef(onNewVersion);
    onNewVersionRef.current = onNewVersion;

    const fetchStatus = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/pnl/calculation-status`);
            if (response.ok) {
                const data: PnLCalculationStatusResponse = await response.json();
                setStatusData(data);

                // Detect new version
                if (data.current_version_id !== null) {
                    if (!hasInitializedRef.current) {
                        // First poll — store version but don't fire callback
                        // (PnLPanel handles initial load via its own useEffect)
                        hasInitializedRef.current = true;
                    } else if (data.current_version_id !== previousVersionIdRef.current) {
                        // Subsequent poll — version changed, notify parent
                        onNewVersionRef.current?.(data.current_version_id);
                    }
                }
                previousVersionIdRef.current = data.current_version_id;
            }
        } catch {
            // Silently ignore fetch errors (network issues, server down)
        }
    }, []);

    const triggerRefresh = useCallback(async (): Promise<boolean> => {
        try {
            const response = await fetch(`${API_URL}/pnl/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (response.ok) {
                const data = await response.json();
                // Immediately re-fetch status to get calculating state
                await fetchStatus();
                return data.started === true;
            }
            return false;
        } catch {
            return false;
        }
    }, [fetchStatus]);

    // Polling effect
    useEffect(() => {
        // Fetch immediately on mount
        fetchStatus();

        const isActivePolling = isActive || statusData.status === 'calculating';
        const interval = isActivePolling ? ACTIVE_POLL_INTERVAL : IDLE_POLL_INTERVAL;

        const timer = setInterval(fetchStatus, interval);
        return () => clearInterval(timer);
    }, [fetchStatus, isActive, statusData.status]);

    return {
        status: statusData.status,
        isStale: statusData.status === 'stale',
        isCalculating: statusData.status === 'calculating',
        staleSince: statusData.stale_since,
        staleReasons: statusData.stale_reasons,
        currentVersionId: statusData.current_version_id,
        lastCalculatedAt: statusData.last_calculated_at,
        error: statusData.error,
        triggerRefresh,
        refetchStatus: fetchStatus,
    };
}
