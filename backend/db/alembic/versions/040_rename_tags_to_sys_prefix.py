"""rename tags to sys prefix

Revision ID: 040_rename_tags_to_sys_prefix
Revises: c25306085d6e
Create Date: 2026-01-30 12:00:00

Renames duplicate detection tags from dup_* to sys_* prefix.
Also prepares for transfer dismissal tags with sys_ prefix.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '040_rename_tags_to_sys_prefix'
down_revision: Union[str, Sequence[str], None] = '4b74174f7a1f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Rename dup_* tags to sys_* in normalized_transactions.tags JSONB."""
    
    # First, convert JSON to JSONB if not already
    op.execute("""
        ALTER TABLE normalized_transactions 
        ALTER COLUMN tags TYPE jsonb USING tags::jsonb
    """)
    
    # Use jsonb_agg to rebuild tags array with renamed keys
    # This handles all duplicate resolution tags:
    # - dup_resolution -> sys_resolution
    # - dup_group -> sys_group
    # - dup_resolved_at -> sys_resolved_at
    # - dup_kept_ids -> sys_kept_ids
    op.execute("""
        UPDATE normalized_transactions
        SET tags = (
            SELECT jsonb_agg(
                CASE 
                    WHEN elem ? 'dup_resolution' THEN jsonb_build_object('sys_resolution', elem->>'dup_resolution')
                    WHEN elem ? 'dup_group' THEN jsonb_build_object('sys_group', elem->>'dup_group')
                    WHEN elem ? 'dup_resolved_at' THEN jsonb_build_object('sys_resolved_at', elem->>'dup_resolved_at')
                    WHEN elem ? 'dup_kept_ids' THEN jsonb_build_object('sys_kept_ids', elem->>'dup_kept_ids')
                    ELSE elem
                END
            )
            FROM jsonb_array_elements(tags) AS elem
        )
        WHERE tags IS NOT NULL 
        AND tags::text LIKE '%dup_%'
    """)


def downgrade() -> None:
    """Revert sys_* tags back to dup_*."""
    
    op.execute("""
        UPDATE normalized_transactions
        SET tags = (
            SELECT jsonb_agg(
                CASE 
                    WHEN elem ? 'sys_resolution' THEN jsonb_build_object('dup_resolution', elem->>'sys_resolution')
                    WHEN elem ? 'sys_group' THEN jsonb_build_object('dup_group', elem->>'sys_group')
                    WHEN elem ? 'sys_resolved_at' THEN jsonb_build_object('dup_resolved_at', elem->>'sys_resolved_at')
                    WHEN elem ? 'sys_kept_ids' THEN jsonb_build_object('dup_kept_ids', elem->>'sys_kept_ids')
                    ELSE elem
                END
            )
            FROM jsonb_array_elements(tags) AS elem
        )
        WHERE tags IS NOT NULL 
        AND tags::text LIKE '%sys_%'
    """)
    
    # Revert JSONB back to JSON
    op.execute("""
        ALTER TABLE normalized_transactions 
        ALTER COLUMN tags TYPE json USING tags::json
    """)
