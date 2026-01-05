"""Remove parent_id from categories - flatten to orthogonal dimensions

Revision ID: 026_remove_category_parent_id
Revises: 025_cleanup_realized_pnl_columns
Create Date: 2026-01-05

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic
revision = '026_remove_category_parent_id'
down_revision = '025_cleanup_realized_pnl_columns'
branch_labels = None
depends_on = None


def upgrade():
    """
    Remove parent_id from categories table.
    
    Categories are now flat within each dimension.
    Hierarchy is replaced with orthogonal dimensions.
    """
    # Check if parent_id column exists before trying to drop it
    connection = op.get_bind()
    result = connection.execute(sa.text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'categories' AND column_name = 'parent_id'
    """))
    has_parent_id = result.fetchone() is not None
    
    if has_parent_id:
        # Drop the foreign key constraint first (if it exists)
        try:
            op.drop_constraint('categories_parent_id_fkey', 'categories', type_='foreignkey')
        except Exception:
            pass  # Constraint might not exist
        
        # Drop the index on parent_id (if it exists)
        try:
            op.drop_index('ix_categories_parent_id', table_name='categories')
        except Exception:
            pass  # Index might not exist
        
        # Drop the parent_id column
        op.drop_column('categories', 'parent_id')


def downgrade():
    """
    Re-add parent_id column to categories table.
    """
    # Check if parent_id column already exists
    connection = op.get_bind()
    result = connection.execute(sa.text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'categories' AND column_name = 'parent_id'
    """))
    has_parent_id = result.fetchone() is not None
    
    if not has_parent_id:
        op.add_column('categories', sa.Column('parent_id', sa.Integer(), nullable=True))
        op.create_index('ix_categories_parent_id', 'categories', ['parent_id'], unique=False)
        op.create_foreign_key('categories_parent_id_fkey', 'categories', 'categories', ['parent_id'], ['id'])
