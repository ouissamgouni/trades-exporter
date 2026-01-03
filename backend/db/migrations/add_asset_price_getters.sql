-- Migration: Add asset_price_getters table
-- Description: Allows multiple price getters per asset with priority ordering
-- Date: 2024-12-10
--
-- Run with: psql -d your_database -f add_asset_price_getters.sql
-- Or use Alembic: alembic upgrade head

-- Create the asset_price_getters table
CREATE TABLE IF NOT EXISTS asset_price_getters (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    price_getter VARCHAR(50) NOT NULL,  -- e.g., 'yahoo', 'coingecko'
    priority INTEGER NOT NULL DEFAULT 100,  -- Lower = higher priority
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    params JSONB NOT NULL DEFAULT '{}',
    -- Main param in JSON:
    -- - asset_id: The identifier for this asset in the price getter's API
    --   Examples: "BTC-USD" (Yahoo), "bitcoin" (CoinGecko), "AAPL" (Yahoo)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Each asset can only have one configuration per price_getter
    CONSTRAINT uq_asset_price_getter UNIQUE (asset_id, price_getter)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_asset_price_getters_asset_id ON asset_price_getters(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_price_getters_priority ON asset_price_getters(priority);
CREATE INDEX IF NOT EXISTS idx_asset_price_getters_enabled ON asset_price_getters(enabled);

COMMENT ON TABLE asset_price_getters IS 'Links assets to price getters with configuration and priority ordering';
COMMENT ON COLUMN asset_price_getters.priority IS 'Lower values = higher priority. Price service tries getters in order until price is found';
COMMENT ON COLUMN asset_price_getters.params IS 'JSON config with asset_id field being the identifier in the price getter API';

-- Example inserts:
-- INSERT INTO asset_price_getters (asset_id, price_getter, priority, params) VALUES
-- (1, 'yahoo', 1, '{"asset_id": "BTC-USD"}'),
-- (1, 'coingecko', 2, '{"asset_id": "bitcoin"}');

