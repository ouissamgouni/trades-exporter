"""Add dimension_label to categories table.

Revision ID: 012_add_dimension_label
Revises: 011_add_categories_and_price_type
Create Date: 2024-12-24

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '012_add_dimension_label'
down_revision: Union[str, None] = '011_add_categories_and_price_type'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Default dimension labels
DIMENSION_LABELS = {
    'asset_class': 'Asset Class',
    'sector': 'Sector',
    'region': 'Region',
    'currency_peg': 'Currency Peg',
}


def upgrade() -> None:
    """Add dimension_label column and populate with defaults."""
    # Add column
    op.add_column('categories', sa.Column('dimension_label', sa.String(), nullable=True))
    
    # Populate existing rows with default labels
    for dimension, label in DIMENSION_LABELS.items():
        op.execute(f"""
            UPDATE categories 
            SET dimension_label = '{label}' 
            WHERE dimension = '{dimension}' AND dimension_label IS NULL
        """)
    
    # Set dimension_label = title case of dimension for any remaining rows
    op.execute("""
        UPDATE categories 
        SET dimension_label = INITCAP(REPLACE(dimension, '_', ' '))
        WHERE dimension_label IS NULL
    """)


def downgrade() -> None:
    """Remove dimension_label column."""
    op.drop_column('categories', 'dimension_label')
