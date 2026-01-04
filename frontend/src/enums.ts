/**
 * Shared enums for the Trade Exporter application.
 * These enums mirror the backend Python enums for type safety and consistency.
 * 
 * Convention: All enum values use lowercase to match database storage format.
 */

/**
 * Bundle/Unit pattern types for calculation units.
 */
export enum UnitPattern {
  TRANSFER = 'transfer',
  SWAP = 'swap',
  SPLIT = 'split',
  PENDING_TRANSFER = 'pending_transfer',
  UNKNOWN = 'unknown',
}

/**
 * Transaction type for P&L calculation and leg expansion.
 */
export enum TransactionType {
  TRADE = 'trade',
  TRANSFER = 'transfer',
  TECHNICAL = 'technical',
}

/**
 * Taxability status for transactions.
 */
export enum TaxabilityStatus {
  TAXABLE = 'taxable',
  NON_TAXABLE = 'non_taxable',
  UNKNOWN = 'unknown',
}

/**
 * Transaction direction for flow classification.
 */
export enum Direction {
  INFLOW = 'inflow',
  OUTFLOW = 'outflow',
  NEUTRAL = 'neutral',
}

/**
 * Review status for transaction workflow.
 */
export enum ReviewStatus {
  VALID = 'valid',
  PENDING = 'pending',
  INVALID = 'invalid',
}

/**
 * Account type classification.
 */
export enum AccountType {
  CEX = 'cex',
  BROKER = 'broker',
  WALLET = 'wallet',
}

/**
 * Connector category for data sources.
 */
export enum ConnectorCategory {
  CEX = 'cex',
  ONCHAIN = 'onchain',
  BROKER = 'broker',
}

/**
 * Sync status for account connectors.
 */
export enum SyncStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
}

/**
 * Price/Asset type for determining price getter.
 */
export enum PriceType {
  CRYPTO = 'crypto',
  STOCK = 'stock',
  FIAT = 'fiat',
}

/**
 * Cost method for P&L calculation.
 */
export enum CostMethod {
  FIFO = 'FIFO',
  LIFO = 'LIFO',
  HIFO = 'HIFO',
}

/**
 * Lot mode for P&L calculation.
 */
export enum LotMode {
  LOT_TRAVEL = 'LOT_TRAVEL',
  MEGA_WALLET = 'MEGA_WALLET',
}

/**
 * Lot event types for cost lot lifecycle tracking.
 */
export enum LotEventType {
  CREATED = 'created',
  CONSUMED = 'consumed',
  SETTLED = 'settled',
  TRANSFERRED = 'transferred',
  ADJUSTED = 'adjusted',
}

/**
 * Leg types for expanded transactions (P&L calculation).
 */
export enum LegType {
  COST = 'cost',
  PROCEEDS = 'proceeds',
  ACQUIRED = 'acquired',
  DISPOSED = 'disposed',
  FEE = 'fee',
}

// ============================================================================
// Helper functions for enum display
// ============================================================================

/**
 * Get display label for UnitPattern enum values.
 */
export function getUnitPatternLabel(pattern: UnitPattern | string): string {
  const labels: Record<string, string> = {
    [UnitPattern.TRANSFER]: 'Transfer',
    [UnitPattern.SWAP]: 'Swap',
    [UnitPattern.SPLIT]: 'Split',
    [UnitPattern.PENDING_TRANSFER]: 'Pending Transfer',
    [UnitPattern.UNKNOWN]: 'Unknown',
  };
  return labels[pattern] || pattern;
}

/**
 * Get display label for TransactionType enum values.
 */
export function getTransactionTypeLabel(type: TransactionType | string): string {
  const labels: Record<string, string> = {
    [TransactionType.TRADE]: 'Trade',
    [TransactionType.TRANSFER]: 'Transfer',
    [TransactionType.TECHNICAL]: 'Technical',
  };
  return labels[type] || type;
}

/**
 * Get display label for TaxabilityStatus enum values.
 */
export function getTaxabilityLabel(status: TaxabilityStatus | string): string {
  const labels: Record<string, string> = {
    [TaxabilityStatus.TAXABLE]: 'Taxable',
    [TaxabilityStatus.NON_TAXABLE]: 'Non-Taxable',
    [TaxabilityStatus.UNKNOWN]: 'Unknown',
  };
  return labels[status] || status;
}

/**
 * Get display label for Direction enum values.
 */
export function getDirectionLabel(direction: Direction | string): string {
  const labels: Record<string, string> = {
    [Direction.INFLOW]: 'Inflow',
    [Direction.OUTFLOW]: 'Outflow',
    [Direction.NEUTRAL]: 'Neutral',
  };
  return labels[direction] || direction;
}

/**
 * Get display label for ReviewStatus enum values.
 */
export function getReviewStatusLabel(status: ReviewStatus | string): string {
  const labels: Record<string, string> = {
    [ReviewStatus.VALID]: 'Valid',
    [ReviewStatus.PENDING]: 'Pending',
    [ReviewStatus.INVALID]: 'Invalid',
  };
  return labels[status] || status;
}

/**
 * Get display label for AccountType enum values.
 */
export function getAccountTypeLabel(type: AccountType | string): string {
  const labels: Record<string, string> = {
    [AccountType.CEX]: 'Centralized Exchange',
    [AccountType.BROKER]: 'Broker',
    [AccountType.WALLET]: 'Wallet',
  };
  return labels[type] || type;
}

/**
 * Get display label for ConnectorCategory enum values.
 */
export function getConnectorCategoryLabel(category: ConnectorCategory | string): string {
  const labels: Record<string, string> = {
    [ConnectorCategory.CEX]: 'CEX',
    [ConnectorCategory.ONCHAIN]: 'On-Chain',
    [ConnectorCategory.BROKER]: 'Broker',
  };
  return labels[category] || category;
}

/**
 * Get display label for SyncStatus enum values.
 */
export function getSyncStatusLabel(status: SyncStatus | string): string {
  const labels: Record<string, string> = {
    [SyncStatus.PENDING]: 'Pending',
    [SyncStatus.RUNNING]: 'Running',
    [SyncStatus.SUCCESS]: 'Success',
    [SyncStatus.FAILED]: 'Failed',
  };
  return labels[status] || status;
}
