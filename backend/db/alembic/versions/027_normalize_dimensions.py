"""Normalize dimensions to separate table

This migration:
1. Creates the 'dimensions' table
2. Migrates existing dimension strings from categories to dimensions table
3. Adds dimension_id FK to categories
4. Removes dimension, dimension_label, and key columns from categories
5. Updates unique constraint from (dimension, key) to (dimension_id, label)

Revision ID: 027_normalize_dimensions
Revises: 026_remove_category_parent_id
Create Date: 2026-01-05
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '027_normalize_dimensions'
down_revision = '026_remove_category_parent_id'
branch_labels = None
depends_on = None


def _column_exists(connection, table, column):
    """Check if a column exists in a table."""
    result = connection.execute(sa.text("""
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = :table AND column_name = :column
    """), {"table": table, "column": column})
    return result.fetchone() is not None


def _table_exists(connection, table):
    """Check if a table exists."""
    result = connection.execute(sa.text("""
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = :table
    """), {"table": table})
    return result.fetchone() is not None


def _constraint_exists(connection, constraint_name):
    """Check if a constraint exists."""
    result = connection.execute(sa.text("""
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = :name
    """), {"name": constraint_name})
    return result.fetchone() is not None


def _index_exists(connection, index_name):
    """Check if an index exists."""
    result = connection.execute(sa.text("""
        SELECT 1 FROM pg_indexes WHERE indexname = :name
    """), {"name": index_name})
    return result.fetchone() is not None


def upgrade():
    connection = op.get_bind()
    
    # 1. Create dimensions table (if not exists)
    if not _table_exists(connection, 'dimensions'):
        op.create_table(
            'dimensions',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('label', sa.String(), nullable=False),
            sa.Column('ordinal', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('label', name='uq_dimension_label')
        )
    
    if not _index_exists(connection, 'ix_dimensions_label'):
        op.create_index('ix_dimensions_label', 'dimensions', ['label'])
    
    # 2. Migrate existing dimensions from categories (if old columns exist)
    has_old_dimension_col = _column_exists(connection, 'categories', 'dimension')
    has_dimension_id_col = _column_exists(connection, 'categories', 'dimension_id')
    
    dimension_mapping = {}
    if has_old_dimension_col:
        # Get all unique dimension/dimension_label pairs from categories
        result = connection.execute(sa.text("""
            SELECT DISTINCT dimension, dimension_label 
            FROM categories 
            WHERE dimension IS NOT NULL
            ORDER BY dimension
        """))
        dimensions = result.fetchall()
        
        # Insert dimensions and build mapping (skip if already exists)
        for ordinal, (dim_key, dim_label) in enumerate(dimensions):
            label = dim_label if dim_label else dim_key.replace('_', ' ').title()
            
            # Check if dimension already exists
            existing = connection.execute(sa.text(
                "SELECT id FROM dimensions WHERE label = :label"
            ), {"label": label}).fetchone()
            
            if existing:
                dimension_mapping[dim_key] = existing[0]
            else:
                insert_result = connection.execute(sa.text("""
                    INSERT INTO dimensions (label, ordinal, created_at) 
                    VALUES (:label, :ordinal, NOW())
                    RETURNING id
                """), {"label": label, "ordinal": ordinal})
                dimension_mapping[dim_key] = insert_result.fetchone()[0]
    
    # 3. Add dimension_id column to categories (if not exists)
    if not has_dimension_id_col:
        op.add_column('categories', sa.Column('dimension_id', sa.Integer(), nullable=True))
    
    # 4. Populate dimension_id based on dimension string (if old column exists)
    if has_old_dimension_col and dimension_mapping:
        for dim_key, dim_id in dimension_mapping.items():
            connection.execute(sa.text("""
                UPDATE categories 
                SET dimension_id = :dim_id 
                WHERE dimension = :dim_key AND dimension_id IS NULL
            """), {"dim_id": dim_id, "dim_key": dim_key})
    
    # 5. Make dimension_id NOT NULL (check current state first)
    if _column_exists(connection, 'categories', 'dimension_id'):
        # Check if there are any NULL values
        null_count = connection.execute(sa.text(
            "SELECT COUNT(*) FROM categories WHERE dimension_id IS NULL"
        )).fetchone()[0]
        if null_count == 0:
            try:
                op.alter_column('categories', 'dimension_id', nullable=False)
            except Exception:
                pass  # Already NOT NULL
    
    # 6. Add foreign key constraint (if not exists)
    if not _constraint_exists(connection, 'fk_categories_dimension_id'):
        op.create_foreign_key(
            'fk_categories_dimension_id',
            'categories', 'dimensions',
            ['dimension_id'], ['id']
        )
    
    if not _index_exists(connection, 'ix_categories_dimension_id'):
        op.create_index('ix_categories_dimension_id', 'categories', ['dimension_id'])
    
    # 7. Drop old unique constraint (if exists)
    if _constraint_exists(connection, 'uq_category_dimension_key'):
        op.drop_constraint('uq_category_dimension_key', 'categories', type_='unique')
    
    # 8. Create new unique constraint on (dimension_id, label) (if not exists)
    if not _constraint_exists(connection, 'uq_category_dimension_label'):
        op.create_unique_constraint('uq_category_dimension_label', 'categories', ['dimension_id', 'label'])
    
    # 9. Drop old columns (if they exist)
    if _index_exists(connection, 'ix_categories_dimension'):
        op.drop_index('ix_categories_dimension', 'categories')
    if _index_exists(connection, 'ix_categories_key'):
        op.drop_index('ix_categories_key', 'categories')
    if _column_exists(connection, 'categories', 'dimension'):
        op.drop_column('categories', 'dimension')
    if _column_exists(connection, 'categories', 'dimension_label'):
        op.drop_column('categories', 'dimension_label')
    if _column_exists(connection, 'categories', 'key'):
        op.drop_column('categories', 'key')


def downgrade():
    connection = op.get_bind()
    
    # 1. Add back old columns (if not exist)
    if not _column_exists(connection, 'categories', 'dimension'):
        op.add_column('categories', sa.Column('dimension', sa.String(), nullable=True))
    if not _column_exists(connection, 'categories', 'dimension_label'):
        op.add_column('categories', sa.Column('dimension_label', sa.String(), nullable=True))
    if not _column_exists(connection, 'categories', 'key'):
        op.add_column('categories', sa.Column('key', sa.String(), nullable=True))
    
    # 2. Populate from dimensions table (if dimension_id exists)
    if _column_exists(connection, 'categories', 'dimension_id') and _table_exists(connection, 'dimensions'):
        result = connection.execute(sa.text("SELECT id, label FROM dimensions"))
        dimensions = result.fetchall()
        
        for dim_id, dim_label in dimensions:
            dim_key = dim_label.lower().replace(' ', '_')
            connection.execute(sa.text("""
                UPDATE categories 
                SET dimension = :dim_key, dimension_label = :dim_label
                WHERE dimension_id = :dim_id AND dimension IS NULL
            """), {"dim_key": dim_key, "dim_label": dim_label, "dim_id": dim_id})
        
        # Generate key for each category from its label
        connection.execute(sa.text("""
            UPDATE categories 
            SET key = LOWER(REPLACE(REPLACE(label, ' ', '_'), '/', '_'))
            WHERE key IS NULL
        """))
    
    # 3. Make columns NOT NULL (if they have values)
    try:
        op.alter_column('categories', 'dimension', nullable=False)
        op.alter_column('categories', 'key', nullable=False)
    except Exception:
        pass
    
    # 4. Create indexes (if not exist)
    if not _index_exists(connection, 'ix_categories_dimension'):
        op.create_index('ix_categories_dimension', 'categories', ['dimension'])
    if not _index_exists(connection, 'ix_categories_key'):
        op.create_index('ix_categories_key', 'categories', ['key'])
    
    # 5. Drop new constraint and add old one
    if _constraint_exists(connection, 'uq_category_dimension_label'):
        op.drop_constraint('uq_category_dimension_label', 'categories', type_='unique')
    if not _constraint_exists(connection, 'uq_category_dimension_key'):
        op.create_unique_constraint('uq_category_dimension_key', 'categories', ['dimension', 'key'])
    
    # 6. Drop FK and dimension_id
    if _constraint_exists(connection, 'fk_categories_dimension_id'):
        op.drop_constraint('fk_categories_dimension_id', 'categories', type_='foreignkey')
    if _index_exists(connection, 'ix_categories_dimension_id'):
        op.drop_index('ix_categories_dimension_id', 'categories')
    if _column_exists(connection, 'categories', 'dimension_id'):
        op.drop_column('categories', 'dimension_id')
    
    # 7. Drop dimensions table
    if _index_exists(connection, 'ix_dimensions_label'):
        op.drop_index('ix_dimensions_label', 'dimensions')
    if _table_exists(connection, 'dimensions'):
        op.drop_table('dimensions')
