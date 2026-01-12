"""Add sync job tracking tables

Revision ID: add_sync_job_tracking
Revises: cleanup_normalized_transactions
Create Date: 2026-01-08

Changes:
- Add sync_jobs table for job history tracking
- Add sync_job_connector_runs table for per-connector run tracking
- Add sync_connector_run_id FK to normalized_transactions for linking
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers
revision = '033_add_sync_job_tracking'
down_revision = '032_add_account_enabled'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create sync_jobs table
    op.create_table(
        'sync_jobs',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('status', sa.String(), nullable=False, server_default='running'),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('total_connectors', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_processed', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_new', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_updated', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_skipped', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_errors', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('config_snapshot', sa.JSON(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_sync_jobs_status', 'sync_jobs', ['status'])
    op.create_index('ix_sync_jobs_started_at', 'sync_jobs', ['started_at'])

    # Create sync_job_connector_runs table
    op.create_table(
        'sync_job_connector_runs',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('job_id', sa.Integer(), nullable=False),
        sa.Column('connector_id', sa.Integer(), nullable=False),
        sa.Column('connector_type', sa.String(), nullable=False, server_default=''),
        sa.Column('account_name', sa.String(), nullable=False, server_default=''),
        sa.Column('status', sa.String(), nullable=False, server_default='queued'),
        sa.Column('test_mode', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('processed', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('synced_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('updated_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('skipped_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('error_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('synced_ids', sa.JSON(), nullable=True),
        sa.Column('updated_ids', sa.JSON(), nullable=True),
        sa.Column('skipped_ids', sa.JSON(), nullable=True),
        sa.Column('error_details', sa.JSON(), nullable=True),
        sa.Column('logs', sa.JSON(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['job_id'], ['sync_jobs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['connector_id'], ['account_connectors.id'], ondelete='CASCADE'),
    )
    op.create_index('ix_sync_job_connector_runs_job_id', 'sync_job_connector_runs', ['job_id'])
    op.create_index('ix_sync_job_connector_runs_connector_id', 'sync_job_connector_runs', ['connector_id'])
    op.create_index('ix_sync_job_connector_runs_status', 'sync_job_connector_runs', ['status'])

    # Add sync_connector_run_id FK to normalized_transactions
    op.add_column(
        'normalized_transactions',
        sa.Column('sync_connector_run_id', sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        'fk_normalized_transactions_sync_connector_run_id',
        'normalized_transactions',
        'sync_job_connector_runs',
        ['sync_connector_run_id'],
        ['id'],
        ondelete='SET NULL'
    )
    op.create_index(
        'ix_normalized_transactions_sync_connector_run_id',
        'normalized_transactions',
        ['sync_connector_run_id']
    )


def downgrade() -> None:
    # Remove FK and column from normalized_transactions
    op.drop_index('ix_normalized_transactions_sync_connector_run_id', 'normalized_transactions')
    op.drop_constraint('fk_normalized_transactions_sync_connector_run_id', 'normalized_transactions', type_='foreignkey')
    op.drop_column('normalized_transactions', 'sync_connector_run_id')

    # Drop sync_job_connector_runs table
    op.drop_index('ix_sync_job_connector_runs_status', 'sync_job_connector_runs')
    op.drop_index('ix_sync_job_connector_runs_connector_id', 'sync_job_connector_runs')
    op.drop_index('ix_sync_job_connector_runs_job_id', 'sync_job_connector_runs')
    op.drop_table('sync_job_connector_runs')

    # Drop sync_jobs table
    op.drop_index('ix_sync_jobs_started_at', 'sync_jobs')
    op.drop_index('ix_sync_jobs_status', 'sync_jobs')
    op.drop_table('sync_jobs')
