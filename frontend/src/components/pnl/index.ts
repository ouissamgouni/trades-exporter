/**
 * P&L Module Exports
 */

// Main panel
export { PnLPanel } from './PnLPanel';
export { default } from './PnLPanel';

// Components
export { CalculationContext } from './CalculationContext';
export { SummaryCards, SummaryBar } from './SummaryCards';
export { AssetPnLTable } from './AssetPnLTable';
export { default as AssetDetailView } from './AssetDetailView';
export { PnLImpactPanel } from './PnLImpactPanel';
export { FeesPanel } from './FeesPanel';
export { WarningsPanel } from './WarningsPanel';
export { PnLAuditView, UnitsTab, CostLotEventsTab } from './DataExplorerPanel';
export { SlidePanel } from './SlidePanel';
export { CategoryFilterBar } from './CategoryFilterBar';
export { PnLBreakdownBar } from './PnLBreakdownBar';
export { MarketValuePieChart } from './MarketValuePieChart';
export { ChartsDashboard } from './ChartsDashboard';
export { TotalReturnScorecard } from './TotalReturnScorecard';
export { CostBasisVsMarketValueChart } from './CostBasisVsMarketValueChart';
export { AllocationTreemap } from './AllocationTreemap';
// Re-export from unified hooks
export { getPersistedPageSize, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE } from '../../hooks/usePagination';

// Types
export type {
    CalculationStatus,
    CalculationConfig,
    CalculationVersion,
    SavedPnLVersion,
    PnLSummary,
    AssetPnLRow,
    CostLot,
    RealizedPnLRow,
    PnLImpactEvent,
    ConsumedLotDetail,
    EventTransaction,
    FeeEntry,
    FeeSummary,
    PnLWarningItem,
    WarningLevel,
    PnLView,
    PnLViewState,
    CalculationUnit,
    BundleSummary,
    TransactionSummary,
    PieChartDataPoint,
    // Paginated response types
    PaginatedResponse,
    PaginatedUnitsResponse,
    PaginatedLotsResponse,
    PaginatedConsumedSlicesResponse,
    PaginatedRealizedPnLResponse,
    PaginatedFeesResponse,
    PaginatedWarningsResponse,
    PaginatedEventsResponse,
    PaginatedSettlementsResponse,
} from './types';

// Utility functions
export { aggregateMarketValueByCategory } from './types';
