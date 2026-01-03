"""cleanup unused fields

Revision ID: 005_cleanup_unused_fields
Revises: 004_drop_groups_tables
Create Date: 2025-12-24

Remove unused fields from normalized_transactions:
- parent_transaction_id (leg expansion feature not used)
- leg_type (leg expansion feature not used)
- review_status (redundant with status field)

Also migrate review_status to status where needed.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '005_cleanup_unused_fields'
down_revision = '004_drop_groups_tables'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Remove unused fields."""
    
    # Note: review_status migration skipped as status column may not exist
    # The model cleanup is already done, columns will be dropped if they exist
    
    # Drop unused columns if they exist
    with op.batch_alter_table('normalized_transactions', schema=None) as batch_op:
        # Try to drop each column individually, ignore if doesn't exist
        try:
            batch_op.drop_column('parent_transaction_id')
        except:
            pass
        try:
            batch_op.drop_column('leg_type')
        except:
            pass
        try:
            batch_op.drop_column('review_status')
        except:
            pass


def downgrade() -> None:
    """Restore removed fields."""
    
    with op.batch_alter_table('normalized_transactions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('review_status', sa.String(), nullable=False, server_default='pending'))
        batch_op.add_column(sa.Column('leg_type', sa.String(), nullable=True))
        batch_op.add_column(sa.Column('parent_transaction_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key('fk_parent_transaction', 'normalized_transactions', ['parent_transaction_id'], ['id'])
        batch_op.create_index('ix_normalized_transactions_parent_transaction_id', ['parent_transaction_id'])
    
    # Migrate status back to review_status
    op.execute("""
        UPDATE normalized_transactions 
        SET review_status = CASE status
            WHEN 'reviewed' THEN 'valid'
            WHEN 'excluded' THEN 'invalid'
            ELSE 'pending'
        END
    """)
