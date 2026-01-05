"""Add external_id column to asset_price_getters.

This migration:
1. Adds external_id column to asset_price_getters table
2. Migrates existing params.asset_id values to the new external_id column
3. Removes asset_id key from params JSON

The external_id is the identifier used by external price APIs:
- Yahoo: "BTC-USD", "AAPL", "EURUSD=X"
- CoinGecko: "bitcoin", "ethereum", "solana"
- DataReader: "AAPL", "SPY"

This separates the primary external identifier from extra parameters,
making the schema clearer and avoiding naming collision with the
asset_id foreign key column.

Revision ID: add_external_id
Revises: drop_uuid_columns
Create Date: 2026-01-04
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
import json


# revision identifiers
revision = 'add_external_id'
down_revision = 'drop_uuid_columns'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add external_id column and migrate data from params.asset_id."""
    # Add external_id column
    op.add_column(
        'asset_price_getters',
        sa.Column('external_id', sa.String(length=100), nullable=True)
    )
    
    # Migrate existing params.asset_id to external_id column
    # and remove asset_id from params JSON
    connection = op.get_bind()
    
    # Get all rows with params containing asset_id
    result = connection.execute(
        sa.text("""
            SELECT id, params 
            FROM asset_price_getters 
            WHERE params->>'asset_id' IS NOT NULL
        """)
    )
    
    for row in result:
        row_id = row[0]
        params = row[1] if row[1] else {}
        
        if isinstance(params, dict) and 'asset_id' in params:
            external_id = params.pop('asset_id')
            
            # Update the row: set external_id and remove asset_id from params
            # Use CAST() instead of :: to avoid conflict with SQLAlchemy named params
            connection.execute(
                sa.text("""
                    UPDATE asset_price_getters 
                    SET external_id = :external_id, 
                        params = CAST(:params AS jsonb)
                    WHERE id = :id
                """),
                {'id': row_id, 'external_id': external_id, 'params': json.dumps(params)}
            )


def downgrade() -> None:
    """Move external_id back to params.asset_id and drop column."""
    connection = op.get_bind()
    
    # Move external_id values back to params.asset_id
    result = connection.execute(
        sa.text("""
            SELECT id, external_id, params 
            FROM asset_price_getters 
            WHERE external_id IS NOT NULL
        """)
    )
    
    for row in result:
        row_id = row[0]
        external_id = row[1]
        params = row[2] if row[2] else {}
        
        if external_id:
            params['asset_id'] = external_id
            connection.execute(
                sa.text("""
                    UPDATE asset_price_getters 
                    SET params = CAST(:params AS jsonb)
                    WHERE id = :id
                """),
                {'id': row_id, 'params': json.dumps(params)}
            )
    
    # Drop external_id column
    op.drop_column('asset_price_getters', 'external_id')
