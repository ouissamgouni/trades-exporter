/**
 * P&L Audit Tab Wrappers
 * 
 * Reusable wrapper components for each audit tab that handle:
 * - Lazy loading (only fetch when tab is active)
 * - Pagination
 * - Loading/error states
 * - Data transformation
 * 
 * Each wrapper uses the useLazyPaginatedQuery hook and accepts
 * a render prop to render the actual tab content, avoiding
 * circular dependencies.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Button, Spinner } from '../ui/primitives';
import { usePagination } from '../../hooks/usePagination';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { TablePagination } from '../TablePagination';
import {
    CalculationUnit,
    CostLot,
    RealizedPnLRow,
    FeeEntry,
    PnLWarningItem,
    FeeSummary,
} from './types';
import { AssetRef } from '../../types';

// ============================================================================
// Shared Types
// ============================================================================

interface BaseTabWrapperProps {
    versionId: number;
    baseCurrency: string;
    onTransactionClick?: (txId: number) => void;
    lazy?: boolean;
    enabled?: boolean;
    /** Transaction-level filter query params to send to the P&L endpoints */
    txFilterParams?: Record<string, string | number | boolean | undefined>;
}

// ============================================================================
// Loading/Error States (exported for reuse)
// ============================================================================

export const TabLoadingState: React.FC<{ message?: string }> = ({ message = 'Loading...' }) => (
    <div className="flex min-h-[200px] flex-col items-center justify-center py-12">
        <Spinner size="lg" className="mb-4" />
        <span className="text-sm text-gray-500">{message}</span>
    </div>
);

export const TabErrorState: React.FC<{ error: string; onRetry?: () => void }> = ({ error, onRetry }) => (
    <div className="flex min-h-[200px] flex-col items-center justify-center rounded-md bg-red-50 px-4 py-12">
        <div className="mb-2 text-lg font-medium text-red-600">
            Error Loading Data
        </div>
        <div className={`text-center text-sm text-gray-600 ${onRetry ? 'mb-3' : 'mb-0'}`}>
            {error}
        </div>
        {onRetry && (
            <Button
                size="sm"
                colorScheme="gray"
                variant="outline"
                onClick={onRetry}
            >
                Retry
            </Button>
        )}
    </div>
);

export const TabEmptyState: React.FC<{ title: string; description: string }> = ({ title, description }) => (
    <div className="flex min-h-[200px] flex-col items-center justify-center rounded-md bg-gray-50 px-4 py-12">
        <div className="mb-2 text-lg font-medium text-gray-600">
            {title}
        </div>
        <div className="text-center text-sm text-gray-500">
            {description}
        </div>
    </div>
);

// ============================================================================
// Units Tab Wrapper
// ============================================================================

interface UnitsTabWrapperProps extends BaseTabWrapperProps {
    onUnitClick?: (unitId: number) => void;
    renderTab: (props: {
        units: CalculationUnit[];
        baseCurrency: string;
        versionId: number;
        onTransactionClick?: (txId: number) => void;
    }) => React.ReactNode;
}

