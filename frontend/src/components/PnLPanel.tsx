/**
 * P&L Panel - Re-exports the new modular P&L panel
 * 
 * The P&L module has been redesigned following these principles:
 * - Principle 1: Results first, details on demand
 * - Principle 2: Groups are primary, legs are secondary
 * - Principle 3: Everything must be traceable
 * 
 * @see ./pnl/PnLPanelV2.tsx for the main implementation
 */

// Re-export the P&L panel as default
export { PnLPanel, default } from './pnl';

// Also export all sub-components for flexibility
export {
    CalculationContext,
    SummaryCards,
    SummaryBar,
    AssetPnLTable,
    PnLDetailPanel,
    PnLImpactPanel,
    FeesPanel,
    WarningsPanel,
} from './pnl';
