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
import { Box, Flex, Text, Spinner } from '@chakra-ui/react';
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
}

// ============================================================================
// Loading/Error States (exported for reuse)
// ============================================================================

export const TabLoadingState: React.FC<{ message?: string }> = ({ message = 'Loading...' }) => (
    <Flex direction="column" align="center" justify="center" py={12} minH="200px">
        <Spinner size="lg" mb={4} />
        <Text fontSize="sm" color="gray.500">{message}</Text>
    </Flex>
);

export const TabErrorState: React.FC<{ error: string }> = ({ error }) => (
    <Flex
        direction="column"
        align="center"
        justify="center"
        py={12}
        px={4}
        bg="red.50"
        borderRadius="md"
        minH="200px"
    >
        <Text fontSize="lg" fontWeight="medium" color="red.600" mb={2}>
            Error Loading Data
        </Text>
        <Text fontSize="sm" color="gray.600" textAlign="center">
            {error}
        </Text>
    </Flex>
);

export const TabEmptyState: React.FC<{ title: string; description: string }> = ({ title, description }) => (
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
        <Text fontSize="lg" fontWeight="medium" color="gray.600" mb={2}>
            {title}
        </Text>
        <Text fontSize="sm" color="gray.500" textAlign="center">
            {description}
        </Text>
    </Flex>
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
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_units' });

    const { data: units, total, isLoading, error } = useLazyPaginatedQuery<CalculationUnit>({
        endpoint: `/pnl/versions/${versionId}/units`,
        page: pagination.page,
        limit: pagination.pageSize,
        lazy: lazyProp,
        enabled,
    });

    // Update pagination total
    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    if (isLoading) return <TabLoadingState message="Loading calculation units..." />;
    if (error) return <TabErrorState error={error} />;
    if (units.length === 0) return <TabEmptyState title="No Calculation Units" description="Units will appear here after P&L calculation." />;

    return (
        <Box>
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
        </Box>
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
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_lots' });

    const { data: lots, total, isLoading, error } = useLazyPaginatedQuery<CostLot>({
        endpoint: `/pnl/versions/${versionId}/lots`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: {
            asset_id: assetId,
            account_id: accountId,
        },
        lazy: lazyProp,
        enabled,
    });

    // Update pagination total
    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    if (isLoading) return <TabLoadingState message="Loading cost lots..." />;
    if (error) return <TabErrorState error={error} />;
    if (lots.length === 0) return <TabEmptyState title="No Cost Lots" description="Cost lots will appear here after P&L calculation." />;

    return (
        <Box>
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
        </Box>
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
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_realized' });

    const { data: entries, total, isLoading, error } = useLazyPaginatedQuery<RealizedPnLRow>({
        endpoint: `/pnl/versions/${versionId}/realized-pnl`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: {
            asset_id: assetId,
        },
        lazy: lazyProp,
        enabled,
    });

    // Update pagination total
    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    if (isLoading) return <TabLoadingState message="Loading realized P&L..." />;
    if (error) return <TabErrorState error={error} />;
    if (entries.length === 0) return <TabEmptyState title="No Realized P&L" description="Realized P&L entries will appear here after disposals." />;

    return (
        <Box>
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
        </Box>
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
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_fees' });
    const [feeSummary, setFeeSummary] = useState<FeeSummary | null>(null);

    const { data: fees, total, isLoading, error } = useLazyPaginatedQuery<FeeEntry>({
        endpoint: `/pnl/versions/${versionId}/fees`,
        page: pagination.page,
        limit: pagination.pageSize,
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
    if (error) return <TabErrorState error={error} />;
    if (fees.length === 0) return <TabEmptyState title="No Fees Recorded" description="Fee entries will appear here after calculation." />;

    return (
        <Box>
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
        </Box>
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
    renderTab,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_audit_warnings' });

    const { data: rawWarnings, total, isLoading, error } = useLazyPaginatedQuery<any>({
        endpoint: `/pnl/versions/${versionId}/warnings`,
        page: pagination.page,
        limit: pagination.pageSize,
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
    if (error) return <TabErrorState error={error} />;
    if (warnings.length === 0) {
        return (
            <Flex
                direction="column"
                align="center"
                justify="center"
                py={12}
                px={4}
                bg="green.50"
                borderRadius="md"
                minH="200px"
            >
                <Text fontSize="lg" fontWeight="medium" color="green.600" mb={2}>
                    ✓ No Warnings
                </Text>
                <Text fontSize="sm" color="gray.500" textAlign="center">
                    All calculations completed without issues
                </Text>
            </Flex>
        );
    }

    return (
        <Box>
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
        </Box>
    );
};
