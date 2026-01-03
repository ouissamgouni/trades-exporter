"""Add categories table and rename asset_type to price_type.

Revision ID: 011_add_categories_and_price_type
Revises: 010_add_app_settings
Create Date: 2024-12-24

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '011_add_categories_and_price_type'
down_revision: Union[str, None] = '010_add_app_settings'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    1. Create categories table
    2. Create asset_categories junction table
    3. Rename asset_type to price_type on assets table
    4. Migrate existing asset_type values to price_type (simplified)
    5. Seed default categories
    """
    # 1. Create categories table
    op.create_table(
        'categories',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('dimension', sa.String(), nullable=False),
        sa.Column('key', sa.String(), nullable=False),
        sa.Column('label', sa.String(), nullable=False),
        sa.Column('parent_id', sa.Integer(), nullable=True),
        sa.Column('color', sa.String(), nullable=True),
        sa.Column('ordinal', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['parent_id'], ['categories.id'], name='fk_category_parent'),
        sa.UniqueConstraint('dimension', 'key', name='uq_category_dimension_key')
    )
    op.create_index('ix_categories_dimension', 'categories', ['dimension'])
    op.create_index('ix_categories_key', 'categories', ['key'])
    op.create_index('ix_categories_parent_id', 'categories', ['parent_id'])

    # 2. Create asset_categories junction table
    op.create_table(
        'asset_categories',
        sa.Column('asset_id', sa.Integer(), nullable=False),
        sa.Column('category_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('asset_id', 'category_id'),
        sa.ForeignKeyConstraint(['asset_id'], ['assets.asset_id'], name='fk_asset_category_asset'),
        sa.ForeignKeyConstraint(['category_id'], ['categories.id'], name='fk_asset_category_category'),
        sa.UniqueConstraint('asset_id', 'category_id', name='uq_asset_category')
    )

    # 3. Rename asset_type to price_type (if column exists)
    # First check if asset_type exists and rename, or just add price_type
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [c['name'] for c in inspector.get_columns('assets')]
    
    if 'asset_type' in columns and 'price_type' not in columns:
        # Rename existing column
        op.alter_column('assets', 'asset_type', new_column_name='price_type')
        
        # 4. Migrate old values to simplified 3-value system
        # Map: token/stablecoin/nft -> crypto, etf/index/commodity -> stock
        op.execute("""
            UPDATE assets SET price_type = 'crypto' 
            WHERE price_type IN ('token', 'stablecoin', 'nft', 'other')
        """)
        op.execute("""
            UPDATE assets SET price_type = 'stock' 
            WHERE price_type IN ('etf', 'index', 'commodity')
        """)
    elif 'price_type' not in columns:
        # Just add the new column
        op.add_column('assets', sa.Column('price_type', sa.String(), nullable=True))
    
    # Add index on price_type if not exists
    op.create_index('ix_assets_price_type', 'assets', ['price_type'], if_not_exists=True)

    # 5. Seed default categories
    op.execute("""
        INSERT INTO categories (dimension, key, label, ordinal) VALUES
        -- Asset Class dimension
        ('asset_class', 'cryptocurrency', 'Cryptocurrency', 1),
        ('asset_class', 'token', 'Token', 2),
        ('asset_class', 'stablecoin', 'Stablecoin', 3),
        ('asset_class', 'nft', 'NFT', 4),
        ('asset_class', 'securities', 'Securities', 5),
        ('asset_class', 'etf', 'ETF', 6),
        ('asset_class', 'commodity', 'Commodity', 7),
        ('asset_class', 'fiat', 'Fiat Currency', 8),
        -- Sector dimension
        ('sector', 'defi', 'DeFi', 1),
        ('sector', 'layer1', 'Layer 1', 2),
        ('sector', 'layer2', 'Layer 2', 3),
        ('sector', 'gaming', 'Gaming', 4),
        ('sector', 'tech', 'Technology', 5),
        ('sector', 'finance', 'Finance', 6),
        -- Currency Peg dimension
        ('currency_peg', 'usd', 'USD Pegged', 1),
        ('currency_peg', 'eur', 'EUR Pegged', 2),
        -- Region dimension
        ('region', 'us', 'United States', 1),
        ('region', 'eu', 'Europe', 2),
        ('region', 'asia', 'Asia', 3),
        ('region', 'global', 'Global', 4)
        ON CONFLICT (dimension, key) DO NOTHING
    """)


def downgrade() -> None:
    """Reverse the migration."""
    # Drop junction table first (FK dependency)
    op.drop_table('asset_categories')
    
    # Drop categories table
    op.drop_index('ix_categories_parent_id', table_name='categories')
    op.drop_index('ix_categories_key', table_name='categories')
    op.drop_index('ix_categories_dimension', table_name='categories')
    op.drop_table('categories')
    
    # Rename price_type back to asset_type
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    columns = [c['name'] for c in inspector.get_columns('assets')]
    
    if 'price_type' in columns:
        op.drop_index('ix_assets_price_type', table_name='assets', if_exists=True)
        op.alter_column('assets', 'price_type', new_column_name='asset_type')
