"""add active sync job guard

Revision ID: 065_active_sync_job_guard
Revises: 064_normalize_cost_txs
Create Date: 2026-06-04

"""

from alembic import op


revision = "065_active_sync_job_guard"
down_revision = "064_normalize_cost_txs"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_jobs_one_active
        ON sync_jobs ((true))
        WHERE status IN ('pending', 'running')
    """)


def downgrade():
    op.execute("DROP INDEX IF EXISTS uq_sync_jobs_one_active")
