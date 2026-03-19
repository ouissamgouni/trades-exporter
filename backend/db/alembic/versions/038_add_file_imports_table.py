"""add_file_imports_table

Revision ID: 038_add_file_imports
Revises: 037_fix_legtype_lowercase
Create Date: 2026-01-16

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '038_add_file_imports'
down_revision: Union[str, Sequence[str], None] = '037_fix_legtype_lowercase'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create file_imports table for tracking file upload lifecycle."""
    # Check if table already exists (idempotent migration)
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if 'file_imports' in inspector.get_table_names():
        return
    
    op.create_table(
        'file_imports',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('connector_id', sa.Integer(), sa.ForeignKey('account_connectors.id'), nullable=False, index=True),
        
        # File info
        sa.Column('filename', sa.String(), nullable=False),
        sa.Column('original_filename', sa.String(), nullable=False),
        sa.Column('file_path', sa.String(), nullable=False),
        sa.Column('file_size', sa.Integer(), default=0),
        
        # Status tracking
        sa.Column('status', sa.String(), default='pending', index=True),
        
        # Timestamps
        sa.Column('uploaded_at', sa.DateTime(), default=sa.func.now(), index=True),
        sa.Column('processed_at', sa.DateTime(), nullable=True),
        
        # Metrics
        sa.Column('row_count', sa.Integer(), default=0),
        sa.Column('new_count', sa.Integer(), default=0),
        sa.Column('updated_count', sa.Integer(), default=0),
        sa.Column('skipped_count', sa.Integer(), default=0),
        
        # Processing info
        sa.Column('sync_job_connector_run_id', sa.Integer(), 
                  sa.ForeignKey('sync_job_connector_runs.id'), nullable=True, index=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        
        # Retention
        sa.Column('retention_expires_at', sa.DateTime(), nullable=True, index=True),
        
        # Audit
        sa.Column('created_at', sa.DateTime(), default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), default=sa.func.now()),
    )


def downgrade() -> None:
    """Drop file_imports table."""
    op.drop_table('file_imports')
