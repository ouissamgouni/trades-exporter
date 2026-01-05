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
export { DataExplorerPanel, DataExplorerContent, PnLAuditView, UnitsTab, CostLotEventsTab } from './DataExplorerPanel';
export { SlidePanel } from './SlidePanel';
export { CategoryFilterBar } from './CategoryFilterBar';
export { MarketValuePieChart } from './MarketValuePieChart';

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
} from './types';

// Utility functions
export { aggregateMarketValueByCategory } from './types';
