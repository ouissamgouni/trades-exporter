-- Migration: Add P&L Draft Version System
-- This migration adds support for draft calculation versions that auto-expire,
-- processed units tracking, and warning persistence.

-- ============================================================================
-- 1. Add columns to calculation_versions
-- ============================================================================

-- Add expires_at for draft auto-expiry
ALTER TABLE calculation_versions 
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

-- Add units_processed count
ALTER TABLE calculation_versions 
    ADD COLUMN IF NOT EXISTS units_processed INTEGER DEFAULT 0;

-- Add lots_created count
ALTER TABLE calculation_versions 
    ADD COLUMN IF NOT EXISTS lots_created INTEGER DEFAULT 0;

-- Add lots_consumed count
ALTER TABLE calculation_versions 
    ADD COLUMN IF NOT EXISTS lots_consumed INTEGER DEFAULT 0;

-- Add warning_count
ALTER TABLE calculation_versions 
    ADD COLUMN IF NOT EXISTS warning_count INTEGER DEFAULT 0;

-- Add lot_mode
ALTER TABLE calculation_versions 
    ADD COLUMN IF NOT EXISTS lot_mode VARCHAR(50) DEFAULT 'LOT_TRAVEL';

-- Add base_currency_id
ALTER TABLE calculation_versions 
    ADD COLUMN IF NOT EXISTS base_currency_id INTEGER REFERENCES assets(asset_id);

-- Index for efficient draft cleanup
CREATE INDEX IF NOT EXISTS idx_calculation_versions_expires_at 
    ON calculation_versions(expires_at) 
    WHERE expires_at IS NOT NULL;

-- ============================================================================
-- 2. Add is_negative column to cost_lots
-- ============================================================================

ALTER TABLE cost_lots 
    ADD COLUMN IF NOT EXISTS is_negative BOOLEAN DEFAULT FALSE;

-- ============================================================================
-- 3. Create processed_units table
-- ============================================================================

CREATE TABLE IF NOT EXISTS processed_units (
    id SERIAL PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES calculation_versions(version_id),
    calculation_unit_id INTEGER,  -- No FK - table may not exist, stores bundle_id if applicable
    unit_type VARCHAR(50) DEFAULT 'swap',
    pattern VARCHAR(100),
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    
    -- Transaction references (JSON array)
    transaction_ids JSONB,
    origin_transaction_id INTEGER REFERENCES normalized_transactions(id),
    
    -- Assets involved (JSON arrays)
    outflow_asset_ids JSONB,
    inflow_asset_ids JSONB,
    fee_asset_ids JSONB,
    
    -- Lot references (JSON arrays of UUIDs as strings)
    lots_created_uuids JSONB,
    lots_consumed_uuids JSONB,
    
    -- P&L impact
    realized_pnl_in_base NUMERIC(36, 18),
    is_taxable BOOLEAN DEFAULT FALSE,
    
    -- Counts
    member_count INTEGER DEFAULT 0,
    lots_created_count INTEGER DEFAULT 0,
    lots_consumed_count INTEGER DEFAULT 0,
    realized_entry_count INTEGER DEFAULT 0
);

-- Indexes for processed_units
CREATE INDEX IF NOT EXISTS idx_processed_units_version_id 
    ON processed_units(version_id);

CREATE INDEX IF NOT EXISTS idx_processed_units_calculation_unit_id 
    ON processed_units(calculation_unit_id);

CREATE INDEX IF NOT EXISTS idx_processed_units_timestamp 
    ON processed_units(timestamp);

-- ============================================================================
-- 4. Create pnl_warnings table
-- ============================================================================

CREATE TABLE IF NOT EXISTS pnl_warnings (
    id SERIAL PRIMARY KEY,
    version_id INTEGER NOT NULL REFERENCES calculation_versions(version_id),
    warning_type VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    transaction_id INTEGER REFERENCES normalized_transactions(id),
    unit_id INTEGER,
    asset_id INTEGER REFERENCES assets(asset_id),
    details JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for pnl_warnings
CREATE INDEX IF NOT EXISTS idx_pnl_warnings_version_id 
    ON pnl_warnings(version_id);

CREATE INDEX IF NOT EXISTS idx_pnl_warnings_warning_type 
    ON pnl_warnings(warning_type);

CREATE INDEX IF NOT EXISTS idx_pnl_warnings_transaction_id 
    ON pnl_warnings(transaction_id);

-- ============================================================================
-- 5. Update existing draft versions
-- ============================================================================

-- Set status to 'draft' for any versions that don't have a status
UPDATE calculation_versions 
SET status = 'draft' 
WHERE status IS NULL OR status = '';

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON COLUMN calculation_versions.expires_at IS 
    'Auto-expiry timestamp for draft versions. NULL for committed versions.';

COMMENT ON TABLE processed_units IS 
    'Audit trail of processed calculation units for P&L versions.';

COMMENT ON TABLE pnl_warnings IS 
    'Warnings generated during P&L calculation.';