export const UnitsTabWrapper: React.FC<UnitsTabWrapperProps> = ({
    versionId,
    baseCurrency,
    onTransactionClick,
    onUnitClick,
    lazy: lazyProp = false,
    enabled = true,
    txFilterParams,
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_units' });

    const { data: units, total, isLoading, error, refetch } = useLazyPaginatedQuery<CalculationUnit>({
        endpoint: `/pnl/versions/${versionId}/units`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: { ...txFilterParams },
        lazy: lazyProp,
        enabled,
    });

    // Update pagination total
    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    if (isLoading) return <TabLoadingState message="Loading calculation units..." />;
    if (error) return <TabErrorState error={error} onRetry={refetch} />;
    if (units.length === 0) return <TabEmptyState title="No Calculation Units" description="Units will appear here after P&L calculation." />;

    return (
        <div>
            {renderTab({
                units,
                baseCurrency,
                versionId,
                onTransactionClick,
            })}
            <TablePagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                total={total}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
            />
        </div>
    );
};

// ============================================================================
// Lots Tab Wrapper
// ============================================================================

interface LotsTabWrapperProps extends BaseTabWrapperProps {
    assetId?: number;
    accountId?: number;
    renderTab: (props: {
        lots: CostLot[];
        baseCurrency: string;
        onTransactionClick?: (txId: number) => void;
    }) => React.ReactNode;
}

export const LotsTabWrapper: React.FC<LotsTabWrapperProps> = ({
    versionId,
    baseCurrency,
    onTransactionClick,
    assetId,
    accountId,
    lazy: lazyProp = false,
    enabled = true,
    txFilterParams,
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_lots' });

    const { data: lots, total, isLoading, error, refetch } = useLazyPaginatedQuery<CostLot>({
        endpoint: `/pnl/versions/${versionId}/lots`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: {
            asset_id: assetId,
            account_id: accountId,
            ...txFilterParams,
        },
        lazy: lazyProp,
        enabled,
    });

    // Update pagination total
    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    if (isLoading) return <TabLoadingState message="Loading cost lots..." />;
    if (error) return <TabErrorState error={error} onRetry={refetch} />;
    if (lots.length === 0) return <TabEmptyState title="No Cost Lots" description="Cost lots will appear here after P&L calculation." />;

    return (
        <div>
            {renderTab({
                lots,
                baseCurrency,
                onTransactionClick,
            })}
            <TablePagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                total={total}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
            />
        </div>
    );
};

// ============================================================================
// Realized P&L Tab Wrapper
// ============================================================================

interface RealizedTabWrapperProps extends BaseTabWrapperProps {
    assetId?: number;
    renderTab: (props: {
        entries: RealizedPnLRow[];
        baseCurrency: string;
        onTransactionClick?: (txId: number) => void;
    }) => React.ReactNode;
}

export const RealizedTabWrapper: React.FC<RealizedTabWrapperProps> = ({
    versionId,
    baseCurrency,
    onTransactionClick,
    assetId,
    lazy: lazyProp = false,
    enabled = true,
    txFilterParams,
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_realized' });

    const { data: entries, total, isLoading, error, refetch } = useLazyPaginatedQuery<RealizedPnLRow>({
        endpoint: `/pnl/versions/${versionId}/realized-pnl`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: {
            asset_id: assetId,
            ...txFilterParams,
        },
        lazy: lazyProp,
        enabled,
    });

    // Update pagination total
    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    if (isLoading) return <TabLoadingState message="Loading realized P&L..." />;
    if (error) return <TabErrorState error={error} onRetry={refetch} />;
    if (entries.length === 0) return <TabEmptyState title="No Realized P&L" description="Realized P&L entries will appear here after disposals." />;

    return (
        <div>
            {renderTab({
                entries,
                baseCurrency,
                onTransactionClick,
            })}
            <TablePagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                total={total}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
            />
        </div>
    );
};

// ============================================================================
// Fees Tab Wrapper
// ============================================================================

interface FeesTabWrapperProps extends BaseTabWrapperProps {
    onUnitClick?: (unitId: number) => void;
    renderTab: (props: {
        fees: FeeEntry[];
        baseCurrency: string;
        onTransactionClick?: (txId: number) => void;
        onUnitClick?: (unitId: number) => void;
    }) => React.ReactNode;
}

export const FeesTabWrapper: React.FC<FeesTabWrapperProps> = ({
    versionId,
    baseCurrency,
    onTransactionClick,
    onUnitClick,
    lazy: lazyProp = false,
    enabled = true,
    txFilterParams,
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_fees' });
    const [feeSummary, setFeeSummary] = useState<FeeSummary | null>(null);

    const { data: fees, total, isLoading, error, refetch } = useLazyPaginatedQuery<FeeEntry>({
        endpoint: `/pnl/versions/${versionId}/fees`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: { ...txFilterParams },
        lazy: lazyProp,
        enabled,
    });

    // Fees endpoint has a different shape with summary, fetch it separately on first load
    const summaryFetchedRef = useRef(false);
    useEffect(() => {
        if (!enabled || !lazyProp || summaryFetchedRef.current) return;
        if (fees.length > 0 && !feeSummary) {
            fetch(`/api/pnl/versions/${versionId}/fees?page=1&limit=1`)
                .then(res => res.json())
                .then(data => {
                    if (data.summary) {
                        setFeeSummary(data.summary);
                    }
                    summaryFetchedRef.current = true;
                })
                .catch(() => { });
        }
    }, [enabled, lazyProp, versionId, fees, feeSummary]);

    // Update pagination total
    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    if (isLoading) return <TabLoadingState message="Loading fees..." />;
    if (error) return <TabErrorState error={error} onRetry={refetch} />;
    if (fees.length === 0) return <TabEmptyState title="No Fees Recorded" description="Fee entries will appear here after calculation." />;

    return (
        <div>
            {renderTab({
                fees,
                baseCurrency,
                onTransactionClick,
                onUnitClick,
            })}
            <TablePagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                total={total}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
            />
        </div>
    );
};

// ============================================================================
// Warnings Tab Wrapper
// ============================================================================

interface WarningsTabWrapperProps extends BaseTabWrapperProps {
    quoteAssetId?: number;
    onPriceAdded?: (assetId: number, warningId: string) => void;
    assets?: AssetRef[];
    renderTab: (props: {
        warnings: PnLWarningItem[];
        baseCurrency: string;
        onTransactionClick?: (txId: number) => void;
        quoteAssetId?: number;
        onPriceAdded?: (assetId: number, warningId: string) => void;
        assets?: AssetRef[];
    }) => React.ReactNode;
}

export const WarningsTabWrapper: React.FC<WarningsTabWrapperProps> = ({
    versionId,
    baseCurrency,
    onTransactionClick,
    quoteAssetId,
    onPriceAdded,
    assets,
    lazy: lazyProp = false,
    enabled = true,
    txFilterParams,
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_warnings' });

    const { data: rawWarnings, total, isLoading, error, refetch } = useLazyPaginatedQuery<any>({
        endpoint: `/pnl/versions/${versionId}/warnings`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: { ...txFilterParams },
        lazy: lazyProp,
        enabled,
    });

    // Transform warnings to match PnLWarningItem interface
    const warnings: PnLWarningItem[] = rawWarnings.map((w: any, index: number) => ({
        id: w.warning_id?.toString() || `warning-${index}`,
        level: 'warning' as const,
        warning_type: w.warning_type,
        message: w.message,
        timestamp: w.timestamp,
        transaction_id: w.transaction_id,
        unit_id: w.unit_id,
        unit_label: w.unit_label,
        asset_id: w.asset_id,
        details: w.details,
    }));

    // Update pagination total
    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    if (isLoading) return <TabLoadingState message="Loading warnings..." />;
    if (error) return <TabErrorState error={error} onRetry={refetch} />;
    if (warnings.length === 0) {
        return (
            <div className="flex min-h-[200px] flex-col items-center justify-center rounded-md bg-green-50 px-4 py-12">
                <div className="mb-2 text-lg font-medium text-green-600">
                    ✓ No Warnings
                </div>
                <div className="text-center text-sm text-gray-500">
                    All calculations completed without issues
                </div>
            </div>
        );
    }

    return (
        <div>
            {renderTab({
                warnings,
                baseCurrency,
                onTransactionClick,
                quoteAssetId,
                onPriceAdded,
                assets,
            })}
            <TablePagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                total={total}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
            />
        </div>
    );
};

// ============================================================================
// Transactions Tab Wrapper
// ============================================================================

interface TransactionsTabWrapperProps extends BaseTabWrapperProps {
    renderTab: (props: {
        versionId: number;
        baseCurrency: string;
        onTransactionClick?: (txId: number) => void;
    }) => React.ReactNode;
}

export const TransactionsTabWrapper: React.FC<TransactionsTabWrapperProps> = ({
    versionId,
    baseCurrency,
    onTransactionClick,
    lazy: lazyProp = false,
    enabled = true,
    renderTab,
}) => {
    // TransactionsTable handles its own data fetching
    // We just control when it's rendered based on enabled prop

    if (!enabled && lazyProp) {
        return null;
    }

    return (
        <div>
            {renderTab({
                versionId,
                baseCurrency,
                onTransactionClick,
            })}
        </div>
    );
};
